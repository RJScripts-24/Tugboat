import type { INestApplication } from "@nestjs/common";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { FAKE_POLICY_V4, createFakePrisma } from "./fake-prisma";

describe("Policies (e2e)", () => {
  let app: INestApplication;
  let auth: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(await createFakePrisma())
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const login = await request(app.getHttpServer()).post("/auth/login").send({ mode: "demo" });
    auth = `Bearer ${login.body.accessToken}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const get = () => request(app.getHttpServer()).get("/policies").set("Authorization", auth);
  const put = (body: object) =>
    request(app.getHttpServer()).put("/policies").set("Authorization", auth).send(body);

  describe("GET /policies", () => {
    it("refuses an unauthenticated read — the pack is merchant configuration", async () => {
      await request(app.getHttpServer()).get("/policies").expect(401);
    });

    it("serves the pack in force in the shape the Policies page edits", async () => {
      const response = await get().expect(200);

      expect(response.body.version).toBe("v4");
      expect(response.body.pack).toEqual(FAKE_POLICY_V4);
    });

    it("serves the revision history, newest first and hash-chained", async () => {
      const { revisions } = (await get().expect(200)).body;

      expect(revisions[0]).toMatchObject({ version: "v4", actor: "HUMAN", by: "Demo Merchant" });
      expect(revisions[0].prevHash).toBe("0".repeat(10));
      expect(revisions[0].hash).toMatch(/^[0-9a-f]{10}$/);
    });
  });

  describe("PUT /policies", () => {
    it("cuts a new version, reports the diff, and puts it in force", async () => {
      const next = structuredClone(FAKE_POLICY_V4);
      next.contact.maxAttempts = 5;

      const response = await put(next).expect(200);

      expect(response.body.version).toBe("v5");
      expect(response.body.unchanged).toBe(false);
      expect(response.body.changes).toEqual([
        {
          path: "contact.maxAttempts",
          label: "Attempts per case",
          from: "4",
          to: "5",
          direction: "looser",
        },
      ]);

      const after = (await get().expect(200)).body;
      expect(after.version).toBe("v5");
      expect(after.pack.contact.maxAttempts).toBe(5);
      // The old version stays in the history; it is superseded, not erased.
      expect(after.revisions.map((r: { version: string }) => r.version)).toEqual(["v5", "v4"]);
    });

    it("chains each revision onto the one before it", async () => {
      const { revisions } = (await get().expect(200)).body;
      const [newest, oldest] = revisions;

      expect(newest.prevHash).toBe(oldest.hash);
      expect(oldest.prevHash).toBe("0".repeat(10));
    });

    it("does not cut a version when nothing moved", async () => {
      const current = (await get().expect(200)).body;
      const response = await put(current.pack).expect(200);

      expect(response.body.unchanged).toBe(true);
      expect(response.body.version).toBe(current.version);
      expect(response.body.changes).toEqual([]);
    });

    it("refuses to disable opt-out, and says why", async () => {
      const current = (await get().expect(200)).body.pack;
      const response = await put({ ...current, rules: { ...current.rules, opt_out: false } }).expect(
        422,
      );

      expect(response.body.error).toContain("Opt-out cannot be disabled");

      const after = (await get().expect(200)).body;
      expect(after.pack.rules.opt_out).toBe(true);
    });

    it("rejects a pack that would make the agent unbounded", async () => {
      const current = (await get().expect(200)).body.pack;
      const response = await put({
        ...current,
        contact: { ...current.contact, maxAttempts: 500 },
      }).expect(422);

      expect(response.body.issues).toContainEqual(
        expect.objectContaining({ path: "contact.maxAttempts" }),
      );
    });

    it("rejects a field the pack does not define rather than storing it", async () => {
      const current = (await get().expect(200)).body.pack;
      await put({ ...current, retryForever: true }).expect(422);
    });

    it("refuses an unauthenticated write", async () => {
      await request(app.getHttpServer()).put("/policies").send(FAKE_POLICY_V4).expect(401);
    });
  });
});
