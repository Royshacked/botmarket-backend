# Pythia assesses, it does not forecast — events, price, money, regime, geopolitics (2026-10-10)

**BUILDING.** Roy's design of 2026-10-10. Step 1 (the artifact, guardrails, forward log, grader and the board) is BUILT. Status per step in §12. It
replaces the forecasting half of `industry-screener.md` (the weekly buckets, §2–§5.3) and keeps
Pythia's three structural questions (`pythia-industry-questions.md`) as one of its inputs.

The one line: **Pythia gathers what is happening to an industry or a theme — the news and events, how
the price has taken them, where companies, funds and government are putting money, the macro regime and
the geopolitical risk — and concludes whether it is one for the swing book, for the long-term book, to watch, or to
avoid. Argus brings the names, Prometheus analyses them, Atlas allocates and manages the risk.**

---

## 1. Why — what the research proved

Between 2026-10-08 and 10-10 every way of FORECASTING which industries will lead was declared, built and
tested (`industry-screener.md` §5.1–§5.6; the record is there, each test written before its run):

| Tried | Result |
|---|---|
| Short-term timing — momentum filter, the combined buckets, 4–52 week holds, pullbacks, earnings gaps | All failed; several pointed backwards |
| Good + cheap as a hunting ground (GICS, 2017–25) | Passed by company count, carried by Regional Banks; one vote per industry: worked 2017–20, nothing 2021–25 |
| Regime chain: channels → regime → rule → industries, walk-forward | Failed; the low-inflation lesson of 2017–20 lost 16pp in 2025 |
| Channels × industries on Ken French's 49 industries, 1960–2025, no survivorship | Real in-sample (3× chance) — but a walk-forward model using it SUBTRACTED 2.8pp a year |
| Channels × rules | Nothing, even over 65 years |
| Hypes (98 run-ups since 1928) | A crash risk (22% vs 9%), not a timing signal |
| Supply-chain cascade (BEA customer links) | +2pp a year, t 2.5 — right direction, below the bar; blind to new themes |
| Rules alone (momentum, cheapness, customer demand), walk-forward | +2.7pp a year, t 2.6, faded since 2000 |

**Roy's conclusion (from his own quant and algo work, and these results):** nothing predicts the market.
The edge is (1) being aware of events and news, (2) knowing where the big money goes, and (3) reading
events differently from the crowd. Added in discussion: (4) size and manage risk, (5) log and grade every
call. This doc builds Pythia on that.

## 2. What Pythia becomes

| | Before (screen, 2026-10-08) | After (this design) |
|---|---|---|
| Question | "Which industries will do well?" | "What is happening here, how far has the price gone, and is it worth our attention?" |
| Verdict | CODE, from quality + timing scores | The AGENT's judgment, from five inputs, held to guardrails (§5) and graded forward (§7) |
| Unit | GICS sub-industry | Sub-industry AND theme (§3) |
| Structural questions (demand, economics, cycle) | The quality half of the score | One input among several; `industry_view` stays as is |
| Track record | None | Every verdict logged and scored against SPY and a baseline |

Pythia still never publishes a price target, a weight or a macro forecast.

## 3. The unit: industries and themes

Money and news increasingly move by THEME — AI, power for data centres, GLP-1, defence, reshoring,
nuclear, cybersecurity — and a theme crosses GICS: AI runs from software (IT) through chips and chip
equipment (IT), electrical equipment and construction (Industrials) to power producers (Utilities) and
copper (Materials). The research found the official link tables cannot see new themes (§5.5.3 there).

- **Theme registry** (`theme` collection; Pythia proposes, the admin approves — `status` proposed / approved / retired): name, one-line thesis, the
  sub-industries in its value chain with each link's ORDER (1 = direct, 2 = supplier, 3 = supplier's
  supplier), and a basket of up to 30 names.
- **Exposure from filings** (aether-engine `exposure/` — EDGAR full text, discovery, scorecards): which
  companies' 10-K/10-Q text and segment revenue tie them to the theme. That is how "AI up → power" is
  answered for THIS cycle, with company evidence, not a 2017 input–output table.
- An assessment is for an industry or a theme; a theme's assessment names its links in order.

