<p align="center">
  <img src="design/logo-banner.png" width="480" alt="Tugboat" />
</p>

<h3 align="center">We bring your revenue back home.</h3>

<p align="center">
  AI revenue recovery agent for Razorpay merchants — built for the
  <a href="https://razorpay.com/buildathon/">Razorpay AI Buildathon</a>, Track 03.
</p>

<p align="center">
  <a href="https://tugboat-six.vercel.app/"><b>Live demo</b></a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/evidence/README.md">Evidence</a>
</p>

---

When a payment fails, a checkout is abandoned, a mandate lapses or an invoice goes
overdue, Tugboat opens a case, diagnoses why, and works it back inside a policy a
merchant can read — quiet hours, attempt caps, cool-downs, opt-outs, approvals for
anything that spends money — with every action on a hash-chained ledger and every
claim in the evidence report computed from those rows. The agent at the wheel is
**Boa**; the governing sentence is: *the LLM proposes; the state machine and the
PolicyGate dispose.*

## The numbers (committed evidence, seed 42)

From [`docs/evidence/tugboat-batch-seed-42.json`](docs/evidence/tugboat-batch-seed-42.json) —
written by the running system across 214 synthetic cases and 10 simulated days,
reproducible from the seed:

| | |
|---|---|
| Recovered | **₹11,15,724 of ₹23,95,944 at risk — 46.6%** (107 of 214 cases) |
| Uplift vs no-agent baseline (13.5%) | **+33.0 points** on the identical population |
| vs the naive arm (contact everything) | naive recovers 2.6 points more — by sending **1,004 contacts vs 398**, with **501 quiet-hour violations vs 0** and 3× the complaints |
| Diagnosis vs hidden ground truth | 90.3% (rules table 93.8%, LLM lane 57.9% on the 19 hardest; 18 low-confidence cases escalated instead of guessed) |
| Compliance, computed from 3,088 ledger rows | 0 quiet-hour sends · 0 post-opt-out contacts · 0 cases past their cap · 0 unmasked identifiers |
| Cost | ~1 paisa per ₹100 recovered |
| Not recovered | 107 cases, each with its reason in the exceptions list |

The bar for Track 03 — *measured money recovered across a batch, with compliant
escalation, stopping rules, and an audit trail* — maps to: the Simulation Lab's
batch report, the Approvals queue, the PolicyGate, and the Audit Explorer's
browser-verifiable hash chain.

## Try it

The Control Tower is live at **<https://tugboat-six.vercel.app/>** — sign in with
`demo@tugboat.dev` / `tugboat-demo` or take the "Try the demo" door. The API runs on
Render's free plan, so the first hit after an idle spell can take ~60s to wake.

<details>
<summary>What it looks like</summary>
<p align="center"><img src="design/landing.png" width="700" alt="Tugboat landing page" /></p>
</details>

- `backend/` — NestJS 11 API, agent loop, simulator and evidence report (Prisma 7 on Postgres, BullMQ on Redis, Socket.IO)
- `frontend/` — Next.js 15 Control Tower: dashboard, pipeline, case detail, approvals, Simulation Lab, policies, audit explorer
- `docs/` — [system architecture](docs/ARCHITECTURE.md) and the [committed evidence](docs/evidence/) (the seed-42 batch report as JSON, and the same report printed to PDF)

## Run it

You need Node 20+, a Postgres 16 and — for the scheduler — a Redis. `docker compose up -d`
at the repo root provides both locally; Neon and Upstash free tiers work as well.

```bash
cp backend/.env.example backend/.env     # fill DATABASE_URL, JWT_SECRET, REDIS_URL
npm run demo
```

`npm run demo` installs what is missing, applies the migrations, seeds the demo
merchant the first time it finds an empty database, builds both apps, starts them,
and prints the login (`demo@tugboat.dev` / `tugboat-demo`, or the "Try the demo" door).
Ctrl+C stops both.

```bash
npm run demo -- --batch=60 --promote     # also run a real 60-case batch on seed 42 and narrate it
```

To drop one fresh live case into the pipeline — through the real signed webhook
door, so it is detected, diagnosed, gated and worked like a production failure:

```bash
node scripts/seed-live-case.mjs --type payment --name "Asha" --email a@x.dev --phone +91xxxxxxxxxx --amount 8499
```

