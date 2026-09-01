# Committed evidence artifacts

The submission checklist (PRD 12) asks for a saved simulation report, with its
seed, committed to the repo — so a judge can check the numbers without running
anything.

| File | What it is |
|---|---|
| `tugboat-batch-seed-42.json` | Written by the backend at the end of a batch that actually ran (`SIM-0042-X`, 2026-08-28, under D-140 … D-143): 214 synthetic cases through detection, diagnosis, the PolicyGate, the channel adapters and the audit ledger, across ten simulated days, with a simulated merchant answering the escalations. Served verbatim by `GET /simulations/:id/report`, and byte for byte what the Simulation Lab's **Report · JSON** button downloads. |
| `tugboat-batch-seed-42.pdf` | The same run, as the Simulation Lab renders it, printed through the page's own print stylesheet by `npm run evidence:pdf` (a browser signs in, opens the Lab, and prints). Its footer names the run, the seed, the policy version and the build. There is no second report generator: the PDF is the page a judge sees. |

Both were produced by the running system, not written by hand. Until Stage 9 this directory also held the frontend's export of its seeded mock layer (`tugboat-simulation-seed-42.json`) and that export through the print stylesheet; they were fixtures, they disagreed with the measurement, and they were removed the day the Lab became API-backed so that the file on screen, the file a judge downloads and the file in this directory are one object. The run was regenerated in Stage 9 after three simulator defects were found (B-46, B-48, B-49), and again as the later stages moved the system; the first committed run, `SIM-0042-P`, reported 36.4% against the current `SIM-0042-X`'s 46.6%, and the build prompt keeps the intermediate figures.

## Reproducing the batch report

`POST /simulations` with seed **42**, batch size **214**, the realistic preset
and all three arms. The run takes roughly fifteen minutes, because it does all
the work a real batch would — every case is a live row with its own event log
and its own hash-chained ledger entries.

The run is deterministic. The same seed fixes the population, every persona,
their ground-truth causes, and every simulated outcome — none of which is
derived from a database id, precisely so that a rerun reproduces. **Every
measurement in the report is identical across two runs of one seed.** The case
references in `exceptions[].sample[].id` are not, because they come from an
autoincrement with no memory of the previous run; each sample therefore carries
`simIndex` beside the reference, which *is* fixed by the seed. The integration
suite asserts exactly this, normalising the references and comparing the rest.

`run.codeVersion`, `run.policyVersion` and `run.armsExecuted` record what
produced it, and `run.caseErrors` records how many cases threw while the batch
worked them — a run that lost some says so here rather than reporting a tidy
smaller batch.

## What the numbers describe

This is the **pinned evidence run**, not live traffic. The Control Tower's
figures move while the demo plays; these do not, and that difference is
labelled on both pages. Tugboat has no production merchants — every case in
this batch is synthetic, drawn from a seeded persona distribution with a
deliberate hostile/no-response tail so recovery can never approach 100%.

Only the **TUGBOAT arm was executed** — `run.armsExecuted` says so. Baseline and
naive are counterfactuals computed from the same population: switching the
agent off produces no cases, no actions and no ledger, so there is nothing to
read back, and "retry everything with no diagnosis and no bounds" is not this
system with a flag flipped. What makes the comparison fair is that the
customers are identical — the same people, the same balances, the same
per-contact prices, the same complaint threshold.

The compliance block is computed from the append-only case ledger and the
action rows rather than reported by the agent. That ledger is browsable in the
Audit Explorer, where the hash chain can be re-verified in the browser. The
integration suite plants a quiet-hours violation directly in the actions table
and asserts the report finds it and flips the assertion to `held: false` — a
compliance section that could only ever say yes would say nothing.
