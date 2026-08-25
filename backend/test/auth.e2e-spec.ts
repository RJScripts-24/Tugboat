import type { INestApplication } from "@nestjs/common";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { SESSION_COOKIE } from "../src/auth/auth.constants";
import { PrismaService } from "../src/prisma/prisma.service";
import { DEMO, createFakePrisma } from "./fake-prisma";

describe("Auth (e2e)", () => {
  let app: INestApplication;

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
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /auth/login", () => {
    it("signs in with the demo merchant's credentials", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ mode: "credentials", username: DEMO.email, password: DEMO.password })
        .expect(200);

      expect(response.body).toMatchObject({
        ok: true,
        mode: "credentials",
        redirectTo: "/dashboard",
        expiresInSeconds: 28800,
      });
      expect(typeof response.body.accessToken).toBe("string");
      expect(response.body.accessToken.split(".")).toHaveLength(3);
    });

    it("signs in through the one-click demo door without credentials", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ mode: "demo" })
        .expect(200);

      expect(response.body.mode).toBe("demo");
      expect(typeof response.body.accessToken).toBe("string");
    });

    it("rejects a missing password with the form's own message", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ mode: "credentials", username: DEMO.email })
        .expect(400);

      expect(response.body.error).toBe("Enter the merchant username and password.");
    });

    it("rejects a wrong password without revealing which half was wrong", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ mode: "credentials", username: DEMO.email, password: "not-the-password" })
        .expect(401);

      expect(response.body.error).toBe("Those credentials don't match the demo merchant.");
    });

    it("gives an unknown email the identical rejection", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ mode: "credentials", username: "someone@else.dev", password: DEMO.password })
        .expect(401);

      expect(response.body.error).toBe("Those credentials don't match the demo merchant.");
    });

    it("is case-insensitive on the username", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ mode: "credentials", username: "DEMO@Tugboat.DEV", password: DEMO.password })
        .expect(200);
    });
  });

  describe("guarded routes", () => {
    async function token(): Promise<string> {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ mode: "demo" });
      return response.body.accessToken;
    }

    it("refuses an unauthenticated request", async () => {
      await request(app.getHttpServer()).get("/auth/me").expect(401);
    });

    it("refuses a forged token", async () => {
      await request(app.getHttpServer())
        .get("/auth/me")
        .set("Authorization", "Bearer not.a.jwt")
        .expect(401);
    });

    it("accepts the token as a bearer header", async () => {
      const response = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Authorization", `Bearer ${await token()}`)
        .expect(200);

      expect(response.body).toMatchObject({ email: DEMO.email, mode: "demo" });
    });

    it("accepts the token from the session cookie the BFF sets", async () => {
      const response = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", `${SESSION_COOKIE}=${await token()}`)
        .expect(200);

      expect(response.body.displayName).toBe(DEMO.displayName);
    });

    it("leaves /healthz open", async () => {
      await request(app.getHttpServer()).get("/healthz").expect(200);
    });
  });
});
