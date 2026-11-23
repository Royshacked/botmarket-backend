# Situation network: build plan

> The plan for `situation-network.md` (design + decisions, Roy 2026-11-23). Scope: **industries only**.
> Nothing here is built. Each step ends with its tests and a check before the next one starts.
> Pattern to copy: **Echo's pipeline** (a Node house job behind an opt-in flag, a forward test, its own
> collections: `services/echoPipeline.service.js`, `monitoring/echoPipeline.monitor.service.js`).

## 0. Before building

| Check | Why |
|---|---|
| Render has `GNEWS_API_KEY` | Q7: the dated news backbone. Memory says Render had none (2026-09) |
| Mongo headroom under the 512 MB M0 cap | new collections; measure `dbStats` on `test` + `axl_dev` |
| Flag `SITUATION_NETWORK=true` (opt-in, off by default) | same as `ECHO_PIPELINE` |
| Access list `SITUATION_USERS` (Roy, Marce user ids) | Q6: an allow-list, not the admin role. One helper `canSeeSituation(user)` used by the route, the Axl tool and the board |

## 1. Data model

One collection per kind, every document versioned by `run_id` (a run = one build or one update).

| Collection | One document per | Holds |
|---|---|---|
| `situation_states` | snapshot | the seven sections (§2 of the design), each item with as-of, source, fact/reading; the articles used |
| `situation_nodes` | node × run | question, options with probabilities, open/settled, dormant branch + signpost, lag, tree, resolve-by date, LLM reasoning + confidence |
| `situation_links` | link × run | from (node, branch) → to node, direction, size, lag, live or dead |
| `situation_dropped` | snapshot | the dropped questions, their options and reasons; the counts |
| `situation_industries` | industry × run | chance it wins / loses, expected bucket, agreement, the paths behind it; would-be entries (30 / 50 / 70%) |
| `situation_forecasts` | probability × run | the log the scorecard grades: who set it (LLM / Roy), the number, the resolve date, the outcome |
| `situation_outside` | event | events that hit one industry and no node: the industry, the source; promotable to a question |
| `situation_runs` | run | trigger (weekly / event + which), before → after per node, rounds to settle, LLM cost |

Old runs are kept for the scorecard; dead branches are pruned from the live view only.

## 2. Stage 1a: the state's data sections (code)

`services/situation/state.data.js`: regime (FRED / FMP), prices (`industry_index`, `daily_prices_recent`;
market 1/3/12-month returns, distance from high, 200-day, VIX, breadth; industries 1/3/12-month vs S&P, top and
bottom 10, the stretched), big money (the Pythia flows and capex through `industryData.service`), calendar
(FOMC dates, earnings, known deadlines). **Reuse, don't copy** (the shared-mechanism rule). Unit tests with
fixtures.

## 3. News feed

Reuse **Echo's intake sources** (`echoIntake.service.js`: Federal Register policy documents, Defense
contract awards, FMP general news) plus GNews. One fetcher, `services/situation/news.js`, dated, deduped;
every article a snapshot uses is stored on it. Unit tests.

## 4. Stage 1b: the state's reading sections (LLM)

Policy, stories and geopolitics, and open questions with options. One structured call
(`callAnthropicStructured`), prompt `prompts/situation_state.md`, model from `houseModels.service`. A
`checkState` refuses a section without dates and sources. **Measure the cost per build here** (`cost_usd`),
before the later steps multiply it.

## 5. Stages 2–3: questions → network (LLM + code)

- **LLM:** turn the questions into nodes: options, conditional probabilities (reasoning first, base rates
  where they exist, **3 runs → median**, a confidence tag), lags, signposts for dormant branches, links
  branch → node with direction, size and lag; and the dropped list with reasons.
- **LLM, on every update:** for each matched event, a logged choice: moves an existing option / a new option
  in an existing node / a new question. A woken branch writes its sub-questions.
