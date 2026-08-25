/**
 * The words that close a customer for good.
 *
 * Exactly the list the Policies page displays (build prompt 3.2), Hindi
 * included, because the customers are. This is a keyword match rather than a
 * classifier on purpose: opt-out is the one rule with no switch (D-43), and a
 * rule that cannot be disabled should not depend on a model being available,
 * being in a good mood, or being right.
 *
 * It is the first of two layers, not the only one. This layer is deliberately
 * strict about *where* the word appears — see `matchOptOut` — and the sentiment
 * classifier is what catches the softer phrasings. Either one closes the
 * account.
 */
export const OPT_OUT_KEYWORDS = [
  "STOP",
  "UNSUBSCRIBE",
  "OPT OUT",
  "BAND KARO",
  "बंद करो",
  "मत भेजो",
];

/**
 * Strips punctuation while keeping letters, digits and combining marks.
 *
 * The marks matter: Devanagari vowel signs and the anusvara are Unicode
 * category M, not L, so a naive "keep letters and numbers" filter turns
 * "बंद करो" into "बद कर" and the Hindi keywords stop matching entirely.
 */
function normalise(line: string): string {
  return line
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * A keyword counts when it is a whole line, or opens one.
 *
 * This is the convention the messaging providers themselves use, and the
 * reason is worth stating: "I will pay at the bus stop" is somebody promising
 * to pay, and halting them costs a recovery for nothing. So does treating
 * "Reply STOP if you would rather not hear from us" as an opt-out when a
 * customer quotes our own sign-off back at us.
 *
 * Softer phrasings — "please stop messaging me", "unsubscribe me" — are not
 * missed; they are the classifier's job, and a classifier verdict of `opt-out`
 * closes the account exactly as a keyword does. Two layers, and the
 * deterministic one never needs a network.
 */
export function matchOptOut(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalise(rawLine);
    if (!line) continue;

    for (const keyword of OPT_OUT_KEYWORDS) {
      const candidate = normalise(keyword);
      if (line === candidate || line.startsWith(`${candidate} `)) return keyword;
    }
  }

  return null;
}
