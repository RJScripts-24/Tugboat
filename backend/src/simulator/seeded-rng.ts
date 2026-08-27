import { createHash } from "node:crypto";

/**
 * The simulator's only source of randomness.
 *
 * `Math.random` is banned in this module and an architecture test enforces it.
 * The evidence report's whole claim is "run it again on seed 42 and you will
 * get this file back"; one unseeded coin flip anywhere in the batch turns that
 * claim into a lie, and it would be a lie nobody noticed until a panelist
 * re-ran it.
 *
 * `sfc32` is the generator — four 32-bit words of state, three shifts and an
 * add per draw. It is not cryptographic and does not need to be: what it needs
 * is a long period, no visible structure between neighbouring seeds, and the
 * same output on every machine, which a floating-point-free integer generator
 * gives and a hand-rolled linear congruential one does not.
 *
 * Streams are derived by name rather than shared. If the persona generator and
 * the reply engine drew from one sequence, adding a single draw to the former
 * would shift every reply in the batch — and a report that changes because an
 * unrelated line of code was added is not reproducible in any useful sense.
 */
export class SeededRng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly seed: string) {
    const digest = createHash("sha256").update(seed).digest();
    this.a = digest.readUInt32BE(0);
    this.b = digest.readUInt32BE(4);
    this.c = digest.readUInt32BE(8);
    this.d = digest.readUInt32BE(12);

    // Discard the first draws: sfc32 needs a few rounds before neighbouring
    // seeds stop producing visibly similar opening values.
    for (let i = 0; i < 12; i += 1) this.next();
  }

  /** A fresh, independent stream. Same parent seed and label ⇒ same stream. */
  fork(label: string): SeededRng {
    return new SeededRng(`${this.seed}::${label}`);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;

    let t = (this.a + this.b) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.d = (this.d + 1) >>> 0;
    t = (t + this.d) >>> 0;
    this.c = (this.c + t) >>> 0;

    return t / 4_294_967_296;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("SeededRng.pick was handed an empty list");
    return items[this.int(0, items.length - 1)];
  }

  /** Picks by weight. Weights need not sum to anything in particular. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0) throw new Error("SeededRng.weighted needs at least one positive weight");

    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }

    return entries[entries.length - 1][0];
  }

  /**
   * A normal draw, clamped.
   *
   * Box–Muller, because populations are not uniform: response rates, patience
   * and payday timing all cluster around a middle with thin tails, and drawing
   * them flat would produce a batch where the average customer does not exist.
   */
  normal(mean: number, deviation: number, min: number, max: number): number {
    const u = Math.max(this.next(), Number.EPSILON);
    const v = this.next();
    const value = mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.min(max, Math.max(min, value));
  }

  /** Fisher–Yates, so a shuffled list is a permutation rather than a sort by noise. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}
