#!/usr/bin/env node
/**
 * `npm run demo` — Tugboat from a fresh clone to a signed-in Control Tower.
 *
 *   node scripts/demo.mjs [--batch[=N]] [--seed=N] [--promote] [--build] [--reseed]
 *
 * Installs what is missing, applies migrations, seeds the demo merchant when
 * the database has none, builds both apps, starts them, waits until each
 * answers, and prints the login. Stays in the foreground: Ctrl+C stops both.
 *
 * --batch[=N]  after boot, run a real N-case batch (default 60) on the seed
 *              and stream its progress here; with --promote it becomes the
 *              batch the Control Tower narrates. A batch takes minutes, not
 *              seconds, because it does every case's real work (docs/evidence).
 * --seed=N     the batch's seed (default 42).
 * --build      rebuild both apps even if a build exists.
 * --reseed     run the database seed even though a demo merchant exists.
 *              Destructive: the seed clears every case, customer and ledger
 *              row for the merchant, including every simulation batch.
 *
 * Only Node built-ins are used, so this runs before any `npm install` has.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BACKEND = path.join(ROOT, "backend");
const FRONTEND = path.join(ROOT, "frontend");
const WINDOWS = process.platform === "win32";

const DEMO_LOGIN = { email: "demo@tugboat.dev", password: "tugboat-demo" };
const DEFAULT_MIX = { PAYMENT_FAILED: 40, CHECKOUT_ABANDONED: 25, MANDATE_FAILED: 20, INVOICE_OVERDUE: 15 };

const flags = parseArgs(process.argv.slice(2));
const children = [];

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  stopChildren();
  process.exit(1);
});

async function main() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) throw new Error(`Node 20 or newer is required; this is ${process.versions.node}.`);

  const env = requireBackendEnv();
  ensureFrontendEnv();

  const apiPort = Number(env.PORT ?? 4000);
  const apiUrl = `http://localhost:${apiPort}`;
  const webPort = webPortFrom(env.FRONTEND_ORIGIN) ?? 3000;
  const webUrl = `http://localhost:${webPort}`;

  step("Dependencies");
  installIfMissing(BACKEND);
  installIfMissing(FRONTEND);

  step("Database");
  run("npx", ["prisma", "migrate", "deploy"], BACKEND);
  run("npx", ["prisma", "generate"], BACKEND);

  step("Build");
  if (flags.build || !existsSync(path.join(BACKEND, "dist", "src", "main.js"))) {
    run("npm", ["run", "build"], BACKEND);
  } else {
    note("backend/dist exists — skipping (pass --build to rebuild)");
  }
  if (flags.build || !existsSync(path.join(FRONTEND, ".next", "BUILD_ID"))) {
    run("npm", ["run", "build"], FRONTEND);
  } else {
    note("frontend/.next exists — skipping (pass --build to rebuild)");
  }

  step("API");
  start("api", "node", ["dist/src/main"], BACKEND);
  await waitFor(`${apiUrl}/healthz`, (response) => response.ok, "the API");

  // The seed is destructive, so it runs only when there is nobody to sign in
  // as — a fresh database — or when asked for by name.
  let token = await login(apiUrl);
  if (!token || flags.reseed) {
    note(flags.reseed ? "reseeding on request" : "no demo merchant yet — seeding the database");
    run("npx", ["prisma", "db", "seed"], BACKEND);
    token = await login(apiUrl);
    if (!token) throw new Error("The demo merchant could not sign in after seeding.");
  } else {
    note("demo merchant present — leaving the database as it is (pass --reseed to rebuild the seed set)");
  }

  step("Control Tower");
  start("web", "node", ["node_modules/next/dist/bin/next", "start", "-p", String(webPort)], FRONTEND);
  await waitFor(`${webUrl}/login`, (response) => response.ok, "the Control Tower");

  banner([
    `Control Tower   ${webUrl}/login`,
    `API             ${apiUrl}   (health: ${apiUrl}/healthz)`,
    ``,
    `Sign in         ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`,
    `                or press "Try the demo" on the login page`,
    ``,
    `Modes           ${await modes(apiUrl)}`,
    ``,
    flags.batch
      ? `Batch           starting a ${flags.batch}-case batch on seed ${flags.seed}${flags.promote ? " (will be promoted)" : ""}`
      : `Batch           npm run demo -- --batch=60 --promote   runs a real batch and narrates it`,
    ``,
    `Ctrl+C stops both processes.`,
  ]);

  if (flags.batch) await runBatch(apiUrl, token, flags);

  await new Promise(() => {});
}

/* ------------------------------------------------------------------ */

function requireBackendEnv() {
  const file = path.join(BACKEND, ".env");
  if (!existsSync(file)) {
    throw new Error(
      [
        "backend/.env is missing.",
        "  cp backend/.env.example backend/.env",
        "then fill in DATABASE_URL (a Postgres 16), JWT_SECRET (32+ characters) and,",
        "for the scheduler, REDIS_URL. Every third-party key is optional: with none",
        "set, every lane runs simulated and the whole agent loop still works.",
      ].join("\n"),
    );
  }
  return parseEnv(readFileSync(file, "utf8"));
}

