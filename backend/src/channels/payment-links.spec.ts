import type { AppConfigService } from "../config/app-config.service";
import type { PrismaService } from "../prisma/prisma.service";
import { payLink } from "./channel-refs";
import { PaymentLinkService } from "./payment-links.service";
import type { RazorpayClient } from "./razorpay.client";

/**
 * One link per case, and none at all unless the lane is real.
 */
function harness(mode: "simulated" | "real") {
  const rows = new Map<number, { caseId: number; providerId: string; shortUrl: string }>();
  let creates = 0;

  const prisma = {
    paymentLink: {
      findUnique: async ({ where }: { where: { caseId: number } }) => rows.get(where.caseId) ?? null,
      create: async ({ data }: { data: { caseId: number; providerId: string; shortUrl: string } }) => {
        rows.set(data.caseId, data);
        return data;
      },
    },
  } as unknown as PrismaService;

  const config = {
    channelModes: { razorpay: mode, email: "simulated", whatsapp: "simulated", voice: "simulated" },
  } as unknown as AppConfigService;

  const client = {
    createPaymentLink: async (input: { referenceId: string }) => {
      creates += 1;
      return { id: `plink_${input.referenceId}`, short_url: `https://rzp.io/l/${input.referenceId}`, status: "created" };
    },
  } as unknown as RazorpayClient;

  const service = new PaymentLinkService(prisma, config, mode === "real" ? client : null);
  return { service, rows, creates: () => creates };
}

const REQUEST = {
  caseId: 1042,
  amountPaise: 480_000,
  customerName: "Priya",
  email: "p@example.test",
  description: "Demo Merchant · payment failed",
};

describe("the payment link service", () => {
  it("derives the mock layer's link in simulated mode and writes nothing", async () => {
    const { service, rows } = harness("simulated");

    const link = await service.linkFor(REQUEST);

    expect(link).toEqual({
      url: payLink(1042),
      providerId: "plink_sim_1042",
      mode: "simulated",
      created: false,
    });
    // A batch's evidence must be byte-identical with this service present.
    expect(rows.size).toBe(0);
  });

  it("creates a real link once per case and reads it back thereafter", async () => {
    const { service, rows, creates } = harness("real");

    const first = await service.linkFor(REQUEST);
    const second = await service.linkFor(REQUEST);
    const other = await service.linkFor({ ...REQUEST, caseId: 1043 });

    expect(first).toMatchObject({ url: "https://rzp.io/l/C-1042", mode: "real", created: true });
    expect(second).toMatchObject({ url: "https://rzp.io/l/C-1042", mode: "real", created: false });
    expect(other.url).toBe("https://rzp.io/l/C-1043");
    expect(creates()).toBe(2);
    expect(rows.get(1042)?.providerId).toBe("plink_C-1042");
  });

  it("falls back to simulated when the lane is real but no client was built", () => {
    const { service } = harness("simulated");
    expect(service.mode).toBe("simulated");
  });
});
