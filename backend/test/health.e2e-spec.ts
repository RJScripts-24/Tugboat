import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { createFakePrisma } from "./fake-prisma";

async function bootWith(databaseUp: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(await createFakePrisma({ databaseUp }))
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe("Health (e2e)", () => {
  describe("with a reachable database", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootWith(true);
    });
    afterAll(async () => {
      await app.close();
    });

    it("GET /healthz reports ok", async () => {
      const response = await request(app.getHttpServer()).get("/healthz").expect(200);

      expect(response.body).toMatchObject({
        status: "ok",
        service: "tugboat-api",
        environment: "test",
        checks: { database: "up" },
      });
      expect(typeof response.body.uptimeSeconds).toBe("number");
    });

    it("reports Redis as unconfigured rather than healthy", async () => {
      const response = await request(app.getHttpServer()).get("/healthz").expect(200);

      expect(["not_configured", "pending"]).toContain(response.body.checks.redis);
    });

    it("GET /unknown returns 404 rather than an unhandled error", async () => {
      await request(app.getHttpServer()).get("/definitely-not-a-route").expect(404);
    });
  });

  describe("with an unreachable database", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootWith(false);
    });
    afterAll(async () => {
      await app.close();
    });

    it("answers 503 instead of a 200 that says degraded", async () => {
      const response = await request(app.getHttpServer()).get("/healthz").expect(503);

      expect(response.body).toMatchObject({
        status: "degraded",
        checks: { database: "down" },
      });
    });
  });
});