- **Code:** rank by impact × uncertainty, **cap 20 open nodes** (a woken branch's open sub-questions count; when
  full, the lowest-ranked open node goes to the dropped list, flagged), settled nodes outside the cap; `checkNetwork`
  (options sum to 1, every link starts on a live branch, no orphan nodes, the cap holds, the counts add up).
- Tests: the checks, the ranking, the cap.

## 6. The update engine (pure code)

`services/situation/propagate.js`: path probabilities (product along the path), resolving a step (→ 100%,
siblings die, survivors renormalise), and **spread until settled** (changes < 1 point, ≤ 10 rounds).
**Splitting a node** (a partial resolution): the parts inherit its links and probabilities; the forecast log keeps the original. Heavy unit tests: the 9% example, a split, a resolve, a loop that settles, a loop that hits the cap.

**Needs Roy's call: how a link moves its target.** Proposal: a link adds a shift to the target option's
**log-odds**, weighted by the probability of the branch it starts from; the target's options are then
renormalised. Log-odds keeps every number between 0 and 100% however many links stack up.

## 7. Industry mapping

- **Exposure data (engine, Python, from the Parquet history):** each industry basket's sensitivity to the
  10-year, oil, the dollar and the S&P (betas on weekly moves), into `industry_exposures`. Foreign and
  China revenue from FMP geographic segments where available. **Not available: import share.** Say so in
  the prompt rather than guess.
- **Past reactions (engine):** each basket's move after a dated list of past events (2018 tariffs, oil
  spikes, rate shocks, 2022 invasion; the list declared before the run). Into `industry_reactions`.
- **LLM:** each branch → industries, direction + size bucket, with why, citing the exposure and reaction rows.

**Built (2026-11-23), and the event list DECLARED before any reaction was computed:**
- Sensitivities are computed in Node, each build, from data Render has: each `industry_index` basket's weekly
  returns over its ~2 years against the S&P (FMP `^GSPC`), and, on what is left after the market, against the weekly
  change in the 10-year (FRED DGS10, per +1 point), Brent (DCOILBRENTEU, per +1%) and the broad dollar (DTWEXBGS,
  per +1%), each with its t-statistic. No `industry_exposures` collection: nothing to keep in step.
- Past reactions, each industry against the average of all industries (so a day that lifts everything lifts nothing):
  - **Daily, from `industry_index` (2024-08 on), day 0 and days 0–5:** 2024-11-06 US election · 2025-01-27 DeepSeek ·
    2025-02-03 tariffs on Canada, Mexico, China announced · 2025-04-03 "Liberation Day" tariffs · 2025-04-09 the
    90-day pause · 2025-05-12 the US–China Geneva truce · 2025-06-13 Israel strikes Iran · 2025-06-23 US strikes Iran.
  - **Monthly, from the GICS industry returns 2007–2025 (aether `industry_returns_monthly.parquet`, seeded once by
    `aether-engine/scripts/seed_industry_reactions.py` into `industry_reactions`):** 2008-09 Lehman · 2014-11 OPEC
    holds output, oil collapses · 2016-11 US election · 2018-03 steel and aluminium tariffs · 2018-07 first China
    tariffs · 2019-05 tariff escalation · 2020-03 COVID crash · 2022-03 Russia invades Ukraine · 2022-06 the 75bp
    hike and CPI 9.1% · 2023-03 SVB.
- Not available: import share, and foreign / China revenue (per-company FMP segments; not wired). Said in the prompt.

## 8. Industry scores

Sum over all live paths: chance it wins, chance it loses, expected bucket, agreement. **Early warnings:** a woken branch gets one LLM call ("if true, how large, which industries?"); its effects sit beside the summed scores, never inside, and are logged and scored on their own. Log the would-be
entries at 30 / 50 / 70% and on a killing signpost (Q4). Tests on a small hand-built network.

## 9. The update loop

`monitoring/situationNetwork.monitor.service.js`, behind the flag:
- **weekly:** a full update (a new state partial + re-judge moved nodes); **monthly:** a full rebuild;
- **events:** calendar items on their date; signposts checked daily; news matched to nodes every 3 hours;
  nodes whose lag passed unresolved.
