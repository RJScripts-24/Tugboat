import { SeededRng } from "./seeded-rng";

describe("SeededRng", () => {
  const draw = (seed: string, count = 40) =>
    Array.from({ length: count }, () => new SeededRng(seed).next());

  it("gives the same sequence for the same seed", () => {
    const first = Array.from({ length: 200 }, (_, i) => i);
    const a = new SeededRng("seed-42");
    const b = new SeededRng("seed-42");

    expect(first.map(() => a.next())).toEqual(first.map(() => b.next()));
  });

  it("gives a different sequence for a neighbouring seed", () => {
    const a = new SeededRng("seed-42");
    const b = new SeededRng("seed-43");
    const overlap = Array.from({ length: 50 }, () => a.next()).filter(
      (value, index) => value === Array.from({ length: 50 }, () => b.next())[index],
    );

    expect(overlap).toHaveLength(0);
  });

  it("forks into streams that do not track each other", () => {
    const parent = new SeededRng("run/42");
    const personas = parent.fork("personas");
    const replies = parent.fork("replies");

    const a = Array.from({ length: 30 }, () => personas.next());
    const b = Array.from({ length: 30 }, () => replies.next());

    expect(a).not.toEqual(b);
    expect(Array.from({ length: 30 }, () => new SeededRng("run/42").fork("personas").next())[0]).toBe(
      a[0],
    );
  });

  it("stays inside its bounds", () => {
    const rng = new SeededRng("bounds");

    for (let i = 0; i < 2_000; i += 1) {
      const unit = rng.next();
      expect(unit).toBeGreaterThanOrEqual(0);
      expect(unit).toBeLessThan(1);
      expect(rng.int(3, 7)).toBeGreaterThanOrEqual(3);
      expect(rng.int(3, 7)).toBeLessThanOrEqual(7);
      expect(rng.normal(0.4, 0.2, 0, 1)).toBeLessThanOrEqual(1);
      expect(rng.normal(0.4, 0.2, 0, 1)).toBeGreaterThanOrEqual(0);
    }
  });

  it("is roughly uniform, which is what a difficulty preset assumes", () => {
    const rng = new SeededRng("uniformity");
    const buckets = new Array(10).fill(0);

    for (let i = 0; i < 100_000; i += 1) buckets[Math.floor(rng.next() * 10)] += 1;

    for (const count of buckets) expect(Math.abs(count - 10_000)).toBeLessThan(600);
  });

  it("respects weights", () => {
    const rng = new SeededRng("weights");
    let heads = 0;

    for (let i = 0; i < 20_000; i += 1) {
      if (rng.weighted([["h", 3] as const, ["t", 1] as const]) === "h") heads += 1;
    }

    expect(heads / 20_000).toBeCloseTo(0.75, 2);
  });

  it("shuffles into a permutation rather than dropping items", () => {
    const rng = new SeededRng("shuffle");
    const items = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = rng.shuffle(items);

    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(shuffled).not.toEqual(items);
  });

  it("does not vary between constructions in the same process", () => {
    expect(draw("stability")).toEqual(draw("stability"));
  });
});
