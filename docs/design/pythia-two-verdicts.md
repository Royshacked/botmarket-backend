# Pythia — two verdicts per industry, and the weeks she never saw

**Status: DESIGN 2026-10-31, branch `feat/pythia-two-verdicts` (cut from main). Not built.** Roy: "pythia - how come
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

- **Eligible**: an industry whose published structure is demand `growing` and economics `good` (15 today). The others
  are `no` by code, with the reason ("demand in line with the universe") — no model call. Her structural answers can
  already depart from the code grade with an argument (`industry_view`), so a case she makes there flows here.
- **Reviewed**: monthly (`expires_at` = 30 days), and on every assessment of the industry the weekly scan makes anyway —
  one turn answers both. A monthly sweep of the eligible ~15 costs about $0.20.
- **Hype**: see decision D1.

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

## 4. Decisions for Roy

- **D1 — a hype run and long term.** Today a hype run denies `long_term`. Recommended: it no longer does — the call
  stands and carries `hype: true`, shown as "long term, but stretched", and Argus / Atlas see it as a timing flag. The
  alternative keeps the four conditions as they are.
- **D2 — eligibility by code.** Recommended: only demand-growing + good-economics industries get a model call (15
  today). The alternative asks Pythia about all 163 monthly (~$2/month) and lets her argue a case outside the structure.
- **D3 — the stale-engine card** (§3.2): yes / no.

## 5. Build order

1. The artifact: `long_term` on the assessment, the parser and publish checks, the migration — tests.
2. The prompt: the two answers in one turn; the eligibility gate.
3. The monthly sweep + the stale-engine card (pythiaWeekly monitor).
4. The readers: houseIndustriesFor, houseScan, pythiaCalls, the tools.
5. FE: two chips, the Long term filter.
6. Live: one sweep on axl_dev; the chain on one long-term yes; a browser drive of the board.
