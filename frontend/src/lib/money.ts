/**
 * Money formatting, in one place.
 *
 * Amounts travel as paise (integers) and are only ever turned into a string at
 * the edge, here. Indian digit grouping throughout - a payments panel reads
 * 4,12,000 and 412,000 differently, and only one of them is right.
 */

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const INR_PAISE = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole rupees: 41200000 -> "4,12,000". No symbol - MoneyValue adds it. */
export function formatRupees(paise: number): string {
  return INR.format(Math.round(paise / 100));
}

/** Sub-rupee precision, for cost figures like ₹3.10 per ₹100 recovered. */
export function formatRupeesExact(paise: number): string {
  return INR_PAISE.format(paise / 100);
}

/** Short form for tight labels: 6840000 -> "68.4K", 18430000 -> "1.84L". */
export function formatRupeesCompact(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 10_000_000) return `${(rupees / 10_000_000).toFixed(2)}Cr`;
  if (rupees >= 100_000) return `${(rupees / 100_000).toFixed(2)}L`;
  if (rupees >= 1_000) return `${(rupees / 1_000).toFixed(1)}K`;
  return INR.format(rupees);
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}
