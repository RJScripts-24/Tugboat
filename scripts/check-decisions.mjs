#!/usr/bin/env node
/**
 * `npm run check:decisions` — every `Implemented at:` line in docs/DECISIONS.md
 * points at code that exists.
 *
 * For each backticked reference of the form `path`, `path:line` or
 * `path:from-to`, optionally followed by a parenthesised symbol name, the
 * file must exist, any line number must be inside it, and the symbol must
 * appear within a few lines of the cited line (or anywhere in the file when
 * no line is given). Anything else is reported with where the symbol actually
 * is, so the entry can be corrected rather than left pointing at history.
 *
 * Exit code 1 on any drift. docs/ is a private working directory and may be
 * absent from a clone; that is not a failure.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOC = path.join(ROOT, "docs", "DECISIONS.md");
const WINDOW = 6;

if (!existsSync(DOC)) {
  console.log("docs/DECISIONS.md is not present in this checkout; nothing to check.");
  process.exit(0);
}

const lines = readFileSync(DOC, "utf8").split(/\r?\n/);
const problems = [];
let checked = 0;
let entry = "?";

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const heading = /^## (D-\d+):/.exec(line);
  if (heading) entry = heading[1];
  if (!line.includes("**Implemented at:**")) continue;

  // `path[:lines]` followed, optionally, by `(`symbol`...)`.
  const refs = line.matchAll(/`([^`\n]+?)`(?:\s*\((`[^)]*`)[^)]*\))?/g);
  for (const match of refs) {
    const target = match[1];
    const symbols = match[2] ? [...match[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [];
    const parsed = /^((?:backend|frontend|docs|scripts|docker-compose)[^:]*?)(?::(\d+)(?:-(\d+))?)?$/.exec(target);
    if (!parsed) continue;

    const [, file, from, to] = parsed;
    checked += 1;
    const abs = path.join(ROOT, file);

    if (!existsSync(abs)) {
      problems.push(`${entry} (line ${i + 1}): ${file} does not exist`);
      continue;
    }
    if (file.endsWith("/") || !/\.[a-z]+$/i.test(file)) continue;

    const source = readFileSync(abs, "utf8").split(/\r?\n/);
    const start = from ? Number(from) : null;
    const end = to ? Number(to) : start;

    if (start !== null && end > source.length) {
      problems.push(`${entry} (line ${i + 1}): ${file}:${from}${to ? `-${to}` : ""} is past the end of the file (${source.length} lines)`);
      continue;
    }

    for (const symbol of symbols) {
      const needle = symbol.replace(/\(.*$/, "").replace(/^[^A-Za-z_@]+/, "");
      if (!needle) continue;
      const hits = source
        .map((text, index) => (text.includes(needle) ? index + 1 : 0))
        .filter(Boolean);

      if (hits.length === 0) {
        problems.push(`${entry} (line ${i + 1}): \`${needle}\` is not in ${file}`);
        continue;
      }
      if (start === null) continue;

      const near = hits.some((hit) => hit >= start - WINDOW && hit <= end + WINDOW);
      if (!near) {
        problems.push(
          `${entry} (line ${i + 1}): \`${needle}\` cited at ${file}:${from}${to ? `-${to}` : ""} is at line ${hits.join(", ")}`,
        );
      }
    }
  }
}

console.log(`${checked} references checked across docs/DECISIONS.md`);
if (problems.length > 0) {
  console.log(`${problems.length} out of date:\n`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}
console.log("every Implemented-at reference resolves");
