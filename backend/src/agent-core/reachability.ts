import type { PolicyChannel } from "../policy/policy-pack";

/**
 * Channels a customer cannot be reached on, because the contact for them
 * does not exist.
 *
 * The ladder is a preference order over channels the merchant has; it says
 * nothing about whether this customer has a phone or an inbox. The simulated
 * adapters never cared — they fabricate a send for any address — and the first
 * real lane found the gap at once: a customer with an email and no phone was
 * planned a WhatsApp, the adapter refused the empty number, the action failed
 * and the case escalated as if the customer had been unreachable (B-61).
 * Treating a missing contact as a refused rung walks the ladder down instead.
 */
export function unreachableChannels(customer: {
  phone: string | null;
  email: string | null;
}): PolicyChannel[] {
  const out: PolicyChannel[] = [];
  if (!customer.phone?.trim()) out.push("WHATSAPP", "VOICE");
  if (!customer.email?.trim()) out.push("EMAIL");
  return out;
}
