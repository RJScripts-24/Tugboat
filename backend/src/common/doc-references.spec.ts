import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every decision or build note a comment cites must exist.
 *
 * The teaching for this codebase lives in `docs/DECISIONS.md` and
 * `docs/BUILD-NOTES.md`, and code points at it by number (D-1). A number that
 * points at nothing — or at the wrong entry — is worse than no reference,
 * because it reads as authority. Stage 9 shipped nineteen of them: the code
 * was written with its numbers already in the comments, and the documents
 * moved underneath (B-45). This is the check that would have caught it.
 */

const ROOT = resolve(__dirname, "../../..");

const SOURCE_DIRS = ["backend/src", "backend/test", "backend/prisma", "frontend/src"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".prisma", ".sql"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

function headings(file: string, pattern: RegExp): Set<number> {
  const found = new Set<number>();
  for (const match of readFileSync(file, "utf8").matchAll(pattern)) found.add(Number(match[1]));
  return found;
}

function citations(prefix: "D" | "B"): Map<number, string[]> {
  const pattern = new RegExp(`\\b${prefix}-(\\d+)\\b`, "g");
  const byNumber = new Map<number, string[]>();

  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(pattern)) {
        const number = Number(match[1]);
        const sites = byNumber.get(number) ?? [];
        sites.push(file.slice(ROOT.length + 1));
        byNumber.set(number, sites);
      }
    }
  }

  return byNumber;
}

describe("documentation references in code", () => {
  const decisions = headings(join(ROOT, "docs/DECISIONS.md"), /^## D-(\d+):/gm);
  const buildNotes = headings(join(ROOT, "docs/BUILD-NOTES.md"), /^### B-(\d+)/gm);

  it("only cites decisions that exist in docs/DECISIONS.md", () => {
    const missing = [...citations("D")]
      .filter(([number]) => !decisions.has(number))
      .map(([number, sites]) => `D-${number} (${[...new Set(sites)].join(", ")})`);

    expect(missing).toEqual([]);
  });

  it("only cites build notes that exist in docs/BUILD-NOTES.md", () => {
    const missing = [...citations("B")]
      .filter(([number]) => !buildNotes.has(number))
      .map(([number, sites]) => `B-${number} (${[...new Set(sites)].join(", ")})`);

    expect(missing).toEqual([]);
  });

  it("is actually reading the documents, not an empty file", () => {
    expect(decisions.size).toBeGreaterThan(100);
    expect(buildNotes.size).toBeGreaterThan(40);
  });
});
