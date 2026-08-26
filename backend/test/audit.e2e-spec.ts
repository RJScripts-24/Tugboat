import type { INestApplication } from "@nestjs/common";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { createFakePrisma } from "./fake-prisma";

/**
 * The audit HTTP contract: who may read the ledger, and what the routes answer.
 *
 * The chain arithmetic is proven twice elsewhere — as a pure function in
 * `src/audit/verify-chain.spec.ts` and against a real database in
 * `test/audit.int-spec.ts`. What is left here is the boundary: the guard, the
 * query shape, and the fact that verification reads and changes nothing.
 */
describe("Audit (e2e)", () => {
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

  const server = () => app.getHttpServer();

  describe("GET /audit", () => {
    it("refuses an unauthenticated read — a ledger is not a public document", async () => {
      await request(server()).get("/audit").expect(401);
    });

    it("answers with rows, a total and the tip of each chain", async () => {
      const response = await request(server()).get("/audit").set("Authorization", auth).expect(200);

      expect(Array.isArray(response.body.rows)).toBe(true);
      expect(typeof response.body.total).toBe("number");
      expect(response.body.tips).toBeDefined();
    });

    it("rejects a case reference it cannot parse rather than ignoring it", async () => {
      // Silently dropping an unparseable filter would answer a different
      // question from the one asked, with no sign that it had.
      const response = await request(server())
        .get("/audit?case=not-a-case")
        .set("Authorization", auth)
        .expect(404);

      expect(response.body.error).toContain("not a case reference");
    });

    it("accepts an actor filter as a repeated or comma-separated parameter", async () => {
      await request(server()).get("/audit?actor=BOA,POLICY").set("Authorization", auth).expect(200);
      await request(server())
        .get("/audit?actor=BOA&actor=HUMAN")
        .set("Authorization", auth)
        .expect(200);
    });

    it("refuses an actor that is not in the vocabulary", async () => {
      await request(server()).get("/audit?actor=NOBODY").set("Authorization", auth).expect(400);
    });

    it("refuses an unknown query parameter rather than quietly ignoring it", async () => {
      await request(server()).get("/audit?tamper=yes").set("Authorization", auth).expect(400);
    });

    it("caps how much of the ledger one request may pull", async () => {
      await request(server()).get("/audit?take=2000").set("Authorization", auth).expect(200);
      await request(server()).get("/audit?take=5000").set("Authorization", auth).expect(400);
    });
  });

  describe("POST /audit/verify-chain", () => {
    it("refuses an unauthenticated verification", async () => {
      await request(server()).post("/audit/verify-chain").send({}).expect(401);
    });

    it("answers 200 with a verdict, because verifying changes nothing", async () => {
      const response = await request(server())
        .post("/audit/verify-chain")
        .set("Authorization", auth)
        .send({})
        .expect(200);

      expect(response.body).toMatchObject({
        checked: expect.any(Number),
        chains: expect.any(Number),
        broken: expect.any(Array),
      });
    });

    it("names the two digests it checked with", async () => {
      const response = await request(server())
        .post("/audit/verify-chain")
        .set("Authorization", auth)
        .send({})
        .expect(200);

      // A verdict that does not say what it verified with is a tick nobody can
      // check (D-73).
      expect(response.body.digests).toEqual({
        browser: expect.stringContaining("fnv1a"),
        server: "sha256",
      });
    });

    it("accepts a single chain to verify", async () => {
      await request(server())
        .post("/audit/verify-chain")
        .set("Authorization", auth)
        .send({ chain: "policy" })
        .expect(200);
    });

    it("refuses a body carrying anything else", async () => {
      await request(server())
        .post("/audit/verify-chain")
        .set("Authorization", auth)
        .send({ chain: "policy", skipRows: [3] })
        .expect(400);
    });
  });

  describe("GET /audit/summary", () => {
    it("counts the ledger by actor", async () => {
      const response = await request(server())
        .get("/audit/summary")
        .set("Authorization", auth)
        .expect(200);

      expect(response.body.byActor).toEqual({
        BOA: expect.any(Number),
        POLICY: expect.any(Number),
        HUMAN: expect.any(Number),
        SYSTEM: expect.any(Number),
      });
    });
  });
});