Every third-party key is optional. With none set, every channel lane runs its
simulated adapter (labelled as such on every timeline) and the LLM runs the
deterministic offline driver; the whole agent loop, the batch and the report work
at zero cost. `backend/.env.example` documents each key and what switching it on
changes.

Voice is simulated by default and can be real. Simulated, the Hinglish conversation
is conducted by the dialogue engine against a persona and the recording is rendered
server-side (`VOICE_TTS=edge` needs no key; `sarvam` uses Sarvam Bulbul) — no phone
rings, and every such event says "Simulated telephony". With `CHANNEL_MODE_VOICE=real`
and a voice-capable Twilio number (`TWILIO_VOICE_FROM`), Boa dials the customer: Twilio
plays her lines, listens in `hi-IN`, and the same dialogue engine answers turn by turn
until a date is agreed, hardship is declared, or the customer hangs up; the two-way
recording and the transcript land on the case. An outbound call is the most
regulated action in the product (TRAI's DND and consent rules), which is why the lane
is off until a merchant switches it on. "Ask Boa to call now" on a case queues the
voice rung immediately — the gate still decides. Replies from the customer's
phone reach the case through Twilio's inbound webhook: point the sandbox's "when a
message comes in" URL at `https://<api>/webhooks/twilio/whatsapp`.

The live LLM runs on Groq. Model ids there are namespaced by their author —
`openai/gpt-oss-120b` is OpenAI's open-weight model *served by Groq* with your
Groq key; no OpenAI account is involved. `GROQ_MODEL` picks any model the key can
see (`GET https://api.groq.com/openai/v1/models`).

## Verify it

```bash
cd backend && npm test && npm run test:e2e     # hermetic: ~1,150 unit tests, 50 e2e, no database or broker
cd backend && npm run test:int                 # against the real database and Redis in .env
cd frontend && npm run lint && npm run build
npm run check:decisions                        # every decision's code reference still resolves
```

## Deploy it (Render + Vercel)

This repo is deployed exactly this way: the Control Tower at
[tugboat-six.vercel.app](https://tugboat-six.vercel.app/), the API on a Render web
service, Postgres on Neon, Redis on Upstash.

**API on Render** — `render.yaml` at the repo root is a Blueprint: Dashboard →
Blueprints → New Blueprint Instance → this repo. It creates one web service
(`backend/`, Node 20, health check on `/healthz`) and asks once for the secrets:
`DATABASE_URL` / `DIRECT_URL` (Neon), `REDIS_URL` (Upstash TCP URL),
`FRONTEND_ORIGIN` (your Vercel URL, exactly), `PUBLIC_API_URL` (this service's
URL). Every lane starts simulated; flip `CHANNEL_MODE_*` and add a key in the
dashboard when a lane goes real. Migrations run on every start.

**Control Tower on Vercel** — import the repo with **Root Directory `frontend`**
and two environment variables: `API_URL` and `NEXT_PUBLIC_API_URL`, both the
Render URL. Nothing else: the login route sets the session cookie first-party
on the Vercel domain, and the realtime socket authenticates across the two
sites with a two-minute token minted by `/api/auth/socket-token`.

**Then point Razorpay at it** — webhook URL `https://<render-url>/webhooks/razorpay`
with the same secret as `RAZORPAY_WEBHOOK_SECRET`. No tunnel is needed once
the API has a public address.

A batch started on any deployment is worked by the simulated adapters whatever
`CHANNEL_MODE_*` says — a simulated customer never reaches Resend, Twilio or
Razorpay — and promoting it clears earlier batches, never a live case.

Render's free plan sleeps after fifteen idle minutes, **and a sleeping instance
runs no scheduler**: every deferred step — quiet hours, cool-downs, mandate
spacing, promise check-ins — waits in Redis until something wakes the process.
A webhook that arrives while it sleeps is retried by Razorpay and wakes
it; a timer does not. For any window in which the schedule matters, keep it
awake with an external ping every five minutes (cron-job.org or UptimeRobot on
`GET /healthz`) or run an always-on instance.

## Read it

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the system architecture, as built —
the diagram, the agent loop, the control plane, and all twelve architecture decisions
with their as-built status and honest limitations. `backend/.env.example` documents
every variable and mode; `frontend/README.md` describes the Control Tower page by page;
[`docs/evidence/README.md`](docs/evidence/README.md) says what the committed report's
numbers are, how they were produced and how to reproduce them.
