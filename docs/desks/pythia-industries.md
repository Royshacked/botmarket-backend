# Pythia + the industry-view monitor — the `industry_view` artifact

> **Since 2026-10-11:** the weekly screen is retired; Pythia ASSESSES (`docs/design/pythia-assessment.md`) — a
> judgment from five inputs with a forward-graded track record, picked weekly by a change scan. The three
> questions below stay.

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
| **Economics** — is it a good industry to own? | `good` · `average` · `poor` | The industry's AGGREGATE ROIC — all its after-tax operating profit over all its invested capital; ROE for financials — against Damodaran's cost of capital (cost of equity for financials), weighted the same way. The median company and the share clearing its own hurdle are reported as breadth, with margin level and stability and top-5 concentration |
| **Cycle** — where are current earnings in the industry's own cycle? | `peak` · `mid` · `trough`, or `stable` | Trailing-12-month operating margin (ROE for financials) placed in its own 10-year range — peak / mid / trough by position; `stable` only when the range is under 30% of its mean. The normalised (10-year average) margin is what valuation reads |

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
| `gics_companies` | `scripts/classify_gics.py` (by hand) | Every company in the universe (US, actively trading, > $300M, ~2,870) → its GICS sub-industry. FMP's industry where it is fine enough (`configs/fmp_to_gics.yaml`); a one-time model classification among the listed candidates where it is not, with a "none_of_these" escape to all 163 when FMP's industry is wrong; Roy's review overrides on top |
| "fin_statements" | `fin-statements`, Tue–Sat | 15 years annual + 12 quarters per company, three statements merged, point-in-time on SEC acceptance |
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

## The week — the change scan and its assessments (step 6, 2026-10-11)

The weekly screen (`industry_screen`, 2026-10-08 → 2026-10-11: buckets from engine scores plus a dated-catalyst
Q11) was RETIRED when the assessment board replaced it (Roy, 2026-10-10). In its place, once per engine price run:

- **The change scan** (`api/strategy/changeScan.service.js`, code, no model) compares each sub-industry's and each
  approved theme's facts today with the facts FROZEN on its standing assessment, and flags what MOVED: the hype
  flag turning on or off, a month of ±10% against the S&P, the 12-month excess over SPY shifting 20 points, the
  stretch crossing its top or bottom decile, capex or buybacks turning (sign flip, at least 10%); plus an expired
  assessment, and never assessed. Since step 8 (pythia-money-flows.md), against the flows FROZEN on the
  assessment: an insider cluster starting, and federal contract money moving 25%+ on $1B+; since step 4
  (pythia-geopolitics.md), a mapped geopolitical risk touching the industry turning elevated. Not scanned yet:
  news volume, funds' crowding (shown, not scanned — no tested meaning yet), `change_view_if` (free text).
- **The run** (`services/pythiaWeekly.service.js`, monitor `pythiaWeekly.monitor.service.js`, opt-in
  `PYTHIA_WEEKLY`) assesses the flagged ones — biggest change first; never-assessed approved themes ahead of the
  never-assessed industries, those by the size of their 12-month move — ALL of them (Roy, 2026-10-11), stopping
  at `PYTHIA_WEEKLY_MAX_USD` ($3); `PYTHIA_WEEKLY_CAP` adds a count cap only if set. What a stop leaves waits for
  next week's scan, which still flags it. Each assessment carries why it ran (`trigger`), and the desk's turn is
  told. Booked to the first admin's ledger. A subject the desk refused (refused / no block) two weeks running is
  held back one week (`held_back`), then tried again. A week whose document has not moved for 30 minutes reads
  `interrupted` (its process died) and is resumed — by the next tick, or "Resume the week".
- **`pythia_weekly`** — one document per run date: what was flagged and why, each result (verdict, the one before,
  cost), what waits, the regime. 26 weeks kept. A week that died half-way is resumed on the next tick.
- Routes: `GET /api/strategy/weekly` (everyone; a trader's copy has no spend), admin `POST /weekly/run` (202 — it
  runs for many minutes; `force` reruns a finished week). Board: Forecasts → Assessed, the week line on top.
- Dry run: `node scripts/scan-week.mjs [cap]`. The first dry run (2026-10-11, run of 2026-10-07): 164 flagged,
  all never assessed. A sub-industry priced on its parent's basket (11 baskets cover ~29 sub-industries) is told
  the move is the parent's (`formatFacts`), and the board says "measured as <parent>".
