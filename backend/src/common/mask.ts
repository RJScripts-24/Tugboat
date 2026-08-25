/**
 * PII masking (PRD 9.9).
 *
 * Applied at the point data enters the system, not at the point it is rendered:
 * the masked form is stored alongside the real one, so any surface that has not
 * explicitly asked for the real contact cannot leak it — including LLM prompts
 * and audit payloads.
 */

/** "9822010210" -> "98•••••210" */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 5) return "•••••";

  return `${digits.slice(0, 2)}•••••${digits.slice(-3)}`;
}

/** "ops@kettleandco.in" -> "o•••••@kettleandco.in" */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "•••••";

  return `${email.slice(0, 1)}•••••${email.slice(at)}`;
}

/** Whichever contact the customer actually has, already masked. */
export function maskedContact(input: { maskedPhone?: string | null; maskedEmail?: string | null }) {
  return input.maskedPhone ?? input.maskedEmail ?? "—";
}
