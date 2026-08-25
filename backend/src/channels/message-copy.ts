import type { CaseType, RootCause } from "@prisma/client";

import { payLink } from "./channel-refs";

/**
 * What Boa actually says.
 *
 * Ported from the frontend's `whatsappCopy` / `emailCopy` (D-3: the mock layer
 * is the contract), so the message the backend sends is the message the Case
 * Detail timeline was designed to quote. Three rules hold across every variant:
 * Boa introduces itself by name on the merchant's behalf, it never threatens,
 * and every customer-facing message ends with the opt-out line — the line is
 * appended by construction rather than by remembering, because a nudge without
 * a way out is the thing the regulator objects to.
 */

export const OPT_OUT_LINE = "Reply STOP if you'd rather not hear from us.";

export type CopyContext = {
  caseId: number;
  type: CaseType;
  rootCause: RootCause | null;
  amountPaise: number;
  customerName: string;
  merchantName: string;
  hinglish: boolean;
  attempt: number;
};

export type EmailCopy = { subject: string; lines: string[] };

const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100));

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function whatsappCopy(ctx: CopyContext): string[] {
  const amount = `₹${inr(ctx.amountPaise)}`;
  const who = firstName(ctx.customerName);
  const link = payLink(ctx.caseId);

  if (ctx.hinglish) {
    switch (ctx.rootCause) {
      case "INSUFFICIENT_FUNDS":
        return [
          `Namaste ${who}, ${ctx.merchantName} se Boa bol rahi hoon.`,
          `Aapka ${amount} ka payment complete nahi ho paaya — bank ne balance short bataya.`,
          `Jab convenient ho, is link se pura kar dijiye: ${link}`,
          OPT_OUT_LINE,
        ];
      case "CARD_EXPIRED":
        return [
          `Namaste ${who}, ${ctx.merchantName} se Boa.`,
          `Aapke card ki validity khatam ho gayi hai, isliye ${amount} ka payment nahi hua.`,
          `Naya card yahan add kar sakte hain: ${link}`,
          OPT_OUT_LINE,
        ];
      case "BANK_GATEWAY_DEGRADED":
        return [
          `Namaste ${who}, ${ctx.merchantName} se Boa.`,
          `Aapke ${amount} ke payment mein bank ki taraf se dikkat thi — galti aapki nahi thi.`,
          `Ab sab theek hai, ek click mein ho jayega: ${link}`,
          OPT_OUT_LINE,
        ];
      default:
        return [
          `Namaste ${who}, ${ctx.merchantName} se Boa.`,
          ctx.attempt > 1
            ? `Bas ek aakhri reminder — ${amount} ka payment abhi bhi pending hai.`
            : `Aapka ${amount} ka payment adhoora reh gaya tha.`,
          `Yahan se pura kar sakte hain: ${link}`,
          OPT_OUT_LINE,
        ];
    }
  }

  switch (ctx.rootCause) {
    case "INSUFFICIENT_FUNDS":
      return [
        `Hi ${who}, Boa here on behalf of ${ctx.merchantName}.`,
        `Your ${amount} payment didn't go through — the bank returned insufficient balance.`,
        `Finish it whenever suits you: ${link}`,
        OPT_OUT_LINE,
      ];
    case "CARD_EXPIRED":
      return [
        `Hi ${who}, Boa here on behalf of ${ctx.merchantName}.`,
        `The card on file has expired, so the ${amount} debit couldn't be taken.`,
        `Add a current card here: ${link}`,
        OPT_OUT_LINE,
      ];
    case "BANK_GATEWAY_DEGRADED":
      return [
        `Hi ${who}, Boa here on behalf of ${ctx.merchantName}.`,
        `Your ${amount} payment failed at the bank, not at your end.`,
        `It's clear now and takes one tap: ${link}`,
        OPT_OUT_LINE,
      ];
    default:
      return [
        `Hi ${who}, Boa here on behalf of ${ctx.merchantName}.`,
        ctx.attempt > 1
          ? `Last note from us — ${amount} is still outstanding.`
          : `You left a ${amount} payment unfinished.`,
        `Pick it up here: ${link}`,
        OPT_OUT_LINE,
      ];
  }
}

export function emailCopy(ctx: CopyContext): EmailCopy {
  const amount = `₹${inr(ctx.amountPaise)}`;
  const who = firstName(ctx.customerName);
  const sign = `— Boa, on behalf of ${ctx.merchantName}`;

  if (ctx.type === "INVOICE_OVERDUE") {
    const firm = ctx.attempt > 1;
    return {
      subject: firm
        ? `Second reminder — ${amount} outstanding`
        : `${amount} invoice is past its due date`,
      lines: [
        `Hello ${who},`,
        firm
          ? `Our ${amount} invoice is still open and now past the agreed terms. We would like to close it this week.`
          : `A gentle note that ${amount} is now past its due date. If it has already been paid, please ignore this.`,
        `Pay in one click below, or reply to this email and a person will pick it up.`,
        sign,
      ],
    };
  }

  if (ctx.rootCause === "CARD_EXPIRED") {
    return {
      subject: `Your card expired — ${amount} is waiting`,
      lines: [
        `Hello ${who},`,
        `The card saved against this ${
          ctx.type === "MANDATE_FAILED" ? "subscription" : "order"
        } has expired, so the ${amount} payment could not be taken.`,
        `Adding a current card takes under a minute and nothing else changes.`,
        sign,
      ],
    };
  }

  if (ctx.rootCause === "MANDATE_REVOKED") {
    return {
      subject: "Your auto-pay was cancelled at the bank",
      lines: [
        `Hello ${who},`,
        `Your bank tells us the auto-debit mandate for this subscription was withdrawn, so the ${amount} charge could not run.`,
        `If that was deliberate, no action is needed. If not, you can re-authorise in one step.`,
        sign,
      ],
    };
  }

  return {
    subject:
      ctx.attempt > 1 ? `Still holding your ${amount}` : `Your ${amount} payment didn't complete`,
    lines: [
      `Hello ${who},`,
      `The ${amount} payment on this order did not complete. Nothing has been charged.`,
      `The link below picks up exactly where you left off.`,
      sign,
    ],
  };
}

/** The WhatsApp template name the provider row reports. */
export function whatsappTemplate(rootCause: RootCause | null): string {
  return `tug_recovery_${(rootCause ?? "unknown").toLowerCase()}`;
}
