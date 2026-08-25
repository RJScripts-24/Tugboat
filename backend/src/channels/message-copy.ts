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

/* ------------------------------------------------------------------ */
/* Copy that only ever leaves the building with a human's approval     */
/* ------------------------------------------------------------------ */

/**
 * The concession message.
 *
 * Lives here rather than in the approvals module so it is covered by the same
 * exhaustive sweep as every other variant: a discount offer is still a nudge,
 * and the one line it must never lose is the way out. Boa cannot reach this
 * function on its own — the escalation gate stops any action carrying a
 * concession — so the only path to a customer runs through an approver.
 */
export function discountCopy(ctx: CopyContext, discountPercent: number): string[] {
  const concession = Math.round((ctx.amountPaise * discountPercent) / 100);
  const net = `₹${inr(ctx.amountPaise - concession)}`;
  const gross = `₹${inr(ctx.amountPaise)}`;
  const who = firstName(ctx.customerName);
  const link = payLink(ctx.caseId);

  if (ctx.hinglish) {
    return [
      `Namaste ${who}, ${ctx.merchantName} se Boa bol rahi hoon.`,
      `Aapka ${gross} ka payment abhi bhi reserved hai.`,
      `Ek baar ke liye ${discountPercent}% off — ab sirf ${net} dena hoga: ${link}`,
      `Link 24 ghante valid hai.`,
      OPT_OUT_LINE,
    ];
  }

  return [
    `Hi ${who}, Boa here on behalf of ${ctx.merchantName}.`,
    `Your ${gross} payment is still reserved.`,
    `Here is ${discountPercent}% off, one time — ${net} to complete it: ${link}`,
    `The link is valid for 24 hours.`,
    OPT_OUT_LINE,
  ];
}

/**
 * The stand-down message, sent once and followed by nothing.
 *
 * `plan` is the difference between an offer and an acknowledgement: on real
 * money a payment plan keeps the relationship and most of the balance, while on
 * a small basket the honest answer is to close the case and leave the customer
 * alone. Neither variant asks for anything.
 */
export function hardshipCopy(
  ctx: CopyContext,
  options: { plan: boolean; instalmentPaise: number; email: boolean },
): { subject?: string; lines: string[] } {
  const who = firstName(ctx.customerName);
  const instalment = `₹${inr(options.instalmentPaise)}`;

  const subject = options.email ? `${ctx.customerName} — settling this in three parts` : undefined;

  if (!options.plan) {
    return {
      subject: options.email ? `${ctx.customerName} — closing this here` : undefined,
      lines: ctx.hinglish
        ? [
            `${who}, aapka message mila. Hum aapko is baare mein dobara contact nahi karenge.`,
            `Order jab bhi ready ho, aap khud complete kar sakte hain. Dhanyavaad.`,
            OPT_OUT_LINE,
          ]
        : [
            `${who}, thank you for letting us know. We will not contact you about this again.`,
            `The order stays available if you ever want it. That is all from us.`,
            OPT_OUT_LINE,
          ],
    };
  }

  return {
    subject,
    lines: ctx.hinglish
      ? [
          `${who}, aapka message mila — hum samajhte hain.`,
          `Agle 30 din tak koi reminder nahi jayega.`,
          `Aap chahein to ${instalment} × 3 mahine ka plan le sakte hain, bina kisi extra charge ke.`,
          `Kuch bhi ho to yahin reply kar dijiye.`,
          OPT_OUT_LINE,
        ]
      : [
          `${who}, thank you for telling us — we understand.`,
          `We have paused all reminders on this account for 30 days.`,
          `If it helps, we can split it into three parts of ${instalment} at no extra cost.`,
          `Reply here any time and a person will pick it up.`,
          OPT_OUT_LINE,
        ],
  };
}

/**
 * The opt-out line is not the approver's to delete.
 *
 * A merchant may rewrite a draft before approving it — that is the point of an
 * editable draft — but the way out is a regulatory floor rather than a
 * stylistic choice, and the same reasoning that types `rules.opt_out` as the
 * literal `true` applies to the sentence that carries it. Re-added rather than
 * refused, so an edit is never rejected for a line the merchant did not think
 * to keep.
 */
export function ensureOptOut(lines: string[]): { lines: string[]; restored: boolean } {
  const present = lines.some((line) => line.trim() === OPT_OUT_LINE);
  if (present) return { lines, restored: false };

  return { lines: [...lines, OPT_OUT_LINE], restored: true };
}
