import { Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";

import { SESSION_COOKIE, type SessionClaims } from "../auth/auth.constants";
import { DomainEventsService } from "../common/domain-events.service";
import { AppConfigService } from "../config/app-config.service";
import { DashboardService } from "../dashboard/dashboard.service";
import { DEFAULT_CONCERNS, isSubscribable, roomFor } from "./rooms";

/**
 * The live half of the Control Tower.
 *
 * A translator and nothing else. It computes no figure, decides no state and
 * writes no row: it subscribes to the domain bus, picks the rooms an event
 * belongs in, and forwards the payload the publisher already built. Everything
 * it emits has an HTTP endpoint that returns the same shape, which is what lets
 * a page render correctly with the socket disconnected and simply stop moving —
 * the failure mode of a realtime layer should be staleness, never a blank
 * screen (D-105).
 *
 * There is one exception, and it is marked: `kpi.updated` arrives as a nudge
 * with no numbers, because the numbers are an aggregate over the whole case
 * table and no publisher should run six aggregate queries inside the
 * transaction it is committing. The gateway coalesces the nudges and computes
 * once (D-102).
 */
@WebSocketGateway({
  // Same origin policy as the REST API, and credentials on for the same reason:
  // the session is an httpOnly cookie, and a wildcard origin is invalid when
  // credentials travel.
  cors: { origin: true, credentials: true },
  // The handshake carries a cookie, so long-polling has to be allowed as the
  // upgrade path rather than forcing websocket-only.
  transports: ["websocket", "polling"],
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  /** Pending KPI recomputations, one per merchant at most. */
  private readonly kpiTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    private readonly domain: DomainEventsService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly dashboard: DashboardService,
  ) {}

  onModuleInit(): void {
    this.unsubscribes.push(
      this.domain.on("activity.new", (event) =>
        this.to(event.merchantId, "dashboard", "activity.new", event.entry),
      ),

      this.domain.on("case.updated", (event) =>
        // Both rooms in one emit, not two. The pipeline's stage pills are on the
        // dashboard and an open Case Detail page is watching its own case — and
        // a browser showing that case is in both rooms at once, so two calls
        // deliver two copies of one event to it (B-43). Chained `.to()` unions
        // the rooms and Socket.IO delivers once per socket.
        this.toRooms(event.merchantId, ["dashboard", `case:${event.caseId}`], "case.updated", {
          caseId: event.caseId,
          stage: event.stage,
          kind: event.kind,
          recoveredPaise: event.recoveredPaise,
          attempts: event.attempts,
        }),
      ),

      this.domain.on("kpi.updated", (event) => this.scheduleKpis(event.merchantId)),

      this.domain.on("approval.pending", (event) =>
        this.to(event.merchantId, "approvals", "approval.pending", {
          id: event.approvalId,
          caseId: event.caseId,
          gate: event.gate,
          pending: event.pending,
        }),
      ),

      this.domain.on("approval.decided", (event) =>
        this.to(event.merchantId, "approvals", "approval.decided", {
          id: event.approvalId,
          caseId: event.caseId,
          decision: event.decision,
          pending: event.pending,
        }),
      ),

      this.domain.on("policy.changed", (event) =>
        this.to(event.merchantId, "dashboard", "policy.changed", { version: event.version }),
      ),

      this.domain.on("sim.progress", (event) =>
        this.to(event.merchantId, `sim:${event.runId}`, "sim.progress", {
          runId: event.runId,
          progress: event.progress,
          step: event.step,
          totals: event.totals,
        }),
      ),

      this.domain.on("sim.completed", (event) =>
        this.to(event.merchantId, `sim:${event.runId}`, "sim.completed", {
          runId: event.runId,
          status: event.status,
          failureReason: event.failureReason,
        }),
      ),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribes) off();
    for (const timer of this.kpiTimers.values()) clearTimeout(timer);
    this.kpiTimers.clear();
  }

  /**
   * A connection is a session, verified here rather than trusted.
   *
   * The same token the REST guard accepts, read from the same two places
   * (Bearer-style `auth.token`, or the session cookie), because a socket that
   * authenticated differently from the API would be a second, weaker door into
   * the same data. A handshake that does not verify is disconnected rather than
   * left connected-but-empty: a browser needs to know it is not receiving.
   */
  async handleConnection(client: Socket): Promise<void> {
    const token = handshakeToken(client);

    if (!token) {
      client.emit("unauthorized", { error: "Not signed in." });
      client.disconnect(true);
      return;
    }

    let claims: SessionClaims;
    try {
      claims = await this.jwt.verifyAsync<SessionClaims>(token, { secret: this.config.jwtSecret });
    } catch {
      client.emit("unauthorized", { error: "Session expired or invalid." });
      client.disconnect(true);
      return;
    }

    client.data.merchantId = claims.sub;
    for (const concern of DEFAULT_CONCERNS) await client.join(roomFor(claims.sub, concern));

    client.emit("ready", { merchantId: claims.sub, rooms: DEFAULT_CONCERNS });
  }

  handleDisconnect(client: Socket): void {
    // Socket.IO leaves every room on disconnect; this exists so the interface is
    // implemented explicitly rather than by omission.
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  /**
   * `join` names a concern, never a room.
   *
   * The merchant half of the room comes from the verified token on the socket,
   * so a client cannot ask for somebody else's case by spelling the room name
   * itself.
   */
  @SubscribeMessage("join")
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { concern?: unknown },
  ): Promise<{ joined: string | null }> {
    const merchantId = client.data.merchantId as string | undefined;
    const concern = typeof body?.concern === "string" ? body.concern : "";

    if (!merchantId || !isSubscribable(concern)) return { joined: null };

    await client.join(roomFor(merchantId, concern));
    return { joined: concern };
  }

  @SubscribeMessage("leave")
  async leave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { concern?: unknown },
  ): Promise<{ left: string | null }> {
    const merchantId = client.data.merchantId as string | undefined;
    const concern = typeof body?.concern === "string" ? body.concern : "";

    if (!merchantId || !isSubscribable(concern)) return { left: null };

    await client.leave(roomFor(merchantId, concern));
    return { left: concern };
  }

  /* ---------------------------------------------------------------- */

  private to(merchantId: string, concern: string, event: string, payload: unknown): void {
    this.toRooms(merchantId, [concern], event, payload);
  }

  /**
   * One emit, however many rooms.
   *
   * Socket.IO unions chained rooms and delivers at most once per socket, which
   * is the property that matters: a browser subscribed to both the dashboard
   * and one case is one recipient, not two.
   */
  private toRooms(
    merchantId: string,
    concerns: string[],
    event: string,
    payload: unknown,
  ): void {
    // The gateway can outlive its server reference during shutdown, and a
    // domain event landing then must not take the process down with it.
    if (!this.server) return;

    const rooms = concerns.filter(isSubscribable).map((concern) => roomFor(merchantId, concern));
    if (rooms.length === 0) return;

    this.server.to(rooms).emit(event, payload);
  }

  /**
   * Recompute the KPI strip at most once per window, however many events land.
   *
   * A simulation promotion or a burst of recoveries can publish dozens of
   * nudges inside a second. Answering each one would run the same six aggregate
   * queries dozens of times to produce dozens of nearly identical frames, and
   * the browser would draw the last of them anyway. The window is short enough
   * that a demo still feels immediate and long enough that a burst costs one
   * query set.
   */
  private scheduleKpis(merchantId: string): void {
    if (this.kpiTimers.has(merchantId)) return;

    const timer = setTimeout(() => {
      this.kpiTimers.delete(merchantId);

      void this.dashboard
        .kpis(merchantId)
        .then((kpis) => this.to(merchantId, "dashboard", "kpi.updated", kpis))
        .catch((error: Error) =>
          // A failed refresh leaves the strip on its last good numbers, which is
          // the right failure: stale beats wrong, and the page can be reloaded.
          this.logger.warn(`Could not recompute KPIs for ${merchantId}: ${error.message}`),
        );
    }, KPI_COALESCE_MS);

    // Node keeps the process alive for a pending timer; this one must not hold
    // a shutdown open for a KPI refresh nobody is waiting for.
    timer.unref?.();
    this.kpiTimers.set(merchantId, timer);
  }
}

/** Long enough to swallow a burst, short enough that a demo still feels live. */
const KPI_COALESCE_MS = 1_200;

function handshakeToken(client: Socket): string | null {
  const auth = client.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === "string" && auth.token) return auth.token;

  const header = client.handshake.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(index + 1).trim()) || null;
    }
  }

  return null;
}
