/**
 * Seed one live demo case through the real webhook door.
 *
 * Additive: existing cases, batches and customers are untouched. The event
 * enters through POST /webhooks/razorpay with a genuine HMAC signature, so the
 * case is detected, diagnosed, gated and worked exactly as a production
 * failure would be — on whatever channel lanes the API is running.
 *
 * Usage (API must be running):
 *   node scripts/seed-live-case.mjs --type payment --name "Asha" --email a@x.dev --phone +91xxxxxxxxxx --amount 8499
 *   node scripts/seed-live-case.mjs --type invoice --name "Asha" --email a@x.dev --phone +91xxxxxxxxxx --amount 18700
 *
 * --type payment → payment.failed (UPI, insufficient funds → WhatsApp-first ladder)
 * --type invoice → invoice.expired (receivables ladder: email → email → voice)
 * --amount is in rupees. --api overrides http://localhost:4000.
 * The webhook secret is read from backend/.env (RAZORPAY_WEBHOOK_SECRET).
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, part, i, all) => {
    if (part.startsWith("--")) pairs.push([part.slice(2), all[i + 1] ?? ""]);
    return pairs;
  }, []),
);

const need = (key) => {
  if (!args[key]) {
    console.error(`Missing --${key}. See the header of this script for usage.`);
    process.exit(1);
  }
  return args[key];
};

const type = need("type");
const name = need("name");
const email = need("email");
const phone = need("phone");
const rupees = Number(need("amount"));
const api = args.api ?? "http://localhost:4000";

if (!["payment", "invoice"].includes(type)) {
  console.error(`--type must be "payment" or "invoice", got "${type}".`);
  process.exit(1);
}
if (!Number.isFinite(rupees) || rupees <= 0) {
  console.error(`--amount must be a positive number of rupees, got "${args.amount}".`);
  process.exit(1);
}

// The secret the API verifies against, straight from its own .env.
const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", "backend", ".env");
const envLine = readFileSync(envPath, "utf8")
  .split(/\r?\n/)
  .find((line) => line.startsWith("RAZORPAY_WEBHOOK_SECRET="));
const secret = envLine?.slice("RAZORPAY_WEBHOOK_SECRET=".length).trim();
if (!secret) {
  console.error(`RAZORPAY_WEBHOOK_SECRET not found in ${envPath} — the door fails closed without it.`);
  process.exit(1);
}

const paise = Math.round(rupees * 100);
const nonce = randomBytes(5).toString("hex");
const now = Math.floor(Date.now() / 1000);

const body =
  type === "payment"
    ? {
        event: "payment.failed",
        created_at: now,
        payload: {
          payment: {
            entity: {
              id: `pay_demo${nonce}`,
              amount: paise,
              currency: "INR",
              method: "upi",
              contact: phone,
              email,
              error_code: "BAD_REQUEST_ERROR",
              error_reason: "payment_failed_insufficient_funds",
              error_source: "customer",
              error_description: "Debit attempt returned insufficient balance at the issuing bank.",
              notes: { name, language: "hi-IN" },
            },
          },
        },
      }
    : {
        event: "invoice.expired",
        created_at: now,
        payload: {
          invoice: {
            entity: {
              id: `inv_demo${nonce}`,
              amount_due: paise,
              currency: "INR",
              invoice_number: `INV-2026-${nonce.slice(0, 4).toUpperCase()}`,
              notes: { name, email, phone, language: "hi-IN" },
            },
          },
        },
      };

const raw = JSON.stringify(body);
const signature = createHmac("sha256", secret).update(raw).digest("hex");

const response = await fetch(`${api}/webhooks/razorpay`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-razorpay-signature": signature,
    "x-razorpay-event-id": `evt_demo${nonce}`,
  },
  body: raw,
});

const text = await response.text();
console.log(`${response.status} ${text}`);
if (!response.ok) process.exit(1);
