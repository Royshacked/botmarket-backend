# Pythia + the industry-view monitor — the `industry_view` artifact

The house's description of every industry. For each of the 163 GICS (2023) sub-industries, **Pythia**
answers three structural questions from the numbers the engine measured, and **the industry-view
monitor** decides when each answer is due again. Written 2026-10-05, the day the desk was rebuilt; the
contract it implements is `docs/design/pythia-industry-questions.md`, and where every horizon from one
month to twenty years stands is `docs/design/horizons.md`.

The one line: **Pythia describes industries — is demand growing, is it a good industry to own, where
is it in its cycle — and never forecasts a price, a return or a macro variable.**

## What replaced what

Until 2026-10-05 Pythia published a `tilt`: active weights against SPX, sized from its own forecasts
of macro "channels". A sourced check found no method that forecasts a channel's level six months out,
and every input Pythia had was already priced, so the forecasts were opinion on public data. The tilt,
the channel engine, the tilt monitor and the house scan that read the tilt were **deleted, not
archived** (git keeps them). The `tilt` and `pythia_*` collections remain in Mongo, read by nothing.

## The three questions

| Question | Grades | Measured as (aether-engine `fundamentals/industry_metrics.py`) |
|---|---|---|
| **Demand** — is the market growing or shrinking structurally? | `growing` · `in_line` · `shrinking` | Revenue growth chained over the companies present in both years (a listing is not demand), 10y and 3y, against the whole universe's |
| **Economics** — is it a good industry to own? | `good` · `average` · `poor` | Median ROIC — ROE for financials — against Damodaran's cost of capital (cost of equity for financials), the share of companies clearing it, margin level and stability, top-5 concentration |
| **Cycle** — where are current earnings in the industry's own cycle? | `peak` · `mid` · `trough`, or `stable` | Trailing-12-month operating margin (ROE for financials) placed in its own 10-year range; the normalised (10-year average) margin is what valuation reads |

The engine attaches a **code grade** to each question — a first read with documented thresholds. Pythia
starts from it. Agreeing needs a reason; **departing needs an argument** (`override_reason`), and a
departure without one is refused at publish (`industryView.service.checkDraft`), so every grade that
differs from the measurement carries its case beside it.

**Thin industries.** A sub-industry with fewer than five companies (with three years of history) is
answered at its GICS industry, then its group, then its sector — `answered_at` on every row says which,
and the board shows "via Automobiles".

**Descriptions, not forecasts.** No published evidence says owning structurally growing industries
pays; the evidence that exists says the opposite when they are expensive (Ritter; Siegel). The answers
count toward returns only paired with price, and only once that pairing passes the backtest
(`horizons.md` §1, §3). The prompt says so, the read tool says so, and the board says so.

## Where the numbers come from

All written by aether-engine into the ENGINE's database; the backend reads them through
`services/engineDb.js` (the one rule for which database that is, shared with the engine's scheduler).

| Collection | Job (Render cron) | What |
|---|---|---|
| `gics_companies` | `scripts/classify_gics.py` (by hand) | Every company in the universe (US, actively trading, > $300M, ~2,870) → its GICS sub-industry. FMP's industry where it is fine enough (`configs/fmp_to_gics.yaml`); a one-time model classification among the listed candidates where it is not, with a `none_of_these` escape to all 163 when FMP's industry is wrong; Roy's review overrides on top |
| `fin_statements` | `fin-statements`, Tue–Sat | 15 years annual + 12 quarters per company, three statements merged, point-in-time on SEC acceptance |
| `cost_of_capital` | `cost-of-capital`, each January | Damodaran's US cost of capital and of equity by industry, mapped by `configs/damodaran_to_gics.yaml` |
| `industry_metrics` | `industry-metrics`, Sundays | One document per GICS node per run date: the three questions' numbers, code grades, triggers, `answered_at` |

## The artifact — `industry_view`

One house document per sub-industry (`api/strategy/industryView.service.js`), no owner, written through
`houseArtifact.repo` so every change appends a revision:

- `demand` / `economics` / `cycle` — `{ grade, rationale, code_grade, override_reason? }`
- `summary`, `reopen_if` (checkable conditions that should bring it back early)
- `status` — `pending` (seeded, never answered) or `answered`; `cyclical`; `metrics_asof`
- `monitor` — `next_check_at`, `last_checked`, `last_triggers`, `early_reason`

## The desk

`services/agents/strategy.agent.service.js` + `prompts/strategy_system_prompt.md`. Tools: `web_search`,
`list_industries`, `get_industry_metrics`, `get_industry_companies` (largest companies, our coverage
marked), `get_industry_view` (the standing answer and its trail), `consult` (for a close departure on a
large industry). It emits one `<industry_view>` block per sub-industry it answered. In chat the blocks
are DRAFTS; the admin publishes each from the panel (`POST /api/strategy/industries/:code`).

## The monitor — `monitoring/industryView.monitor.service.js`

Two loops, because they cost different things:

- **Sync (every 6h, Mongo only).** Seeds a `pending` view for every measured sub-industry, and brings a
  view forward when the engine raises a NEW trigger since its last review — revenue down two quarters,
  returns below the hurdle, margins at a 10-year range edge — unless it was reviewed in the last 30 days.
- **Review (hourly).** A due view (pending, scheduled — yearly, quarterly for a cyclical industry — or
  brought forward) gets a headless Pythia review (`services/industryReview.service.js`), **at most three
  an hour, and only when `INDUSTRY_REVIEWS=true`**. A review publishes, or records a pass (or a refused
  answer) on the trail and restarts the clock. A changed answer posts an admin card
  (`industryNotify.service.js`, type `industry_view`). Off, nothing is spent and due views wait.

## Who reads it

- **Everyone, on the Forecasts board** (`GET /api/strategy/industries`, `/industries/:code` — any signed-in
  user since 2026-10-05; the stream and publishing stay admin-only). The board shows the house answer, or
  the measured read dashed as "not yet reviewed".
- **Atlas and Axl** through `get_industry_views` (`services/tools/industryViews.tools.js`): the answer for
  the industry each named symbol is in, or every sub-industry in a sector.
- **Atlas's review.** The fingerprint stores the held names' industry answers; a held industry's answer
  changing raises the `industry_view` trigger (`portfolioReview.util.industryChanges`). Gated on
  holdings, unlike the ungated `sector_view` it replaced: 163 industries reviewed through the year would
  otherwise ring on most reviews.
- **Not Argus.** The house scan was driven by overweight tilt rows; it is paused until the 5-year funnel
  (`horizons.md` §2C) replaces it.

## Open

- **Cost per review is unmeasured.** Measure one by hand before setting `INDUSTRY_REVIEWS`.
- **The code grades' thresholds** (e.g. "growing" = 2pp a year above the universe) are first guesses for
  the reviews to challenge.
- **Events** as an input to the three questions are parked (`horizons.md` §6).
- **Acquisitions** still inflate an acquirer's chained growth; noted, not modelled.
