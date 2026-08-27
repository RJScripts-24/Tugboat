import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * The simulator is sealed from the thing it measures (ADR-10).
 *
 * Every accuracy figure in the evidence report rests on one claim: the agent
 * never saw the answer. That claim cannot be made by a comment, and it cannot
 * be made by good intentions either — it is one careless import away from being
 * false, and it would be false quietly, with the numbers merely getting better.
 * So it is asserted here, structurally.
 *
 * Three things are checked. The agent's modules have no import path into the
 * simulator, so a persona, a true root cause and a seeded outcome are all
 * unreachable from the code being graded. The ground-truth table is queried in
 * exactly one module — `metrics` — and only at grading time. And the simulator
 * itself never calls `Math.random`, because a single unseeded draw anywhere in
 * a batch turns "run it again on seed 42 and you get this file back" into a
 * claim that fails the first time somebody checks it.
 */

const SRC = resolve(__dirname, "..");

/** The modules that make up the agent — the code the batch is measuring. */
const AGENT_MODULES = ["agent-core", "policy", "channels", "cases", "conversation", "approvals", "audit"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const rel = (file: string) => relative(SRC, file).split(sep).join("/");

const sourceFiles = walk(SRC).filter((file) => !file.endsWith(".spec.ts"));

describe("the simulator is sealed from the agent (ADR-10)", () => {
  it("gives no agent module an import path into the simulator", () => {
    const offenders = sourceFiles
      .filter((file) => AGENT_MODULES.some((module) => rel(file).startsWith(`${module}/`)))
      .filter((file) => /from\s+"[^"]*\/simulator\//.test(readFileSync(file, "utf8")))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it("keeps the ingestion door innocent of what a simulated case is", () => {
    // `ingestion` is allowed to carry a run id for attribution, but it must not
    // reach a persona: a normalizer that could read the answer key would make
    // the "same door as reality" claim decorative.
    const offenders = walk(join(SRC, "ingestion"))
      .filter((file) => !file.endsWith(".spec.ts"))
      .filter((file) => /from\s+"[^"]*\/simulator\//.test(readFileSync(file, "utf8")))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it("queries the ground-truth table only from metrics", () => {
    const readers = sourceFiles
      .filter((file) => /\bsimGroundTruth\b/.test(readFileSync(file, "utf8")))
      .map(rel)
      .sort();

    // The simulator writes the answer key; metrics is the only module that
    // reads it, and only after the run has finished.
    expect(readers).toEqual(["metrics/evaluator.service.ts", "simulator/simulations.service.ts"]);
  });

  it("reads a persona nowhere the agent can reach", () => {
    const readers = sourceFiles
      .filter((file) => /\bpersonaJson\b/.test(readFileSync(file, "utf8")))
      .map(rel)
      .filter((file) => !file.startsWith("simulator/") && !file.startsWith("metrics/"))
      .sort();

    expect(readers).toEqual([]);
  });
});

describe("the batch is reproducible by construction", () => {
  const simulatorFiles = walk(join(SRC, "simulator")).filter((file) => !file.endsWith(".spec.ts"));

  it("never draws from Math.random", () => {
    const offenders = simulatorFiles
      .filter((file) => /Math\.random\s*\(/.test(readFileSync(file, "utf8")))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it("never reads the wall clock directly — the run owns its own time", () => {
    const offenders = simulatorFiles
      .filter((file) => !file.endsWith("batch-runner.service.ts"))
      .filter((file) => !file.endsWith("simulations.service.ts"))
      .filter((file) => /\bDate\.now\s*\(|new Date\s*\(\s*\)/.test(readFileSync(file, "utf8")))
      .map(rel);

    // The runner and the service are the two places allowed to anchor a run to
    // the wall clock; everything downstream of them works in offsets.
    expect(offenders).toEqual([]);
  });

  it("draws every simulated outcome from the persona rather than the database id", () => {
    const engine = readFileSync(join(SRC, "simulator", "persona-engine.ts"), "utf8");

    // A seed built from a case id looks harmless and is not: ids are assigned
    // by an autoincrement with no memory of the previous run, so a report
    // seeded from one differs on the second run of the same seed.
    expect(engine).not.toMatch(/SeededRng\(`\$\{[^`]*caseId/);
    expect(engine.match(/new SeededRng\(`\$\{persona\.seed\}/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
