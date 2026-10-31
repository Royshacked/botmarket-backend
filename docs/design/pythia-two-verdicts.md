# Pythia — two verdicts per industry, and the weeks she never saw

**Status: BUILT 2026-10-31 on main (Roy: "pythia session can now continue on main"), decisions D1–D3 (§4); unit-tested
both repos; axl_dev migrated (4 split) and one live assessment (Semiconductors: near term watch, long term yes, both
calls logged, $0.004); the first monthly review sweep run on axl_dev (§7). Not pushed.** Roy: "pythia - how come
there are so little industries for long term" → "Industry can hold two verdicts and also - what about pythia didn't
assess for 3 weeks".

## 1. What the data says (axl_dev, 2026-10-31)

**Long term is rare.** 4 of 163 industries are `long_term` (Interactive Media, Financial Exchanges & Data, Payments,
Systems Software); 4 of 325 published calls have ever been. The bar (prompts/strategy_system_prompt.md) is four
conditions: demand growing, good economics, capex rising across most companies, no hype run.

- **The structure leaves 15.** "Growing" is faster than the whole universe — 39 of 163; with good economics, 15.
- **11 of the 15 meet all four** — and only 4 got `long_term`. One industry has ONE verdict, and the assessment asks
  "worth the desks' attention NOW", so a near-term answer takes the slot:

  | Meets all four | Got | Why the near-term answer won |
  |---|---|---|
  | Semiconductors, Managed Health Care | swing | a dated cause this month |
  | Health Care Distributors, Insurance Brokers | avoid | a recent run with no news behind it — timing, not a broken case |
  | Broadline Retail, Distributors, Regional Banks | no_case | quiet this week |

**Three weeks with no assessment.** 112 of 163 were last assessed 2026-10-11. Pythia's week starts from the engine's
industry price run (`industry_timing_runs`, `latestRun`); the engine wrote one for **2026-10-07** (finished 10-11) and
the next for **2026-10-27** (finished 10-28) — nothing between. The engine's Sunday cron (`engine-weekly`, which ends in
`industry-screener`) never ran: the Render jobs sat under an ignored `jobs:` key until aether-engine f7fe097
(2026-10-28). Both weeks in `pythia_weekly` were started by hand (`by: roy_shacked`), and the 10-25 batch was a forced
rerun of the 10-07 week. Nothing told anyone the engine had stopped.

And even when a week runs, it assesses only what the CHANGE scan flags — a steady, durable industry is rarely flagged,
so its long-term case is never looked at again until it expires (`years`: 91 days).

## 2. Two verdicts (Roy: "Industry can hold two verdicts")

Each industry carries:

- **`verdict` — the near term**, as today but without `long_term`: `swing` · `watch` · `avoid` · `no_case`. Driven by
  the weekly change scan; expiry as today.
- **`long_term` — its own call**: `{ call: 'yes' | 'no', thesis, why_not, horizon: 'years', reviewed_at, expires_at,
  hype }`. A `yes` is the four conditions as judged by Pythia — the measured structure (her published `industry_view`
  answers: demand growing, economics good) and her reading of the money (capex committed for years) and durability.

They are independent. Semiconductors can be `swing` AND long term yes; Health Care Distributors `avoid` (it ran with
nothing behind it) AND long term yes — the long-term book holds it, and the swing book stays away for now.

### 2.1 Who gets a long-term call, and when

- **Every industry, monthly** (D2): all 163 get a long-term call from Pythia each month (`expires_at` = 30 days, about
  $2 a month), and on every assessment the weekly scan makes anyway — one turn answers both. The measured structure
  (demand growing, economics good) is her starting point, not a gate: she may argue a case outside it, and the argument
  is stored beside the call (`override_reason`), as a structural answer that departs from its code grade is.
- **Hype** (D1): a hype run does not deny the call. A yes carries `hype: true`, shown as "long term, but stretched", and
  Argus / Atlas read it as a timing flag.

### 2.2 What reads it