- **News → nodes: one cheap triage call per batch, as Echo does**, not embeddings: no new provider. The
  design says embeddings "may" be used; add them only if triage misses.
- The LLM re-judges only nodes that moved > 10 points and new open nodes.

## 10. Roy's review

An admin card (`postCard`) per update: the open nodes that moved > 10 points in the update **or since Roy
last reviewed them (the drift rule)**, the new ones, and every woken dormant branch, each with the LLM's
number and reason. Needs `situation_nodes` to keep each node's value at Roy's last review. Override from the card or the board; both numbers are logged; silence =
accept ("LLM, not reviewed"). Only Roy's account gets the card.

## 11. Scoring (the forward test)

- **Resolution:** a question past its resolve date is marked by the LLM from the news with its evidence;
  Roy can overturn it on the board. **Needs Roy's call:** is that enough, or does Roy confirm every outcome?
- Brier vs equal odds, calibration per bucket, industry long − short (≥ 60%) vs the equal-weight average of
  `industry_index` at 3 and 6 months; the plain-LLM control asked weekly, scored the same way. All as
  declared in the design (Q5). The **start date is written into the design the day it starts.**

## 12. Axl's voice

`get_situation` in `agentTools.registry.js` (the state summary, the open nodes, the industry scores, "why
X"), offered **only when `canSeeSituation(user)`**. Others get no tool and no mention in the prompt.
Update `tests/fixtures/agentTools.snapshot.json`.

## 13. The board (frontend)

A route behind `canSeeSituation`: the state, the trees, the cross-tree connections, the dropped list, the
industry scores, each number's history, the overrides. Built in the frontend, shipped as the bundle in
`public/`. **Needs Roy's call: the diagram library.** Mermaid draws it as the illustration did, but it is a
new frontend dependency (large); the other option is a plain hand-drawn SVG tree, which is more work.

## 14. Finish

Driven in the browser (Roy's and Marce's accounts see it, a third account sees nothing), the bug hunt and
conflict check, then the QA / CR / docs cycle. Then switch the flag on and declare the forward test's start.

## Order and checkpoints

| # | Step | Checkpoint before going on |
|---|---|---|
| 0 | Before building | key, headroom, flag, allow-list |
| 1–4 | Data model, state data, news, state LLM | Roy reads one real state of today |
| 5–6 | Network + engine | Roy reads one real network (the board can wait; a JSON / artifact view first) |
| 7–8 | Industries | Roy reads the industry scores and their paths |
| 9–11 | Loop, review, scoring | one week of updates on `axl_dev` |
| 12–13 | Axl + board | driven with both accounts and a third |
| 14 | Finish | QA / CR / docs, then the forward test starts |

## Built differently from the plan (for Roy, 2026-11-23)

1. **A link is weighted by how much its branch MOVED, not by its level** (§6, `propagate.js`). The model's numbers
   already take the sources' current state into account, so weighting by the level would count every link twice.
   Each node keeps an **anchor** (its numbers when last set, and each source branch then); a link adds
   `shift × (source now − source at the anchor)` to the target's log-odds.
2. **Trees are real:** a node may hang under one branch of a parent (`given`); its numbers are conditional and a path
   multiplies along it (the design's 9% example is a test). On the first live build the model hung no question under
   another; the 29 links carried the connections.
3. **Fixed models, not the house model setting:** the state and the network run on Opus 5.5 (as Echo's mapping does).
4. First live build (2026-11-23, laptop): state $0.37 (28 questions, 168 articles), network $1.01 (3 runs; 24 nodes:
   20 open, 4 settled; 4 dropped; 29 links).

## Calls Roy made (2026-11-23)

1. A link moves its target by a **log-odds shift**, weighted by its branch's probability, then renormalised (§6).
2. **The LLM resolves outcomes** from the news, with its evidence; Roy can overturn them on the board (§11).
3. The board draws with **Mermaid** (a new frontend dependency, accepted) (§13).
4. A **weekly LLM budget cap**; its number is set after step 4 measures one build's cost.
