# Pythia assesses, it does not forecast — events, price, money, regime, geopolitics (2026-10-10)

**PROPOSED, nothing built.** Roy's design of 2026-10-10, written up for decision before any code. It
replaces the forecasting half of `industry-screener.md` (the weekly buckets, §2–§5.3) and keeps
Pythia's three structural questions (`pythia-industry-questions.md`) as one of its inputs.

The one line: **Pythia gathers what is happening to an industry or a theme — the news and events, how
the price has taken them, where companies, funds and government are putting money, the macro regime and
the geopolitical risk — and concludes whether it is interesting to trade, to invest in, to watch, or to
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

- **Theme registry** (`theme` collection, admin-edited, Pythia may propose): name, one-line thesis, the
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
  itself a finding (a move with no cause behind it is the hype pattern).
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
| **Funds and institutions** | Holdings changes by industry | SEC 13F (free, quarterly, ~45 days late) | No | CROWDING, not a lead: who is already in. At extremes a warning, not a signal to follow |
| **Insiders** | Open-market buying, clustered | SEC Form 4 (free) | No | Insider BUYING across several companies of an industry is the rare informative case; selling is mostly noise |
| **Government** | Contracts, subsidies, budgets, tariffs | USAspending.gov (free API); CHIPS, IRA, defence budgets, tariff schedules via news | No | Dated, sized money with a beneficiary list — a theme's best friend and its policy risk |

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

- **Have:** `web_search`, news.
- **Missing:** the Caldara–Iacoviello Geopolitical Risk index (free, monthly, since 1985; by country), and
  an **exposure map** (config): Taiwan → semiconductors and hardware; Red Sea / Hormuz → shipping, energy,
  chemicals; Russia–Ukraine → energy, grains, fertiliser, defence; China tariffs → retail, autos, solar;
  Middle East → oil, defence, airlines.
- **Pythia's job:** a short risk read per assessed industry: which live risks touch it, how hard, how
  near; and the industries a risk HELPS (defence, domestic substitutes).

## 5. Guardrails — so a conclusion is evidence, not a story

Every assessment must carry these, and `checkAssessment` refuses one that omits them (as `checkScreen`
refuses an undated catalyst today):

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
- `verdict` — `interesting_trade` · `interesting_invest` · `watch` · `avoid`
- `horizon` — weeks / months / years; `expires_at` (an assessment goes stale)
- `thesis` — two or three sentences
- `evidence` — one short entry per input (§4.1–4.5), each with its date
- `moved` (code: run-up, extension, hype flag), `base_rates` (attached by code), `second_order`, `risks`,
  `confidence`, `change_view_if`
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
  desk that is wrong about `interesting_trade` sees it.
- Small documents (one per call); no quota concern.

## 8. Cadence and cost

An LLM pass over 163 sub-industries and the themes every week is expensive. Two layers, as the screen
already does (`needsAgent`):

- **Change scan (engine, weekly, no LLM):** flags an industry or theme when something MOVED — the price
  (extension, a sharp relative move), the money (capex or buyback trend turning, a 13F shift, insider
  cluster, a government award), news volume, a geopolitical index jump touching its exposure map, or its
  assessment expiring / a `change_view_if` condition met.
- **Assessment (LLM):** only flagged subjects, capped per week; plus event-triggered runs between scans.
- **Cost per assessment is unmeasured** — measure one by hand before setting the cap (as for
  `INDUSTRY_REVIEWS`).

## 9. Data and storage

- The engine computes the aggregates (money by industry and theme, change-scan flags, base-rate flags);
  Mongo gets the small results. Raw 13F, Form 4 and USAspending pulls stay out of Mongo — the M0 quota
  (512 MB across all databases) is at ~353 MB.
- The research tables (`data/history/*`, French 49, BEA CSVs) stay local and feed the base-rate library;
  the base rates are refreshed by script, not live.

## 10. Hand-off — what each desk does with an assessment

- **Argus** reads `interesting_trade` / `interesting_invest` subjects as its hunting ground (it has been
  paused since the tilt was deleted — this is its new input) and brings names: for a theme, the
  first-order names AND the second-order ones the assessment named.
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
2. **Money, companies** — capex and buyback trends by industry and theme from `fin_statements` (data in
   hand); then Form 4, 13F, USAspending engine jobs.
3. **Themes** — the registry, the first five themes (AI, power, defence, GLP-1, reshoring), filings
   exposure through Aether's `exposure/` tools.
4. **Geopolitics** — the GPR index job and the exposure map.
5. **Regime job** — the light channel table in production, for context and Atlas's exposure read.
6. **The change scan and the weekly run**, replacing the screen; retire `industry_screen`.
7. **Hand-offs** — Argus on assessments; Atlas caps and hype brake.

## 13. Decisions for Roy

1. Verdict words: `interesting_trade` · `interesting_invest` · `watch` · `avoid` — or others?
2. Themes: who curates the registry — admin only, or Pythia proposes and the admin approves?
3. The first five themes.
4. The weekly assessment cap (after one assessment's cost is measured).
5. Does `industry_screen` stay visible until the assessment board replaces it, or go dark now?
6. 13F / Form 4 / USAspending: all three in step 2, or companies' own money first and the rest later?
