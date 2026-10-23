# The house research chain — Pythia → Argus → Prometheus, no admin in between

**Status: PLAN, 2026-10-23 (Roy). Steps 1–2 DONE (uncommitted); design of 3–6 agreed the same day.**

## What changes and why

Today (`services/houseScan.service.js`, step 7 of `pythia-assessment.md`): after Pythia's week, every FOR SWING /
FOR LONG TERM industry sends its **largest uncovered** names (3 each, 30 a week) to `research_queue`, and the names
wait until an admin presses Start (`POST /api/analyst/research-queue/run`).

Roy, 2026-10-23: **two filters. Pythia names the industries → Argus takes the industry's names and her thesis and
gives the best 5 → Prometheus filters them further against the thesis and the horizon and writes coverage
(analysis and price target), automatically.** Coverage is the end of the chain: Atlas, Mentor, or a user choosing
by hand take a company from there. No new hand-off.

- **Size is the wrong ranking.** The largest name is often not the thesis (Broadline Retail long term sent AMZN —
  mostly AWS — and DASH, which is delivery). Size stays a **liquidity floor** and a tiebreaker. (`pythia_calls`
  keeps grading her verdicts on the largest names: that measures the industry call, a different question.)
- **"Already moved" is NOT a reason to skip a name** (Roy). Momentum persists 3–12 months (Jegadeesh–Titman) and
  industry momentum is much of it (Moskowitz–Grinblatt); a compounder keeps compounding. What matters is whether the
  move ran ahead of the business — a risk Prometheus prices, not a filter.
- **The admin is the bottleneck.** 30 Pythia names sat `queued` on prod from 2026-10-20 with nobody pressing Start.

## The steps

1. **Measure a research turn — DONE.** Every name's turn is measured (the desk's calls and its consults, through
   `runAgentStream`'s `onSpend` tap); the cost rides the run's result row, the run's total and the queue row
   (`cost_usd`). A house run (no user — also the sleeve orchestrator's) books to the first admin's ledger
   (`houseLedgerUserId`) under `researchRun`, as monitor spend (inside the total, outside the chat ceiling).
2. **Measure — DONE 2026-10-23** on axl_dev, a house run on Luna over three of the waiting Pythia names: EEFT
   (named, long term) $0.0173, NXST (swing) $0.0638, TRV (named, swing) $0.028 — all three covered, **$0.109 in
   5.1 minutes, ~$0.036 a name**. The ledger estimate beforehand ($0.35 a name) was ten times too high: it was
   mostly Sonnet-era months and chat. 50 names a week ≈ $2.
3. **The candidate list (code).** The sub-industry's companies above a liquidity floor, her named companies first.
   All of them when there are ~40 or fewer; a larger industry (Regional Banks, 256) is cut to ~40 by the BOOK's
   order — **swing:** relative strength inside the industry's move, beta to the industry basket, liquidity, a
   catalyst in the window, estimates rising; **long term:** ROIC over its hurdle, purity (revenue in the
   sub-industry), reinvestment. Each row carries those numbers to Argus.
4. **Filter 1 — Argus gives the best 5.** One one-shot call per industry (the `hotlist.argus.js` pattern, house
   model): her verdict, horizon, thesis, cause, second-order view, risks and named companies, and the list. He
   picks the names that best carry HER thesis, each with why and what would make it wrong; fewer is allowed,
   and a second-order name that has not moved yet is his to add when the thesis points at it. Code holds every
   pick to the list. `HOUSE_SCAN_PER_INDUSTRY` default → 5. A failed call falls back to the code order of step 3,
   so a week always sends names. Every pick is logged and priced against the industry basket at the horizon, so
   Argus's picks get a track record against "the largest names".
5. **Filter 2 — Prometheus, automatically.** After the house scan queues, the week starts a house research run over
   those names (`startRun({ symbols })`, as `sleeveSource` does). A run already going → the names wait for it to
   settle, then run. **The price target's horizon is bound to the book** — swing → `3m`/`6m`, long term →
   `12m`/`18m`/`24m` — checked in code at save, so a swing name is never graded on a two-year question. Caps:
   `HOUSE_SCAN_WEEKLY_MAX` → 50, plus a weekly $ ceiling (env, ~$5).
6. **Pick up a dead run.** The run lives in memory; a Render restart mid-run leaves rows `in_research`/`queued`
   and nothing restarts it. The weekly monitor's tick requeues stalled claims and resumes the week's names.

Everything stays behind `PYTHIA_WEEKLY` — off, no week, no names, no research.

## Open

- **Hold / sell coverage from the chain** — kept like any coverage for now; whether it drops out after N weeks
  (the book, and its refresh cost, grows weekly) is Roy's call.
