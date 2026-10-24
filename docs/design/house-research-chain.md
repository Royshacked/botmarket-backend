# The house research chain — Pythia → Argus → Prometheus, no admin in between

**Status: BUILT 2026-10-23 (Roy) — steps 1–6, unit-tested, Argus live-checked on prod data (read-only). Not deployed; runs only with `PYTHIA_WEEKLY=true`.**

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
4. **Filter 1 — Argus gives the best 5 (10 since 2026-10-24).** One one-shot call per industry (the `hotlist.argus.js` pattern, house
   model): her verdict, horizon, thesis, cause, second-order view, risks and named companies, and the list. He
   picks the names that best carry HER thesis, each with why and what would make it wrong; fewer is allowed,
   and a second-order name that has not moved yet is his to add when the thesis points at it. Code holds every
   pick to the list. `HOUSE_SCAN_PER_INDUSTRY` default → 5 (10 since 2026-10-24, services/config.js). A failed call falls back to the code order of step 3,
   so a week always sends names. Every pick is logged and priced against the industry basket at the horizon, so
   Argus's picks get a track record against "the largest names".
5. **Filter 2 — Prometheus, automatically.** After the house scan queues, the week starts a house research run over
   those names (`startRun({ symbols })`, as `sleeveSource` does). A run already going → the names wait for it to
   settle, then run. **The price target's horizon is bound to the book** — swing → `3m`/`6m`, long term →
   `12m`/`18m`/`24m` — checked in code at save, so a swing name is never graded on a two-year question. Caps:
   `HOUSE_SCAN_WEEKLY_MAX` → 50, plus a weekly $ ceiling (env, ~$5) — doubled 2026-10-24 (Roy: "more Argus checks
   and Prometheus checks — double") to 100 a week and `HOUSE_RESEARCH_MAX_USD` $10.
   The chain's COVERED names are the Hotlist's Swing / Long term lists ("Prometheus confirmed", whatever the rating;
   [horizon-chains.md](./horizon-chains.md), "Swing and Long term: the weekly chain's survivors").
6. **Pick up a dead run.** The run lives in memory; a Render restart mid-run leaves rows `in_research`/`queued`
   and nothing restarts it. The weekly monitor's tick requeues stalled claims and resumes the week's names.

Everything stays behind `PYTHIA_WEEKLY` — off, no week, no names, no research.

## As built

- Step 3: `services/houseScan.candidates.js` (floors `HOUSE_SCAN_MIN_ADV_SWING` $20M / `_LONG` $5M a day; ~0.6 s an
  industry). Names already queued or in research are off the list before Argus sees it. A theme's named companies
  join each link's list (supplier links first) instead of taking a count of their own.
- Step 4: `services/houseScan.argus.js` (house model, max 4,000 tokens — 1,500 left Regional Banks' 40 rows with an
  empty answer). Live check 2026-10-23 on Steel / Broadline Retail / Regional Banks: $0.002–0.003 for all three.
  The first prompt treated her named companies as reserved seats and he picked only those; the revised one says
  the remaining slots are his — Regional Banks then took CLBK, the industry's leader, as the fifth. Picks frozen on
  the call (`pythiaCalls.attachPicks`, only a call ≤ 3 days old, once) and graded at 3m / 12m against the basket
  and against the largest uncovered names (`grades.<h>.picks`). Argus's spend books as `houseScanArgus`.
- Step 5: `services/houseResearch.service.js` — the budget (`HOUSE_RESEARCH_MAX_USD`, $5; $10 since 2026-10-24) is read back from the
  queue rows' `cost_usd`; `startRun({ maxUsd })` stops starting names when spent; an off-book horizon is rejected
  `horizon_off_book` (never retried). `scripts/run-week.mjs` waits for the research before it exits.
- Step 6: the weekly monitor's tick calls `resumeResearch` over the last 4 done weeks (`RESUME_WEEKS`) — stale
  claims (30 min) back to `queued`, then a run over what waits, oldest week first — so a name one week left behind is
  not orphaned when the next finishes. The budget is the last 7 days' research spend on Pythia names.
- Horizon rule live-checked 2026-10-23: PGR (swing) with the new opening came back on a 6m target, covered, $0.038
  (axl_dev). Before it, Prometheus set 12m on 77 of 88 coverages. Traders' copy of the week drops `house_scan.picks` and its cost.
- **Engine jobs have not run since ~2026-10-11** (daily prices 10-08, timing 10-07); the week only starts on a new
  price run, so the chain fires weekly only once the Render crons run.

## Code review 2026-10-23 — ten findings, all applied (Roy: "apply all 10")

1. A failed turn left no cost on its row and was re-bought every tick → every turn's cost goes on the row ONCE
   (`researchQueue.annotate`, `$inc`), a claim the turn does not close keeps a reason, and the pick-up requeues only
   claims with none (a run that died mid-turn).
2. The budget read only the finishing week's rows → its own read: all `pythia` rows touched in the last 7 days.
3. The horizon check read the draft raw → it reads it as the save stores it (`normalizeHorizon`, missing = 12m).
4. `startRun({ symbols })` filtered the queue's first 200 rows → it reads by the symbols.
5. One industry's throw stopped the week's scan → caught per list (and inside `industryCandidates`).
6. The pick-up restarted a run the admin had stopped → `stopped_by_admin` until the next Start or the next week.
7. Picks and basket were graded over different windows → the basket is priced again with the picks (`basket_entry`).
8. A theme with no readable link sent none of its named companies → they get a list of their own.
9. A claim overwrote the week's `started_at` → kept from the first start; each claim writes `claimed_at`.
10. Long-term lists read every quarter on record → the last ~2.5 years.

## Open

- **Hold / sell coverage from the chain** — kept like any coverage for now; whether it drops out after N weeks
  (the book, and its refresh cost, grows weekly) is Roy's call.
