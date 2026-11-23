# The situation network, widened: sector layer, industry layer, training

> Roy, 2026-11-23. **BUILT 2026-11-23** (§13; first live sector build on dev: 11 sectors, $4.53). It extends `situation-network.md` (the macro network, built and live
> 2026-11-23) and replaces its §7 (companies) with a layered plan. Decisions from the 2026-11-23 discussion
> are in §11; the questions still open are in §12.

## 1. Why

The macro network sees only what its news brings in, and its news is macro and geopolitics. A sector's own
story (drug pricing, FDA pace, bank regulation, power demand) does not reach it, so the sector's industries
are not scored at all. On 2026-11-23, prod scored 54 industries and **none in health care**: no branch on
the board was mapped to them.

| Source today | Asks for | Sector news? |
|---|---|---|
| Federal Register | tariff, export controls, sanctions, subsidy, critical minerals | only through those five terms |
| FMP general news | the whole market, at most 10 a day | only stories big enough for the general feed |
| Defense awards | large DoD contracts | no |
| GNews | 10 macro topics | no |

The fix is a layer under the macro layer, not a bigger macro prompt.

## 2. The layers

```
macro state     → macro trees           ┐
sector states   → sector trees          ┘ ONE network → industry scores
                                            ↓ only the industries the layer above flags (§8)
industry states → industry trees → company scores
```

- Each layer **describes its own level**, reads the summary of the layer above, and **outputs a ranking of
  the level below**.
- The **descriptions** flow down only. The **network** flows both ways (§5).
- Macro + sector together score industries. The industry layer is the company stage the first design
  deferred (`situation-network.md` §7); its sections (exposure, ability to absorb, big money, own story,
  prices, calendar, open questions) carry over unchanged.

## 3. Why separate states (option B), not one bigger state (option A)

| | A: one bigger state | B: macro state + sector states (chosen) |
|---|---|---|
| Prompts | one, everything in it | one macro + one small one per sector |
| The model reads | everything at once | macro alone, or one sector + the macro summary |
| Rebuilt | all of it, every run | only the sector with news |
| Cost | grows with every sector, every run | follows the news |
| A bad answer | spoils everything | spoils one sector |
| Forward test | the macro input changes | the macro input stays exactly as it started |
| Sector → macro | hidden inside one description | through links and promotion, visible and graded |

## 4. The sector layer

### 4.1 Sectors, not industries

- **Described by sector** (GICS: 11). Enough news per sector to be worth a state; a story that hits several
  industries (drug pricing: pharma, biotech, managed care) becomes **one** question, not three.
- **Asked and scored by industry.** A sector state's questions may be industry-specific ("FDA approval pace"
  for biotech, "PBM reform" for managed care), each mapped to the industries it touches.
- **Split a busy industry out** into its own state when it dominates its sector's news or questions
  (likely early: semiconductors inside tech; banks vs insurers inside financials). The same idea as the
  node split (`situation-network.md` §11.10), one level up.

### 4.2 A sector state

| # | Section | Contains | Written by |
|---|---|---|---|
| 4.2.1 | The backdrop | a short summary of the macro state | code (from the macro run) |
| 4.2.2 | Prices | the sector's industries vs the market and each other (`industry_index`) | code |
| 4.2.3 | Its news | the sector's own feed (§4.3), dated, stored with the snapshot | the model |
| 4.2.4 | Its policy and rules | regulation, agencies, court cases, pending rules | the model |
| 4.2.5 | Its calendar | sector dates (FDA decisions, rule deadlines, big earnings, conferences) | code + model |
| 4.2.6 | Open questions | the 1–3 that decide which of its industries win or lose | the model |

The hindsight rule holds: nothing after `asOf`, and every snapshot stores the articles it read.

### 4.3 News per sector

- **GNews:** one or two topics per sector, e.g. health care "drug pricing FDA Medicare", "pharma biotech
  policy". The free plan allows about 100 queries a day; 11 sectors × 2 fit beside the 10 macro topics.
- **Federal Register:** the network's **own** terms per sector (for example drug pricing, Medicare, Food
  and Drug Administration), passed in by the network. Echo's five terms are Echo's and are not changed.
- **FMP:** news on the sector's largest tickers.
- **Triage** wakes only the sector the news touches.

### 4.4 Sector trees and caps

- Each layer has **its own cap**: macro stays at 20 open questions; sectors about 2–3 each, about 30 in all.
  Sector questions never push macro questions out, or the reverse.
- The dropped questions are counted and shown **per layer**.
- Settled nodes, dormant branches, signposts, the drift rule and the new-question rule work as in the macro
  layer.

## 5. One network: links in three directions

| Direction | Example |
|---|---|
| Macro → sector (most) | "Fed hikes" raises "biotech funding dries up"; "Brent above $100" raises "airlines cut capacity" |
| Sector → sector | "AI capex keeps flowing" raises "utilities sign data-centre power deals" |
| Sector → macro (rarer) | "regional bank failures" raises "the Fed cuts" |