`houseIndustriesFor` (industryAssessment.service) is the one seam most readers go through — Argus's scans and house
labels (`listForBook` / `listForBooks`), Atlas's sleeves (`sleeveSource`), `get_house_industries`. For `book:
'long_term'` it reads `long_term.call === 'yes'`; for `swing`, `verdict`. The rest:

| Reader | Change |
|---|---|
| houseScan.service (the weekly chain → Argus best 5 → Prometheus) | a long-term YES newly given (or reviewed with a changed thesis) sends the industry, as a `long_term` verdict does today |
| pythiaCalls (the track record) | a long-term call logged when it changes (no → yes, yes → no), graded at its own horizons (12m, 24m) against SPY; the near-term verdict logged as today |
| the board / heat map (FE) | two chips per row: the near-term verdict and "Long term ✓"; a Long term filter |
| get_industry_views / Atlas / Axl tools | both fields |
| the prompt | the assessment block gains a `long_term` object; the verdict list loses `long_term` |

### 2.3 Migration

Existing `long_term` verdicts become `long_term.call: 'yes'` (thesis kept) with `verdict: 'no_case'` until the next
assessment; every other industry gets `long_term` from the first sweep. `LEGACY_VERDICTS` keeps reading
`interesting_invest` as long term.

## 3. The weeks she never saw

1. **The engine must run on schedule.** The Blueprint from aether-engine f7fe097 (three cron services, `engine-weekly`
   Sundays 04:00 UTC) is what produces the price run. Roy creates it on Render; the first scheduled run is the Sunday
   after. Check: a new `industry_timing_runs` row (`partial: false`) every Sunday.
2. **Say so when it does not.** When the latest complete price run is more than 8 days old, the Pythia weekly monitor
   posts one admin card ("Pythia is waiting on the engine — the last industry price run is 2026-10-07, 24 days ago"),
   once per stale run, through `postCard`. It never assesses on stale prices.
3. **The long-term sweep (§2.1) does not wait on the price run** — it reads the structure and the money, which have
   their own jobs — so the long-term book cannot go three weeks unreviewed again.

## 4. Decisions (Roy, 2026-10-31)

- **D1 — a hype run and long term: flag it, do not deny it.** The call stands with `hype: true`.
- **D2 — every industry, monthly.** All 163, not only the measured growing + good ones; she may argue a case outside
  the structure, with the argument stored.
- **D3 — the stale-engine card: yes** (§3.2).

## 5. Build order

1. The artifact: `long_term` on the assessment, the parser and publish checks, the migration — tests.
2. The prompt: the two answers in one turn; the eligibility gate.
3. The monthly sweep of all 163 + the stale-engine card (pythiaWeekly monitor).
4. The readers: houseIndustriesFor, houseScan, pythiaCalls, the tools.
5. FE: two chips, the Long term filter.
6. Live: one sweep on axl_dev; the chain on one long-term yes; a browser drive of the board.

## 6. As built (2026-10-31)

- **The monthly review rides the weekly run.** A long-term call never made or past its 30 days flags the subject
  `long_term_due` in the change scan; the week assesses it with the rest, one turn answering both. While the engine is
  stale the monitor runs a **due pass** once a day (`runWeekly({ dueOnly })`: only `long_term_due`, `expired`,
  `decider_due`), inside the same week's $3 ceiling. No separate sweep job. A due pass runs only on a week already
  **done**; a week the regular run left failed or paused answers `week_open`, and the regular run finishes it first.
- **Stale is counted from the run's `finished_at`**, not its price date (a Sunday run prices Friday — by asof every
  Sunday morning before the new run would read 9 days). Over 8 days since the finish is stale.
- **A long-term yes speaks for the house for 60 days** (`LONG_TERM_STALE_DAYS`), its review due at 30 — a stalled week
  does not empty the long-term book.
- **Graded at 3 and 12 months**, the horizons every call already has — not the 12 / 24 the design named; a 24-month
  mark is a later change to `HORIZON_DAYS` for all calls.
- **The chain sends a NEW yes only** (`long_term_new`: the previous call was not yes). A monthly re-confirmation sends
  nothing; the four migrated industries were sent under their old verdict and are not sent again.
- **The card** is `pythia_engine_stale` (botId `strategy`), plain text — the FE draws it with its fallback bubble.
- **Migration**: `scripts/migrate-pythia-long-term.mjs` — run on axl_dev 2026-10-31 (4 split); prod after the deploy.

## 7. The first monthly review (axl_dev, 2026-10-31)

One due pass on week `pw_2026-10-27` (`runWeekly({ dueOnly: true })`): **133 assessed, 129 published, $1.65** (the
week's total inside its $3 ceiling). Three refused and one returned no block. GNews hit its daily limit midway, so later
turns had no news tool (they ran without it).

- **Long term: 10 yes, 120 no, 33 not yet asked** (was 4 of 163). The yeses: Semiconductors, Interactive Media &
  Services, Health Care Distributors, Financial Exchanges & Data, Broadline Retail, Distributors, Transaction & Payment
  Processing, Managed Health Care, Systems Software, Regional Banks. Five are new this pass (Health Care Distributors,
  Managed Health Care, Regional Banks, Broadline Retail, Distributors).
- **The 33 not yet asked**: 29 the week assessed on 10-28, before the build. The due pass skips anything this week tried
  within 7 days (`DUE_RETRY_DAYS`), so they come up in the next week's scan as `long_term_due`. The other 4 are this
  pass's refusals.
- **Near term after the pass**: 24 swing, 33 watch, 32 avoid, 74 no_case.
- **The chain**: the house scan ran on 25 verdicts (swing and new long-term yeses) and queued 100 names to Argus and
  Prometheus (two lists full), $0.02.