## 4. The five inputs

Each input answers one question, has a source, and has things it may NOT claim.

### 4.1 News and events — "what happened, and what is scheduled?"

- **Have:** `web_search`; Aether's event pipeline (8-K / EDGAR event channels, the shock pipeline);
  `get_earnings_calendar`; the news intake.
- **Missing:** the GNews key on Render; per-industry and per-theme news volume (a count, for the change
  scan, §8).
- **Pythia's job:** separate the material (it moves revenue or costs, it has a date) from noise; name
  the second-order effect — who upstream benefits, who downstream pays.
- **May not claim:** that a headline means the price will move. Speed is the machines' game; the edge is
  in what the crowd misses and in reading it differently.

### 4.2 Price action — "how much has already moved?"

- **Have:** daily prices (Parquet history + the `daily_prices_recent` window), the industry baskets, 12-1
  strength against SPY, extension (2-year percentile), breadth — the screen's engine job.
- **Pythia's job:** state the move, as FACTS from code: the industry's (or theme basket's) return since
  the story started and over 12 and 24 months against SPY, its extension against its own two years, and
  the hype flag. A good story already up 80% is a different trade from the same story flat.
- **And what caused the move** (Roy, 2026-10-10) — Pythia ties it to the other inputs: news or an event
  (§4.1), money arriving (§4.3), the regime (§4.4), geopolitics (§4.5) — or nothing it can name, which is
  itself a finding (a move with no cause behind it is the hype pattern). **`unverified`** is a separate answer
  — the research could not be done (first live run, 2026-10-10: the news search at its daily limit) — so a
  failed search never reads as the hype finding.
- **Not Pythia's job — whether it is "priced in"** (Roy, 2026-10-10): that is close to unknowable at
  industry level. Expectations live in companies — estimates, guidance, how a stock took its last
  report — so **Prometheus** assesses them per name (§10). Pythia reports how far the price has gone,
  not what the market expects.
- **Guardrails it carries:** momentum reverses at turns (§5.4.2 there: −8 to −9pp in easing and stress);
  an industry in a run-up carries the hype flag (§5).

### 4.3 Where the money goes — "who is committing capital, and where does it land?"

The strongest input and the one most worth building. Four kinds of money, treated differently:

| Whose money | Signal | Source | Have? | Read as |
|---|---|---|---|---|
| **Companies** | Capex trend, buybacks, dividends, M&A, guidance | `fin_statements` (capex, repurchases, dividends — quarterly); 8-K deals; earnings calls | Capex and buybacks: yes. Guidance and calls: via `web_search` | Real commitments. **Follow the money to where it LANDS** — capex is the supplier's revenue. The spender's own stock often lags after a capex boom (the asset-growth effect) |
| **Funds and institutions** | Holdings changes by industry | SEC 13F (free, quarterly, ~45 days late) | Yes, since 2026-10-12 (step 8) | CROWDING, not a lead: who is already in. At extremes a warning, not a signal to follow |
| **Insiders** | Open-market buying, clustered | SEC Form 4 (free); as built, FMP's purchase feed | Yes, since 2026-10-12 (step 8) | Insider BUYING across several companies of an industry is the rare informative case; selling is mostly noise |
| **Government** | Contracts, subsidies, budgets, tariffs | USAspending.gov (free API); CHIPS, IRA, defence budgets, tariff schedules via news | Contracts yes, since 2026-10-12 (step 8); the rest via news | Dated, sized money with a beneficiary list — a theme's best friend and its policy risk |

Built engine-side as aggregates by industry and theme (§9), never as raw filings in Mongo.

### 4.4 Market regime from the channels — "what backdrop are we in, and what is the book exposed to?"

- **Have:** the monthly point-in-time channel tables (aether-engine `build_regime_history.py`, local, 30
  FRED series since 1996; `fetch_long_history.py`, since 1947).
- **Missing:** a light production job (the old channel engine was deleted 2026-10-05).
- **Pythia's job:** CONTEXT and EXPOSURE — "inflation above 3% with the Fed holding", "the cycle is late:
  capacity and production high", "rates are rising" — and which industries the backdrop has historically
  leaned on, labelled as history, not forecast.
- **May not claim:** that the regime picks industries. Measured: a channel tilt learned from the past
  subtracted 2.8pp a year out of sample (§5.6 there). Atlas uses the same channels to tell a user what
  their BOOK is exposed to.

### 4.5 Geopolitics — "what could hit this industry from outside the economy?"

- **Have:** `web_search`, news. *Since 2026-10-12 (step 4, [pythia-geopolitics.md](./pythia-geopolitics.md)): the GPR
  index and a reviewed exposure map of eight risks — BUILT; the map's directions failed their history test and are
  shown as hypotheses. The list below is the original design.*
- **Missing:** the Caldara–Iacoviello Geopolitical Risk index (free, monthly, since 1985; by country), and
  an **exposure map** (config): Taiwan → semiconductors and hardware; Red Sea / Hormuz → shipping, energy,
  chemicals; Russia–Ukraine → energy, grains, fertiliser, defence; China tariffs → retail, autos, solar;
  Middle East → oil, defence, airlines.
- **Pythia's job:** a short risk read per assessed industry: which live risks touch it, how hard, how
  near; and the industries a risk HELPS (defence, domestic substitutes).

## 5. Guardrails — so a conclusion is evidence, not a story

Every assessment must carry these, and `checkAssessment` refuses one that omits them (as the retired
screen's `checkScreen` refused an undated catalyst):

1. **How much has already moved** — the run-up and the extension (§4.2), from code.
2. **The base rates we tested**, attached by CODE, not recalled by the agent:
   - **hype flag** — 24-month return ≥ 100% and ≥ 100% over the market: crash within 24 months 22% vs 9%
     base; median 24-month excess −10.6% (§5.5.3 there);
   - **value-trap flag** — good + cheap for more than 24 months: −3.2pp (§5.2.13 there);
   - **customer demand** — the industry's customers' 12-month return (BEA links): +2pp a year, t 2.5;
   - **momentum at turns** — after easing or stress the momentum ranking reverses (§5.4.2 there).
3. **The second-order view** — named winners and losers up and down the chain.
4. **What would change the view** — checkable conditions (like `reopen_if` today), so the monitor can
   bring it back early.
5. **Confidence** — low / medium / high, with the input that sets it.

## 6. The conclusion — the `industry_assessment` artifact

One house document per industry or theme, through `houseArtifact.repo` (every change a revision):

- `subject` — `{ kind: 'industry' | 'theme', code | theme_id, name }`
- `verdict` — `swing` · `long_term` · `watch` · `avoid` · `no_case` (Roy, 2026-10-11). `watch` is a live question a dated
  event within six weeks decides — it carries `decides_by`, and the change scan reassesses it once that date passes;
  a watch without one is published as `no_case` (`watch_downgraded` says why). `no_case`: nothing worth attention
  now — the first full week had 122 of 165 on watch, 88 barely moving. Neither is graded right or wrong. (The verdict names the book; `interesting_trade` / `interesting_invest` until then, still read as these). A swing's horizon is weeks or months, a long-term one's years — the code holds the horizon to the book. **Both books are LONG ONLY (Roy, 2026-10-14):** a swing's cause must help revenue or costs; a negative catalyst is `avoid` or `watch`, never a swing. The 2026-10-14 heat map showed swings written on bearish theses (Mortgage Finance, Airlines, Reinsurance) that Argus and Atlas would read as buys and the grader would score backwards. A short side is a separate, later discussion
- `horizon` — weeks / months / years; `expires_at` (an assessment goes stale)
- `thesis` — two or three sentences
- `evidence` — one short entry per input (§4.1–4.5), each with its date
- `moved` (code: run-up, extension, hype flag), `base_rates` (attached by code), `second_order`, `risks`,
  `confidence`, `change_view_if`
- `money` (step 2: companies' own money), `flows` (step 8: insiders, funds, government) and `geopolitics` (step 4:
  the GPR reading and the mapped risks touching it) — facts frozen by code, industries only
- `structure` — the standing `industry_view` answer (demand / economics / cycle), read, not rewritten

The board shows the verdict in plain words with the thesis, the flags and the track record (§7).

## 7. The forward log and the grader

The only honest test of a judgment is forward: the model has read the past.

- **`pythia_calls`** — every PUBLISHED verdict: date, subject, verdict, horizon, the basket it refers to
  (the industry's liquid companies, or the theme basket), and two baselines frozen the same day: "no view"
  (all industries) and "rules only" (momentum + cheapness + customer demand, §5.6 there).
- **Grader** (weekly job): at 3 and 12 months, each call's basket against SPY, QQQ and both baselines —
  share of names beating SPY (one vote per industry) and equal-weight return. `avoid` is graded too: did
  it lag?
- **Read:** the board's track-record panel; Pythia's own prompt gets its record by verdict type, so a
  desk that is wrong about `swing` sees it.
- Small documents (one per call); no quota concern.

## 8. Cadence and cost

An LLM pass over 163 sub-industries and the themes every week is expensive. Two layers, as the retired
screen had (`needsAgent`):

- **Change scan (weekly, no LLM):** flags an industry or theme when something MOVED — the price
  (extension, a sharp relative move), the money (capex or buyback trend turning, a 13F shift, insider
  cluster, a government award), news volume, a geopolitical index jump touching its exposure map, or its
  assessment expiring / a `change_view_if` condition met. *As built (step 6, then step 8): in Node
  (`changeScan.service.js`), not the engine; the price legs, capex/buybacks turning, an insider cluster
  STARTING, contract money shifting 25%+ on $1B+; a 13F shift is shown but not scanned (no tested meaning);
  news volume, geopolitics and `change_view_if` are not scanned.*
- **Assessment (LLM):** only flagged subjects, capped per week; plus event-triggered runs between scans.
- **Cost per assessment, measured:** ~$0.004–0.006 on Luna before the web search (2026-10-10); **$0.014–0.015 with
  OpenRouter's web search** (2026-10-12/13, Regional Banks and Aerospace & Defense). At the weekly ceiling
  (`PYTHIA_WEEKLY_MAX_USD`, $3) that is about 200 assessments a week.

## 9. Data and storage

- The engine computes the aggregates (money by industry and theme, change-scan flags, base-rate flags);
  Mongo gets the small results. Raw 13F, Form 4 and USAspending pulls stay out of Mongo — the M0 quota
  (512 MB across all databases) is at ~353 MB.
- The research tables (`data/history/*`, French 49, BEA CSVs) stay local and feed the base-rate library;
  the base rates are refreshed by script, not live.

## 10. Hand-off — what each desk does with an assessment

- **Argus** reads `swing` / `long_term` subjects as its hunting ground (it has been
  paused since the tilt was deleted — this is its new input) and brings names: for a theme, the
  first-order names AND the second-order ones the assessment named.
  *Built 2026-10-13 as a PREFERENCE, not a filter ([argus-on-pythia.md](./argus-on-pythia.md)): Argus's swing /
  long-term scans and Atlas's sleeves look in these industries first; the "second-order ones the assessment named"
  wait on a `names` field (that doc's §3.6, not built).*
- **Prometheus** covers the names; the assessment's thesis and risks travel with them. **"Is it priced
  in?" is Prometheus's question, per name:** what the price implies against what the company can
  deliver, the consensus and its revisions, and how the stock took its recent reports (beat and fell /
  missed and rose — our earnings data holds 135k reports with the estimate beside the result since 1994).
- **Atlas** allocates and manages risk: industry and theme caps (no book a third in one industry), the
  hype flag as a sizing brake, and the channels as the BOOK's exposure ("you are long rates, long the
  cycle") — not as picks.
- **Axl** answers "is this industry interesting?" from the standing assessment.

## 11. What changes in what is built

| Built | Fate |
|---|---|
| `industry_view` (three structural questions) + its monitor | **Stays** — an input (§6 `structure`) |
| `industry_screen` + its monitor + `screenerData.service` buckets + the board's Trade-now tab | **Replaced** by `industry_assessment`; the engine timing job keeps running as the price input (§4.2) and the change scan's price leg |
| Q11 dated-catalyst rule | Folds into §4.1 — events must still be dated |
| aether-engine research scripts (`run_*` of §5) | Stay as the base-rate library's source |
| Argus house scan (paused) | Revived on assessments (§10) |

## 12. Build order

1. **The artifact, the guardrails and the forward log** (§5–§7) — before any new input, so every verdict
   is measured from the first one. Board: verdict + thesis + flags + track record.
   **Backend + engine BUILT 2026-10-10**: `industry_assessment`, `checkAssessment` / `factsFor`, `pythia_calls` +
   the daily grader, "Assess now", `get_industry_moves`; the engine screen job writes the 12/24-month moves
   and the hype flag. Benchmarks for "no view": SPY, QQQ and RSP (equal-weight S&P 500); the "rules only"
   baseline waits for the rules in production. **Board BUILT 2026-10-10**: "Assessed" on the Forecasts tab
   (frontend AssessmentView) — verdict groups, hype chip, cause, moves, base rate, evidence and gaps, risks,
   what would change the view, the track record, and "Assess now" for admins; driven in a browser as a
   trader and an admin (scripts/drive-assessment-ui.mjs). News: FMP company news for the industry's largest
   names (news.service `basket`). First live cost on Luna: ~$0.004 per assessment (before the web search; with it,
   ~$0.014 — §8).
2. **Money, companies** — capex and buyback trends by industry and theme from `fin_statements` (data in
   hand). Only companies' own money in this step.
   **BUILT 2026-10-10**: the engine's industry-metrics job adds `money` to every node (capex, buybacks,
   dividends, acquisitions — last 4 quarters vs the 4 before and the change a year earlier; share of companies
   raising capex; capex intensity; median share-count change; top spenders). Pythia reads it through
   `get_industry_money` and `get_capex_leaders`; the facts ride on each assessment and the board. First run:
   2,648 companies; capex rising most — Interactive Media +$103B, Software +$103B, Broadline Retail +$65B,
   Electric Utilities +$21B. Themes are step 3, so "by theme" waits for the registry.
3. **Themes** — the registry; Pythia proposes the first themes and the admin approves them; filings
   exposure through Aether's `exposure/` tools.
   **3a BUILT 2026-10-10**: `theme` (theme.service — proposed / approved / retired, value chain of measured
   sub-industries by order 1 direct / 2 suppliers / 3 suppliers' suppliers, each with why; terms; basket);
   Pythia's `<theme_proposal>` and "Propose themes" (admin); a theme assessment over the chain
   (themeFacts: each link's moves and money; hype when a direct link carries it), graded on the theme's
   basket; Themes tab on the board. First proposals (Pythia, $0.006): AI compute and cloud infrastructure;
   Electric grid expansion — awaiting approval. **3b next**: an approved theme's companies from filings via
   Aether's `discover_event_names.py` (headline + terms → named, filing-verified companies).
4. **Geopolitics** — the GPR index job and the exposure map.
   **DESIGN 2026-10-12:** [pythia-geopolitics.md](./pythia-geopolitics.md) — sources sampled (the GPR `.dta` files,
   44 country indexes, daily to a week ago), the map's first eight risks, T3 outlined, five decisions for Roy.
   **BUILT 2026-10-12:** the GPR job, the exposure map (accepted), T3 (FAILED — the map ships as hypotheses), and
   Pythia's wiring (`get_geopolitics`, frozen `geopolitics`, a board row, the scan).
5. **Regime job** — the light channel table in production, for context and Atlas's exposure read.
6. **The change scan and the weekly run**, replacing the screen; retire `industry_screen`.
   **BUILT 2026-10-11**: `changeScan.service` (pure: today's moves and money against the facts frozen on the
   standing assessment — hype on/off, ±10% month, 12-month excess shifting 20 points, the stretch crossing its
   deciles, capex/buybacks turning; expired; never assessed), `pythiaWeekly.service` + monitor (opt-in
   `PYTHIA_WEEKLY`; every flagged subject, ceiling `PYTHIA_WEEKLY_MAX_USD` $3 — Roy, 2026-10-11; resumable;
   refused twice → held back a week), `pythia_weekly`
   (one document per run date), each assessment carrying its `trigger`; the board's week line and "Run the
   week" (admin). Retired: `industry_screen`'s code, routes, monitor, prompt section, `<industry_screen>`
   parsing and the Trade-now tab — the collection's documents are still in Mongo (drop on approval). The scan
   runs in Node, not the engine (§9): its inputs are aggregates the engine already wrote, so it needs no new
   job. Dry run on 2026-10-11: 164 flagged, all never assessed (approved themes first); not yet run for money.
7. **Hand-offs** — Argus on assessments; Atlas caps and hype brake.
   **BUILT 2026-10-11** (Roy's choices: code picks names, 3 per industry, 30 a week; limits clamped in code with
   Avoid flagged; the cap per SUB-INDUSTRY): `houseScan.service` after each completed week (FOR SWING / FOR LONG
   TERM → research_queue, theme supplier links first, thesis and risks on the row — Prometheus's opening names
   them and asks whether the name is priced in); `industryLimits.service` in `_sizePlan` and a review's `add_item`
   (hype ×½, a third per sub-industry, Avoid needs the user's OK — asked before the write, checked by the batch
   route); `get_industry_views` (Atlas, Axl) carries the verdict and hype; a held industry newly Avoid or hype is
   a review trigger. A single-industry MANDATE (`concentration: "single_industry"`) lifts the cap (Roy, 2026-10-11);
   the user's own share counts are not reweighted; the OK for an Avoid add in a review is the user's, on the
   Accept card — the server drops one the model writes; "Update plan" saves before it deletes.
8. **Money, the rest** (later, after the board runs on companies' money) — Form 4 insiders, 13F funds,
   USAspending government awards, as engine jobs writing aggregates only.
   **BUILT 2026-10-12:** [pythia-money-flows.md](./pythia-money-flows.md) — insiders (weekly; the cluster FAILED
   its 20-year test, so it is awareness only), funds from 13F (quarterly, read against the market), federal
   contracts by NAICS (monthly), all three on `get_industry_money`, frozen on each industry assessment as
   `flows`, on the board, and in the change scan (crowding shown but not scanned yet).

## 13. Decisions for Roy

**Decided (Roy, 2026-10-10):** geopolitics stays a SEPARATE input (§4.5), not folded into news; companies'
own money (capex, buybacks, dividends, deals — §4.3) stays, beside funds, insiders and government;
"priced in" is Prometheus's, per name — Pythia reports how far the price has moved and what caused it (§4.2). The verdict words: `swing` · `long_term` · `watch` · `avoid` (Roy, 2026-10-11, replacing `interesting_trade` / `interesting_invest`). Themes: Pythia PROPOSES, the admin approves — a proposed theme is not assessed until approved. The FIRST themes too: no hand-picked starting list — Pythia proposes them when the registry is built. Money comes in two stages: companies' own money first (step 2), insiders, funds and government later (step 8). The weekly screen (`industry_screen`) stays visible until the assessment board replaces it at step 6 (done 2026-10-11).

**Open:**
1. ~~The weekly assessment cap~~ — DECIDED (Roy, 2026-10-11): every flagged subject, stopping at $3 a week
   (`PYTHIA_WEEKLY_MAX_USD`); `PYTHIA_WEEKLY_CAP` stays as an optional count cap, unset.
3. **Argus choosing the house scan's names** — LEFT FOR LATER (Roy, 2026-10-11). Step 7 starts with code picking
   each For swing / For long term industry's largest uncovered names (free, repeatable); an Argus run per industry
   (judgment, a paid run each) is the alternative. Roy decides once he has seen the code's picks.
   (Argus's own scans read the verdicts since 2026-10-13 — argus-on-pythia.md; the weekly house scan is unchanged.)
2. **A light assessment list** — BUILT 2026-10-13 ([assessment-light-list.md](./assessment-light-list.md)): 107 KB instead
   of 780, a row's detail read when it opens. The original note: LEFT FOR LATER (Roy, 2026-10-11). `GET /assessments` sends every assessment whole
   (165 of them ≈ 790 KB; ~9 s from Atlas to the laptop, the server answers in 0 ms — transfer, and compression does
   not help). The fix: the list carries only what a closed row shows (name, verdict, chips, horizon or decides-by,
   thesis — ~100 KB) and a row fetches its detail when opened (`GET /assessments/:code`, plus the theme equivalent).
   Not measured on Render, where Atlas is close.