- The engine job (`run_screener_timing.py` → `industry_timing`, `market_regime`) keeps running: it is the price
  input (§4.2) and the scan's price leg. `screenerData.service` keeps its reads only.

## The assessment — `industry_assessment` (build step 1, 2026-10-10)

> **Since 2026-10-31 — two verdicts** ([pythia-two-verdicts.md](../design/pythia-two-verdicts.md)): `verdict` is the
> NEAR TERM (swing · watch · avoid · no_case) and `long_term` is its own call (yes / no, with its thesis or reason),
> reviewed monthly for every industry and theme — a yes outside the measured structure carries her argument; a hype
> run flags a yes, never denies it. The long-term book (Argus, house labels, Atlas's sleeves) reads the long-term
> call; a NEW yes sends names down the chain. When the engine's price run is over eight days old, every admin gets
> one card and a daily due pass keeps the long-term reviews going on the old prices.

Contract: `docs/design/pythia-assessment.md`. Pythia judges whether an industry is **interesting to
trade, to invest in, to watch, or to avoid**, from five inputs (news and events, price action, money,
regime, geopolitics). It is a judgment, not a forecast, and the code holds it to guardrails:

- `checkAssessment` refuses a block without a verdict, horizon, thesis, news and price evidence, what
  caused the move (`none` is allowed and is a finding; `unverified` when the research could not be done — a
  failed search must never read as the hype finding), the second-order view, a risk, and what would
  change the view. Inputs beyond news and price that the desk leaves out are stored as `gaps` (only regime has no
  measured input yet).
- `factsFor` attaches the facts from the engine's screen row (`industry_timing.raw`, written by
  `run_screener_timing.py`): the 12- and 24-month return against SPY, the stretch, and the **hype flag**
  (up 100%+ in two years and 100%+ over the market) with its base rate (22% crashed vs 9%). The agent
  reads them through `get_industry_moves` and cannot override them.
- Every published verdict is logged as a call in **`pythia_calls`** (`pythiaCalls.service.js`): the
  sub-industry's largest companies and SPY / QQQ / RSP priced on the day, re-priced at 3 and 12 months
  by the daily grader (`monitoring/pythiaCalls.monitor.service.js`). Logged on a new verdict, or a
  reaffirmation after 28 days.
- Routes: `GET /api/strategy/assessments` (everyone; with the track record), `GET /assessments/:code`,
  `GET /calls`; admin: `POST /assessments/:code` (publish a chat draft), `POST /assessments/:code/run`
  ("Assess now", headless, returns `cost_usd`, the input to the weekly cap).
- Since step 6 (2026-10-11) the weekly change scan picks what is assessed (above); "Assess now" stays for an
  admin's one-off.
