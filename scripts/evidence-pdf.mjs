#!/usr/bin/env node
/**
 * `npm run evidence:pdf` — print the Simulation Lab's evidence report to PDF.
 *
 *   node scripts/evidence-pdf.mjs [--web=http://localhost:3000] [--out=docs/evidence/tugboat-batch-seed-42.pdf]
 *
 * Signs in through the Control Tower's own login route, opens the Simulation
 * Lab (which shows the promoted run, or the newest completed one), switches
 * the page to its print stylesheet and saves what the browser would print.
 * The PDF is therefore the same object as the JSON beside it, rendered by the
 * same page a judge sees — no second report generator (D-135).
 *
 * Needs both apps running (`npm run demo`) and the frontend's Playwright
 * dev-dependency for the browser.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(ROOT, "frontend", "package.json"));

const flags = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? true];
  }),
);
const WEB = String(flags.web ?? "http://localhost:3000").replace(/\/+$/, "");
const OUT = path.resolve(ROOT, String(flags.out ?? "docs/evidence/tugboat-batch-seed-42.pdf"));

const { chromium } = require("playwright");

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
  const page = await context.newPage();

  const login = await page.request.post(`${WEB}/api/auth/login`, { data: { mode: "demo" } });
  if (!login.ok()) throw new Error(`login answered ${login.status()}: ${await login.text()}`);

  await page.goto(`${WEB}/simulation`, { waitUntil: "load", timeout: 90_000 });
  // The provenance line is print-only, so it is in the DOM but never visible on screen.
  await page.waitForSelector(".print-only", { state: "attached", timeout: 60_000 });
  await page.waitForTimeout(1500);

  const provenance = await page.locator(".print-only").first().textContent();
  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: OUT,
    format: "A4",
    printBackground: true,
    margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" },
  });

  console.log(`wrote ${path.relative(ROOT, OUT)}`);
  console.log(`  ${provenance?.replace(/\s+/g, " ").trim()}`);
} finally {
  await browser.close();
}
