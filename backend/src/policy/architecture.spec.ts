import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * The structural half of "no code path reaches a channel without a gate
 * verdict".
 *
 * The type system does most of the work: `GatePass` has a declared-but-never-
 * defined brand, so the only way to produce one is an explicit cast. This suite
 * asserts that the cast happens exactly once, inside the gate — which is the
 * part a type checker cannot say on its own.
 */

const SRC = resolve(__dirname, "..");
const POLICY_DIR = join(SRC, "policy");
const CHANNELS_DIR = join(SRC, "channels");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const sourceFiles = walk(SRC).filter((file) => !file.endsWith(".spec.ts"));

/** Any cast that could conjure a pass: `as GatePass`, `as unknown as GatePass`, `<GatePass>`. */
const MINT_PATTERN = /as\s+(?:unknown\s+as\s+)?GatePass\b|<\s*GatePass\s*>/;

describe("the PolicyGate is the only issuer of a GatePass", () => {
  it("finds the mint in exactly one file, and it is the gate", () => {
    const minters = sourceFiles.filter((file) => MINT_PATTERN.test(readFileSync(file, "utf8")));

    expect(minters.map((file) => relative(SRC, file).split(sep).join("/"))).toEqual([
      "policy/policy-gate.service.ts",
    ]);
  });

  it("mints it once, so there is one place to audit", () => {
    const gate = readFileSync(join(POLICY_DIR, "policy-gate.service.ts"), "utf8");
    expect(gate.match(new RegExp(MINT_PATTERN, "g"))).toHaveLength(1);
  });

  it("keeps the brand undefinable — no runtime value backs it", () => {
    const gatePass = readFileSync(join(POLICY_DIR, "gate-pass.ts"), "utf8");

    expect(gatePass).toContain("declare const gatePassBrand: unique symbol");
    expect(gatePass).not.toMatch(/const\s+gatePassBrand\s*=/);
  });
});

describe("every channel adapter demands a pass", () => {
  const channelFiles = walk(CHANNELS_DIR).filter((file) => !file.endsWith(".spec.ts"));

  /** `send(` declarations, wherever they appear under src/channels. */
  const declarations = channelFiles.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return (source.match(/\bsend\s*\(([^)]*)\)/g) ?? []).map((signature) => ({
      file: relative(SRC, file).split(sep).join("/"),
      signature,
    }));
  });

  it("finds the interface and every adapter that implements it", () => {
    // Guards against the suite passing vacuously if the adapters ever move.
    expect(declarations.length).toBeGreaterThanOrEqual(5);
    expect(new Set(declarations.map((entry) => entry.file)).size).toBeGreaterThanOrEqual(5);
  });

  it.each(declarations.map((entry) => [entry.file, entry.signature]))(
    "%s takes a GatePass as the first argument",
    (_file, signature) => {
      expect(signature).toMatch(/send\s*\(\s*\w+\s*:\s*GatePass/);
    },
  );
});