function ensureFrontendEnv() {
  const target = path.join(FRONTEND, ".env.local");
  if (existsSync(target)) return;
  copyFileSync(path.join(FRONTEND, ".env.local.example"), target);
  note("frontend/.env.local created from .env.local.example");
}

function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function webPortFrom(origin) {
  try {
    const url = new URL(origin);
    return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

function installIfMissing(dir) {
  if (existsSync(path.join(dir, "node_modules"))) {
    note(`${path.basename(dir)}/node_modules exists`);
    return;
  }
  run("npm", [existsSync(path.join(dir, "package-lock.json")) ? "ci" : "install"], dir);
}

function run(command, args, cwd) {
  console.log(`  $ ${command} ${args.join(" ")}   (${path.relative(ROOT, cwd) || "."})`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: WINDOWS });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

function start(label, command, args, cwd) {
  console.log(`  > ${command} ${args.join(" ")}   (${path.relative(ROOT, cwd)})`);
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
  children.push(child);

  const prefix = (stream) => {
    let rest = "";
    stream.on("data", (chunk) => {
      rest += chunk.toString();
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) console.log(`  [${label}] ${line}`);
    });
  };
  prefix(child.stdout);
  prefix(child.stderr);

  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`\n✗ ${label} exited (${code ?? signal}); stopping.`);
    stopChildren();
    process.exit(1);
  });
  return child;
}

let stopping = false;
function stopChildren() {
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (WINDOWS) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\nStopping…");
    stopChildren();
    process.exit(0);
  });
}

async function waitFor(url, accept, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`  waiting for ${what} at ${url} `);
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (accept(response)) {
        console.log("✓");
        return;
      }
    } catch {
      // not up yet
    }
    process.stdout.write(".");
    await sleep(1000);
  }
  throw new Error(`${what} did not answer within ${timeoutMs / 1000}s`);
}

async function login(apiUrl) {
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "demo" }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  return body.accessToken ?? null;
}

async function modes(apiUrl) {
  const health = await (await fetch(`${apiUrl}/healthz`)).json();
  const lanes = Object.entries(health.modes.channels)
    .map(([lane, mode]) => `${lane}=${mode}`)
    .join(" ");
  return `llm=${health.modes.llm} ${lanes} · redis=${health.checks.redis}`;
}

async function runBatch(apiUrl, token, { batch, seed, promote }) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

  const started = await fetch(`${apiUrl}/simulations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      batchSize: batch,
      mix: DEFAULT_MIX,
      difficulty: "realistic",
      seed,
      arms: ["baseline", "naive", "tugboat"],
    }),
  });
  if (!started.ok) throw new Error(`POST /simulations answered ${started.status}: ${await started.text()}`);
  const { id } = await started.json();
  console.log(`\n  batch ${id} started — watch it in the Simulation Lab, or here:`);

  let lastLine = "";
  for (;;) {
    await sleep(5000);
    const status = await (await fetch(`${apiUrl}/simulations/${id}`, { headers })).json();
    const step = status.steps?.[status.steps.length - 1]?.line ?? "";
    const line = `${String(status.progress).padStart(3)}%  ${step}`;
    if (line !== lastLine) {
      console.log(`  ${line}`);
      lastLine = line;
    }
    if (status.status === "FAILED") throw new Error(`batch ${id} failed: ${status.failureReason}`);
    if (status.status === "COMPLETED") break;
  }

  const report = await (await fetch(`${apiUrl}/simulations/${id}/report`, { headers })).json();
  const h = report.headline;
  console.log(
    `\n  ${id}: ${h.recoveredCases}/${h.cases} recovered · ${(h.recoveryRate * 100).toFixed(1)}% of value at risk · ` +
      `${h.upliftPoints.toFixed(1)} points over baseline`,
  );

  if (promote) {
    const promoted = await fetch(`${apiUrl}/simulations/${id}/promote`, { method: "POST", headers });
    if (!promoted.ok) throw new Error(`promote answered ${promoted.status}`);
    const outcome = await promoted.json();
    console.log(`  promoted — the Control Tower now narrates ${id} (${outcome.clearedCases} cases from other batches cleared)\n`);
  } else {
    console.log(`  not promoted; POST /simulations/${id}/promote (or --promote next time) makes it the narrated batch\n`);
  }
}

function parseArgs(argv) {
  const out = { batch: 0, seed: 42, promote: false, build: false, reseed: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    switch (key) {
      case "batch":
        out.batch = value ? Number(value) : 60;
        break;
      case "seed":
        out.seed = Number(value);
        break;
      case "promote":
        out.promote = true;
        break;
      case "build":
        out.build = true;
        break;
      case "reseed":
        out.reseed = true;
        break;
      default:
        throw new Error(`Unknown option --${key}`);
    }
  }
  if (out.batch && (!Number.isInteger(out.batch) || out.batch < 10 || out.batch > 500)) {
    throw new Error("--batch must be a whole number from 10 to 500");
  }
  return out;
}

function step(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function note(text) {
  console.log(`  · ${text}`);
}

function banner(lines) {
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  console.log(`\n┌${"─".repeat(width)}┐`);
  for (const line of lines) console.log(`│  ${line.padEnd(width - 2)}│`);
  console.log(`└${"─".repeat(width)}┘\n`);
}
