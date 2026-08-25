import { createHash } from "node:crypto";

/**
 * Provider-shaped identifiers for simulated sends.
 *
 * Derived from the case and attempt rather than random, so a rerun of the same
 * batch produces the same references — an evidence report whose ids changed on
 * every run would be impossible to check against. They are shaped like the real
 * thing (`pay_…`, `SM…`, `re_…`) because the timeline renders them as
 * identifiers and a placeholder there would look like a stub; the honesty is
 * carried by the mode label beside them, which always says simulated.
 */

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function digest(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

export function hex(seed: string, length: number): string {
  return digest(seed).toString("hex").slice(0, length);
}

export function base62(seed: string, length: number): string {
  const bytes = digest(seed);
  let out = "";
  for (let i = 0; i < length; i += 1) out += BASE62[bytes[i % bytes.length] % BASE62.length];
  return out;
}

export function razorpayPaymentId(caseId: number, attempt: number): string {
  return `pay_${base62(`${caseId}/retry/${attempt}`, 14)}`;
}

export function whatsappMessageId(caseId: number, attempt: number): string {
  return `SM${hex(`${caseId}/wa/${attempt}`, 12)}`;
}

export function emailMessageId(caseId: number, attempt: number): string {
  return `re_${hex(`${caseId}/em/${attempt}`, 14)}`;
}

export function voiceCallId(caseId: number, attempt: number): string {
  return `CA${hex(`${caseId}/voice/${attempt}`, 12)}`;
}

/** The short pay link the copy embeds. Same construction the mock layer used. */
export function payLink(caseId: number): string {
  return `rzp.io/l/tug-${hex(`${caseId}/link`, 6)}`;
}

/** A stable number in [0,1) for one decision, so simulated outcomes are reproducible. */
export function seededUnit(seed: string): number {
  return digest(seed).readUInt32BE(0) / 0x1_0000_0000;
}

/** A stable integer in [min,max]. */
export function seededInt(seed: string, min: number, max: number): number {
  return min + Math.floor(seededUnit(seed) * (max - min + 1));
}
