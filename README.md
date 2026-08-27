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

## Verify it

```bash
cd backend && npm test && npm run test:e2e     # hermetic: ~1,150 unit tests, 50 e2e, no database or broker
cd backend && npm run test:int                 # against the real database and Redis in .env
cd frontend && npm run lint && npm run build
npm run check:decisions                        # every decision's code reference still resolves
```

## Read it

`backend/.env.example` documents every variable and mode; `frontend/README.md`
describes the Control Tower page by page. `docs/evidence/README.md` says what the
committed report's numbers are, how they were produced and how to reproduce them.