- The machinery already handles this: links are branch → option, spreading runs until nothing moves by
  more than 1 point (10 rounds at most), and the Monte Carlo draws linked branches together.
- **Fewer, stronger links.** Links are proposed only for new questions against the rest, and only strong,
  explainable ones are kept; otherwise everything nudges everything.
- **Loops** (AI unwind → market falls → AI financing dries up → AI unwind) are capped by the spreading
  rounds, and shown on the board.

### 5.1 Promotion

A sector question that starts moving **many industries, or the market question itself**, moves up to the
macro layer (example: Nvidia's governance crisis, 2026-11). It then counts against the macro cap and is updated by
the macro call. The threshold is open (§12).

It keeps its **origin** (the sector it was born in): it is graded, and counted in or out of "macro alone", by its
origin, so the comparison of the layers stays clean (Roy, 2026-11-23).

## 6. Scoring

- Industry scores come from the one network: 5,000 paths through macro + sector branches, as today.
- **Graded per layer**, so the edge (if any) can be located:
  - questions by Brier score, **per layer**;
  - industries against the equal-weight basket, **macro-only vs macro + sector**: the macro-only score is
    computed alongside, from the macro branches alone, for as long as both exist;
  - companies (§8) against their own industry.
- The macro layer's forward test keeps its input, its prompt and its pass rule.

## 7. Cost and the board

- Rough guess: the weekly cost goes from about $1 to $2–3; the $10 weekly cap holds. Only sectors with news
  are rebuilt.
- The Mermaid board gets a **filter**: macro only / one sector with its macro parents / everything.

## 8. The industry layer (companies)

- An industry state is built **only for industries the layer above flags**: a high chance of winning or
  losing, or a would-be entry crossing 30 / 50 / 70%. With 74 industries, perhaps 5–10 at a time.
- It reads the macro and sector summaries, its own news, earnings calendar and price action, and company
  data (Prometheus coverage, the Pythia money data, Proteus' profile).
- Its trees ask company questions ("Does Lilly's GLP-1 share hold?"); its output is company scores.
- Company evidence flows back up as signposts (many companies in an industry missing).

## 9. Training

The LLM's weights stay fixed. The layer around it trains, in the order the data arrives:

| # | What | Learns from | Needs |
|---|---|---|---|
| 1 | **Calibration** — a correction curve on the model's probabilities | resolved questions: what we said vs what happened | a few hundred resolutions |
| 2 | **Industry effects** — measured sizes replace the mapping's guessed buckets | real industry moves after a branch happened | each branch that resolves |
| 3 | **Link strengths** — strengthen links that held, weaken or drop the rest | linked questions resolving together | pairs of resolutions |
| 4 | **Memory** — past resolved questions as base rates in the prompt (retrieval, not training) | the resolution log | from the start |
| 5 | **Roy's overrides** — more or less weight on his calls by question type | override vs model vs outcome | overrides that resolve |

- **Slow data.** About 5–10 resolutions a month on the macro layer; the sector layer adds questions and
  speeds this up. Calibration means something after 6–12 months.
- **Recent data counts more** (a rate-hiking year misleads a cutting year).
- **Only stored snapshots** are training data (the hindsight rule).
- **Each trained piece is tested forward** before it is switched on.
- **Recorded from day one** (most already is): every probability with its run and date, every resolution,
  every link and its shift, every branch's mapped effects, every override, and the industry prices at
  call and at grading.

## 10. What is ours (if it works)

- **Easy to copy:** the idea, the architecture, the prompts. Prediction markets (Kalshi, Polymarket) already
  price many of the macro questions — a benchmark worth adding as a control (§12).
- **Hard to copy:** the dated, graded forward record (cannot be backfilled); the calibration data; the
  measured branch → industry effects; Roy's review record; the chain from macro to a monitored trade.
- **Keep secret:** prompts, mapping data, weights. **Show:** the reasons per name and the track record.
- This depends on discipline: no backfilling, and no unlogged prompt changes during a test.

## 11. Decisions (Roy, 2026-11-23)

1. Widen with a **sector layer** under the macro layer.
2. **Option B:** separate sector states; the macro state is not widened.
3. **Sectors** (GICS 11) for states; **industries** for questions and scores; split a busy industry out.
4. **One network** across layers; links in all three directions.
5. Sector news affects macro through **links and promotion**, not through the macro description.
6. The industry layer is the company stage, built for flagged industries only.

## 12. Open questions

1. **When:** now, with per-layer grading from day one, or after a few weeks of macro-only results?
2. **Caps:** 2 or 3 open questions per sector; 30 in all?
3. **News per sector:** the GNews topics and Federal Register terms for each of the 11 sectors.
4. **Promotion threshold:** how many industries, or how large a move on the market question?
5. **Split threshold:** when does an industry get its own state?
6. **Flagging for the company layer:** which chance or crossing, and how many industries at most?
7. **Prediction markets as a control:** compare our macro probabilities with Kalshi / Polymarket where the
   question matches?
8. **A "sector signals" line in the macro state:** later, once the macro baseline has a few weeks behind it?

## 13. Build plan (Roy, 2026-11-23: "let's go for it")

The macro layer's forward test began the same day, so it may change (Roy: "nothing to damage"). The §12 answers
below are Claude's DEFAULTS, built as constants Roy can overturn:

| §12 | Default |
|---|---|
| 1 When | now; per-layer grading from day one |
| 2 Caps | 3 open per sector, 30 across all sectors; macro stays 20 |
| 3 News | two GNews topics and two Federal Register terms per sector (`sectors.js`); FMP news on each sector's 8 largest names (`gics_companies` by market cap) |
| 4 Promotion | a sector question whose branches move industries in 3 or more sectors moves to the macro layer |
| 5 Split | not automatic yet: a split is a new entry in `sectors.js` (an industry code instead of a sector) |
| 6 Company layer | not in this build |
| 7 Prediction markets | not in this build |
| 8 Sector signals in the macro state | no |

Steps:

1. **Sectors** — `services/situation/sectors.js`: the 11 sectors (code, name, GNews topics, Federal Register
   terms), `sectorOf(code)`, the largest names per sector. `SITUATION_SECTORS` (on by default with the network).
2. **Records** — a node's `layer` (`macro` or a sector code); `layer` on dropped items and forecasts; an
   industry's macro-only chances; the sector state record; run kind `sectors`.
3. **Store** — `situation_sector_states` (one per run and sector), saved and read with the run.
4. **News** — Echo's `policy` reader takes its terms as an option (Echo's own five stay its default);
   `fetchSectorNews(sector)`.
5. **Sector state** — `sectorState.js` + `prompts/situation_sector_state.md`: the macro summary (code), the
   sector's prices (code), its news, policy, calendar and 1–6 candidate questions (the model).
6. **Sector network** — `buildNetwork` per sector with the sector cap and layer; cross-layer links by
   `linksFor` over every live node; caps per layer; promotion.
7. **Build** — the full build makes both layers; a head with no sector layer gets one added (`sectors` run).
   Mapping per layer; industries scored over all branches AND over macro branches alone.
8. **Update** — the macro update as before plus one call per sector with news; triage names the layers an
   article touches; an event update runs only those.
9. **Scorecard** — Brier per layer; industry long − short for macro + sector and macro alone.
10. **Board** — a layer filter on the network and questions; the sector states; dropped and caps per layer;
    the scorecard per layer. Axl's tool says the layer.
11. Tests, docs, a live build on dev, a browser drive, then commit.

### 13.1 The first live run (dev, 2026-11-23)

- $4.53: the sector states and networks $3.73, the mapping $0.81. All 11 sectors built; 20 links cross layers.
- 85 industries scored (the macro layer alone: 54). Biotechnology: wins 36%, loses 21%; the macro layer alone: no view.
- 5 sector questions were promoted to the macro layer (3+ sectors reached), e.g. Alphabet and Meta capex, AI data-center
  spending cuts, US gas storage, existing-home sales. Roy, 2026-11-23: keep 3 for now and watch the promotions for a few weeks; if small stories crowd the macro layer, raise
  it to 4 or also require a link to the market question.
- Some sector questions were single-company events (the Super Bowl audience, Netflix guidance): the sector prompt now
  asks for the INDUSTRY's question.
- GNews refused 5 of the 22 topics (too many requests a second, three sectors at once): the provider now spaces every
  GNews call 1.1 s apart, process-wide.
- The weekly budget ($10) counts scheduled runs: the week a network is built and then layered spends about $7 of it, so
  event updates may wait for the next week.

### 13.2 The weekly rewrite and the origin (Roy, 2026-11-23: "a real fix, not a plaster")

- **The gap.** A description was written in full only at the build and the monthly rebuild. In between, the weekly
  update refreshed the code's numbers only, and an event update changed nothing. So the network moved every week and its
  description did not: a question added by an update, or promoted from a sector, had no story behind it in the
  picture. (A one-time copy of a promoted question's evidence was considered and rejected: it fixed one way in and left
  the others open.)
- **The fix.** Every WEEKLY update rewrites the descriptions: the macro one (`state.rewriteState`) from the week's
  macro news and the live macro questions with their reasoning, promoted ones included; then each sector's
  (`sectorState.rewriteSectorState`) under the new macro backdrop, from its news and its live questions. A failed
  rewrite keeps the old readings with fresh numbers, and says so in the run's gaps. About $1 a week more.
- **Why it matters although the updates do not read the description:** the sector backdrops are cut from it, the
  plain-LLM control is asked from it, and the board is how Roy sees the way the network thinks.
- **The origin.** A promoted question lives and updates in the macro layer but keeps `origin` (its sector): forecasts
  are graded by origin and "macro alone" counts only questions born macro. The board marks it "from <sector>".
