import type { INestApplication } from "@nestjs/common";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { razorpaySignature } from "../src/ingestion/razorpay.signature";
import { PrismaService } from "../src/prisma/prisma.service";
import { createFakePrisma } from "./fake-prisma";

const SECRET = "whsec_tugboat_e2e";

const BODY = {
  event: "payment.failed",
  created_at: 1_756_000_000,
  payload: { payment: { entity: { id: "pay_e2e_1", amount: 1000, currency: "INR" } } },
};

async function boot(secret: string | undefined): Promise<INestApplication> {
  if (secret) process.env.RAZORPAY_WEBHOOK_SECRET = secret;
  else delete process.env.RAZORPAY_WEBHOOK_SECRET;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(await createFakePrisma())
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  return app;
}

describe("Webhooks (e2e)", () => {
  describe("with a configured secret", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await boot(SECRET);
    });
    afterAll(async () => {
      await app.close();
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
    });

    it("rejects a delivery with no signature", async () => {
      const response = await request(app.getHttpServer())
        .post("/webhooks/razorpay")
        .send(BODY)
        .expect(401);

      expect(response.body.error).toBe("Invalid webhook signature.");
    });

    it("rejects a delivery signed with the wrong secret", async () => {
      const raw = JSON.stringify(BODY);

      await request(app.getHttpServer())
        .post("/webhooks/razorpay")
        .set("content-type", "application/json")
        .set("x-razorpay-signature", razorpaySignature(raw, "whsec_attacker"))
        .send(raw)
        .expect(401);
    });

    it("rejects a delivery whose body was altered after signing", async () => {
      const raw = JSON.stringify(BODY);
      const signature = razorpaySignature(raw, SECRET);
      const tampered = JSON.stringify({ ...BODY, payload: { payment: { entity: { amount: 1 } } } });

      await request(app.getHttpServer())
        .post("/webhooks/razorpay")
        .set("content-type", "application/json")
        .set("x-razorpay-signature", signature)
        .send(tampered)
        .expect(401);
    });

    it("accepts a correctly signed delivery of an event with no playbook", async () => {
      const raw = JSON.stringify({ event: "refund.created", payload: {} });

      const response = await request(app.getHttpServer())
        .post("/webhooks/razorpay")
        .set("content-type", "application/json")
        .set("x-razorpay-signature", razorpaySignature(raw, SECRET))
        .set("x-razorpay-event-id", "evt_e2e_ignored")
        .send(raw)
        .expect(200);

      // Acknowledged rather than errored, so Razorpay stops retrying it.
      expect(response.body.status).toBe("ignored");
    });

    it("counts a successful payment without opening a case", async () => {
      const raw = JSON.stringify({
        event: "payment.captured",
        created_at: 1_756_000_000,
        payload: { payment: { entity: { id: "pay_ok_1", amount: 1000, method: "upi" } } },
      });

      const response = await request(app.getHttpServer())
        .post("/webhooks/razorpay")
        .set("content-type", "application/json")
        .set("x-razorpay-signature", razorpaySignature(raw, SECRET))
        .set("x-razorpay-event-id", "evt_e2e_success")
        .send(raw)
        .expect(200);

      // Successes are the denominator the degradation detector needs.
      expect(response.body).toMatchObject({ status: "recorded", outcome: "success" });
    });
  });

  describe("with no secret configured", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await boot(undefined);
    });
    afterAll(async () => {
      await app.close();
    });

    it("fails closed rather than accepting unverified deliveries", async () => {
      const response = await request(app.getHttpServer())
        .post("/webhooks/razorpay")
        .send(BODY)
        .expect(503);

      expect(response.body.error).toContain("not configured");
    });
  });

  describe("the simulator endpoint", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await boot(SECRET);
    });
    afterAll(async () => {
      await app.close();
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
    });

    it("is closed to unauthenticated callers", async () => {
      await request(app.getHttpServer())
        .post("/sim/events")
        .send({ caseType: "PAYMENT_FAILED", amountPaise: 1000 })
        .expect(401);
    });

    it("validates its body as strictly as a real webhook", async () => {
      const token = (
        await request(app.getHttpServer()).post("/auth/login").send({ mode: "demo" })
      ).body.accessToken;

      await request(app.getHttpServer())
        .post("/sim/events")
        .set("Authorization", `Bearer ${token}`)
        .send({ caseType: "NOT_A_CASE_TYPE", amountPaise: -5 })
        .expect(400);
    });
  });

  describe("POST /sim/replies", () => {
    let app: INestApplication;

    async function token(): Promise<string> {
      const response = await request(app.getHttpServer()).post("/auth/login").send({ mode: "demo" });
      return response.body.accessToken;
    }

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(await createFakePrisma())
        .compile();

      app = moduleRef.createNestApplication({ rawBody: true });
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it("is closed to unauthenticated callers", async () => {
      await request(app.getHttpServer())
        .post("/sim/replies")
        .send({ caseId: 1001, channel: "WHATSAPP", text: "STOP" })
        .expect(401);
    });

    it("rejects a channel that is not in the vocabulary", async () => {
      await request(app.getHttpServer())
        .post("/sim/replies")
        .set("Authorization", `Bearer ${await token()}`)
        .send({ caseId: 1001, channel: "CARRIER_PIGEON", text: "STOP" })
        .expect(400);
    });

    it("rejects a reply with no case to attach it to", async () => {
      await request(app.getHttpServer())
        .post("/sim/replies")
        .set("Authorization", `Bearer ${await token()}`)
        .send({ channel: "WHATSAPP", text: "STOP" })
        .expect(400);
    });

    it("refuses a field the shape does not define", async () => {
      await request(app.getHttpServer())
        .post("/sim/replies")
        .set("Authorization", `Bearer ${await token()}`)
        .send({ caseId: 1001, channel: "WHATSAPP", text: "STOP", forceHalt: true })
        .expect(400);
    });
  });
});