- **News** (§4.1): `get_industry_news` — the last month's news on the industry's 15 largest companies, one
  FMP call through the one news pipe (`news.service`, category `basket`, keyed `gics_<code>`), at most three
  stories per company; `get_news` for one ticker (FMP first, Finnhub fallback — Roy, 2026-10-11: FMP is the main
  news source), the front page (Finnhub) and topic search (GNews — small daily quota). `web_search` on Luna is a
  REAL web search since 2026-10-11 (OpenRouter's server tool); the GNews stand-in ran out of quota on the first
  live week and left 62 of 165 assessments `unverified` ("news not checked" on the board). `unverified` now
  needs the FMP news AND the search to have failed.
- **Money** (step 2, §4.3): the engine's industry-metrics job writes `money` on every node — companies'
  capex, buybacks, dividends and acquisitions, last four quarters vs the four before and the change a year
  earlier, share raising capex, capex intensity, median share-count change, top spenders.
  `get_industry_money` reads one industry, `get_capex_leaders` the market's biggest capex changes;
  `industryData.moneyFacts` attaches the facts to each assessment.
- **The rest of the money** (step 8, [pythia-money-flows.md](../design/pythia-money-flows.md)): insiders buying
  their own stock (90 days; a cluster is AWARENESS only — it failed a 20-year test), funds' 13F ownership against
  the market (crowding, a fact), federal contract money on the NAICS lines an industry sells into (the change).
  On `get_industry_money` (`industryData.formatFlows`), frozen on each industry assessment as `flows`
  (`flowFacts`), three rows on the board, and in the change scan.
- **Geopolitics** (step 4, [pythia-geopolitics.md](../design/pythia-geopolitics.md)): the Caldara–Iacoviello index,
  the world's and each mapped risk's intensity against its own ten years (ELEVATED at z ≥ 2), and the risks the
  reviewed exposure map says hurt or help an industry — read by `get_geopolitics` (`geopoliticsData.service`), frozen
  on each industry assessment as `geopolitics`, a board row, and the change scan. ATTENTION, not impact; the map's
  directions FAILED their history test (T3, judged on 2005–2025) and are shown as hypotheses.
- **Themes** (step 3, §3; `theme.service`, `themeData.service`): value chains of sub-industries by order
  (1 direct, 2 suppliers, 3 suppliers' suppliers). Pythia PROPOSES (`<theme_proposal>`, "Propose themes"),
  the admin approves or retires; only an approved theme is assessed — an `<industry_assessment>` carrying
  `theme`, its facts each link's moves and money, its call graded on the theme's basket. Tools `list_themes`,
  `get_theme`; routes `GET /themes` (traders see approved only), admin `POST /themes/propose`,
  `/themes/:id/status`, `/themes/:id/assess`. Board: Forecasts → Themes.
- First live costs on Luna: ~$0.004–0.006 per assessment, ~$0.006 per proposal run — before the web search. With
  OpenRouter's web search (since 2026-10-11) an assessment costs ~$0.014–0.015 (measured 2026-10-12/13), so the $3
  weekly ceiling buys about 200.

## The monitor — `monitoring/industryView.monitor.service.js`

Two loops, because they cost different things:

- **Sync (every 6h, Mongo only).** Seeds a `pending` view for every measured sub-industry, and brings a
  view forward when the engine raises a NEW trigger since its last review — revenue down two quarters,
  returns below the hurdle, margins at a 10-year range edge — unless it was reviewed in the last 30 days.
- **Review (hourly).** A due view (pending, scheduled — yearly, quarterly for a cyclical industry — or
  brought forward) gets a headless Pythia review (`services/industryReview.service.js`), **at most three
  an hour, and only when `INDUSTRY_REVIEWS=true`**. A review publishes, or records a pass (or a refused
  answer) on the trail and restarts the clock. It posts no card (2026-10-24, Roy: "Pythia —
  stop posting cards"): her answers are read on the Forecasts board. Off, nothing is spent and due views wait.

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
- **Argus, then Prometheus, by themselves** ([house-research-chain.md](../design/house-research-chain.md), 2026-10-23).
  After each completed week, every FOR SWING industry, and every NEW long-term yes (since 2026-10-31 a monthly
  re-confirmation sends nothing — [pythia-two-verdicts.md](../design/pythia-two-verdicts.md) §6), has its companies measured (code) and Argus picks
  the best 5 for her thesis; they go to Prometheus's queue (source `pythia`) and are researched automatically,
  inside a weekly $ budget, on a price-target horizon bound to her book. Replaced "the largest uncovered names"
  (open item 3 of [pythia-assessment.md](../design/pythia-assessment.md)).
- **Argus and Atlas's sleeves, as a preference** (2026-10-13, [argus-on-pythia.md](../design/argus-on-pythia.md)):
  a swing or long-term scan looks in her industries first (`get_house_industries`, `listForBook`); an Atlas sleeve
  takes names from her long-term industries in its sector first, up to half; a scanned or handed-over name carries
  the house label, worked out by code (`houseLabel.service`). Never a filter, never a score.
- **The companies she names** (2026-10-13, [pythia-names.md](../design/pythia-names.md)): an assessment may name up to six
  companies its evidence points at, each with why; code checks them against the universe and marks first or second
  order. Argus sees them first in an industry's companies, the house scan queues them first, a sleeve takes them first
  when its screen holds them, and they carry the house label.

## Open

- **Cost per review is unmeasured.** Measure one by hand before setting `INDUSTRY_REVIEWS`.
- **The code grades' thresholds** (e.g. "growing" = 2pp a year above the universe) are first guesses for
  the reviews to challenge.
- **Events** as an input to the three questions are parked (`horizons.md` §6).
- **Acquisitions** still inflate an acquirer's chained growth; noted, not modelled.
