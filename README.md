# Tugboat

AI revenue recovery agent for Razorpay merchants (Razorpay AI Buildathon, Track 03).
When a payment fails, a checkout is abandoned, a mandate lapses or an invoice goes
overdue, Tugboat opens a case, diagnoses why, and works it back inside a policy a
merchant can read — quiet hours, attempt caps, cool-downs, opt-outs, approvals for
anything that spends money — with every action on a hash-chained ledger and every
claim in the evidence report computed from those rows.

- `backend/` — NestJS 11 API, agent loop, simulator and evidence report (Prisma 7 on Postgres, BullMQ on Redis, Socket.IO)
- `frontend/` — Next.js 15 Control Tower: dashboard, pipeline, case detail, approvals, Simulation Lab, policies, audit explorer
- `docs/evidence/` — the committed seed-42 batch report (JSON, and the same report printed to PDF)

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

Every third-party key is optional. With none set, every channel lane runs its
simulated adapter (labelled as such on every timeline) and the LLM runs the
deterministic offline driver; the whole agent loop, the batch and the report work
at zero cost. `backend/.env.example` documents each key and what switching it on
changes.

One lane never goes real: **voice**. `CHANNEL_MODE_VOICE=real` is refused at boot.
The Hinglish conversation is conducted by the dialogue engine and the recording is
rendered server-side (`VOICE_TTS=edge` needs no key; `sarvam` uses Sarvam Bulbul),
but no phone rings — an automated outbound call is the most intrusive and, in India,
the most regulated action in the product (TRAI's DND and consent rules), and a demo
should not pretend to have that consent. Every voice event is labelled "Simulated
telephony"; the production path (Twilio/Exotel media streams + STT feeding the same
dialogue engine) is a one-class swap behind the channel seam.

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
sites with a two-minute token minted by `/api/auth/socket-token` (D-137).

**Then point Razorpay at it** — webhook URL `https://<render-url>/webhooks/razorpay`
with the same secret as `RAZORPAY_WEBHOOK_SECRET`. No tunnel is needed once
the API has a public address.

A batch started on any deployment is worked by the simulated adapters whatever
`CHANNEL_MODE_*` says — a simulated customer never reaches Resend, Twilio or
Razorpay (D-140) — and promoting it clears earlier batches, never a live case.

Render's free plan sleeps after fifteen idle minutes; a webhook that arrives
while it sleeps is retried by Razorpay, and the reconciler restores any step the
sleep delayed — but for a judging window an always-on instance is the safer
choice.

## Read it

`backend/.env.example` documents every variable and mode; `frontend/README.md`
describes the Control Tower page by page. `docs/evidence/README.md` says what the
committed report's numbers are, how they were produced and how to reproduce them.
