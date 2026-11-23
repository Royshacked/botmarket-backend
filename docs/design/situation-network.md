# The situation network: from "what is now" to "what is next"

> Roy, 2026-11-22/23. **BUILT 2026-11-23** (all 15 plan steps; pushed, off until SITUATION_NETWORK=true). Scope: industries only (§7 deferred, §11.8). **Forward test start: not yet** — write the date here the day it starts. A clean start; it does not lean on the industry
> tests or the desks, except where §9 names a piece to reuse.
> Illustration: the end-of-2024 network (artifact "Situation network, 31 Dec 2024").

## 1. Why

Our own tests say that what is already known (technicals, fundamentals, industry momentum, seasonality)
gives no edge (`industry-screener.md` §5, `industry-seasonality.md`). Edge has to come from **asking what
is next**. To simulate the alternatives for what is next, we first **describe the current situation**,
then grow the possible futures from it as a network of events with probabilities, and read off which
industries, then which companies, the futures point to.

Professionals work this way informally: second-level thinking (Marks), scenario trees in macro funds,
causal templates (Bridgewater), geopolitical scenario dashboards (BlackRock), forecasting with scoring
(Tetlock, Good Judgment). A written, scored, LLM-built network for picking industries is not standard.

**Not in scope:** "what is priced in". Roy, 2026-11-23: it cannot be answered. Prices enter only as
context (§2.5), never as a signal.

## 2. Stage 1: the current state (the macro prompt)

A dated, frozen snapshot written once per update. Everything after it is grown from this snapshot only.
**US-centred**, with the rest of the world as context.

| # | Section | Contains | Made by |
|---|---|---|---|
| 2.1 | Regime | growth, inflation, rates, dollar, oil, gold: a level and a direction. US first; Europe, China, Japan as context | code (FRED, FMP, engine) |
| 2.2 | Policy | central banks (last decision, guidance), fiscal policy, trade and tariffs, regulation | LLM from dated news |
| 2.3 | Big money | fund flows, corporate capex plans, central bank gold buying, insider buying, crowded trades | code + LLM |
| 2.4 | Stories and geopolitics | the active themes and conflicts; each with a short state, its maturity and who is exposed | LLM |
| 2.5 | Prices | market (S&P 500, Nasdaq, Russell 2000: 1/3/12-month returns, distance from high, 200-day, VIX, breadth); industries (1/3/12-month vs S&P, top and bottom 10, the unusually stretched, trend); the few index-moving companies | code (`industry_index`, `daily_prices_recent`, FMP) |
| 2.6 | Calendar | known events in the next 3–6 months, with dates | code + LLM |
| 2.7 | Open questions | the questions the network is grown from (§3) | LLM |

Every item carries an **as-of date** and a **source**, and is tagged **fact** or **reading**.
Output: a fixed JSON schema plus a short text version.

**Refresh:** a full rebuild monthly; a partial update on a major event (Fed decision, tariff move, war),
touching only the sections the event changes. Every version is kept.

**Hindsight trap:** an LLM building a past snapshot knows what came next. Past snapshots are for shaping
the format only. **Scoring is forward only** (Roy, 2026-11-23).

## 3. Stage 2: questions and nodes

- Every question is a **node with 2–4 options** (branches). Nothing is fully settled.
- **Open node:** no option dominates (for example 30/45/25). Fully expanded. **The cap of 20 applies to
  open nodes only**, ranked by impact on industries × uncertainty.
- **Settled node:** one option dominates (for example 85/15). It stays in the network as a link in the
  chain and does not count toward the cap. Its main branch is expanded; **its minority branch is kept
  dormant** with a probability and a signpost, and is expanded when the signpost fires. (Roy: the obvious is
  kept, since a chain of probable steps can end in a conclusion nobody has put together; and a settled
  question still has two branches.)
- **Dropped list:** every question considered and not kept, with its options and a one-line reason (low
  impact, duplicate of #n, too far out), plus the count ("37 considered, 20 open, 9 settled, 8 dropped").
  Re-checked at every update. A question moving in or out is flagged.
- **New question or new option? (Roy, 2026-11-23, from the January 2025 replay.)** On every update, each
  matched event gets an explicit, logged decision: (a) it moves an existing option, (b) it is a **new option**
  in an existing node, or (c) it is a **new question**, with its options, then kept or dropped like any other.
  Folding an event into an existing node must be a visible choice, not a silent one. (The replay's week 2
  folded "tariffs rising 2–5% a month" into "how broad", though speed is its own question, and treated the
  Russia oil sanctions as "oil up" with no question of whether they work.)
- **A woken branch opens new questions.** When a dormant branch's signpost fires, it is expanded: its own
  sub-questions are written (in the replay's week 3, "China AI leap" → does it cut AI capex, hit semis, help
  software users). Those that are open **count toward the cap of 20**; if the cap is full, the lowest-ranked
  open node moves to the dropped list, flagged.

## 4. Stage 3: the network

- **Trees** are a reading device: one per starting move (tariffs, the Fed, AI, geopolitics, trust in the
  US, China/Japan). Underneath there is **one network**.
- **Branch:** an option with a conditional probability (given its parent) and a **lag** (how long until it
  resolves or shows).
- **Connections run branch → node**, across trees: an Iran *strike* raises "inflation rises", while an Iran
  *deal* lowers it. A connection is live only while its branch is alive. It carries a direction, a size (how
  much it moves the target's probability) and a lag.
- **Shared nodes** (inflation, 10-year, dollar, oil, gold, US growth) are reached from several trees. Where
  many paths agree on a shared node, that is a high-conviction call even when the path is unknown.
- **Loops** are allowed (inflation → Fed holds → Fed under attack → money leaves → weaker dollar →
  inflation). The update engine must handle them (§11).
- **Chronology:** starting moves → fast reactions (days–weeks) → middle effects (months) → slow results
  (6–18 months). Markets move on the first step; the economy on the later ones.

**Size:** a few thousand nodes and links at most: a few MB, milliseconds to propagate. Render is enough. The
limits are LLM spend and the 512 MB Mongo cap (prune dead branches, keep versions).

## 5. Path math and updating

- A path's probability is the product of its conditional branches (0.85 × 0.25 × 0.75 × 0.55 ≈ 9%). All
  end points of a tree sum to 100%.
- When a step **resolves**, it becomes 100%. The other branches die, and the remaining paths are recomputed.
- How a step resolved also **revises the steps after it** (harsher tariffs than expected → retaliation 75% → 90%).
- An event **propagates** along every live connection it touches, in any tree.
- Matching news to nodes may use embeddings (headline → nearest nodes). The network itself stays explicit
  and readable. It is a Bayesian network (causal graph) with an LLM as estimator, not a neural network.

## 6. Stage 4: industries

- Every end point and branch carries industry effects (+ / −, with a size).
- **Per industry, summed over all live paths, never only the most probable one:**
  chance it wins, chance it loses, expected effect, and **agreement** (how many paths point the same way).
- **Output:** "Gold: wins in 70% of paths, ~+X% expected over 6 months. Depends on T1.2c and T5.
  Signpost that kills it: tariffs rolled back."
- **Split industries** (for example 40/45) get no call.

## 7. Stage 5: companies (a second prompt)

For each industry the network points to, the network continues to companies, from a **new current state at
company level**:

| # | Section | Contains |
|---|---|---|
| 7.1 | Exposure to the branch | how much of revenue, costs and supply chain the branch reaches (China imports, data-centre revenue, oil as an input) |
| 7.2 | Ability to absorb | pricing power, margins, debt, balance-sheet room |
| 7.3 | Big money | insider buying, fund holdings, buybacks, the company's own capex |
| 7.4 | Its own story | products, management, legal and regulatory issues, place among competitors |
| 7.5 | Prices | the company's moves vs its industry and the market |
| 7.6 | Calendar | earnings, guidance, launches, debt maturities |
| 7.7 | Open questions | the 2–3 that decide whether this name wins or loses under the branch |

Fundamentals are used here as **sensitivity to the branch**, not as a signal on their own. Company nodes can
connect to other branches (through suppliers and customers), and company evidence flows **back up**: many
companies in an industry missing is a signpost for the macro branch.

## 8. Acting on it

Waiting for certainty costs price: the market reacts to every step as it resolves. **Scale in** as a path
firms up (illustrative: under 30% watch; 30–50% starter; 50–70% add; over 70% full or hold; a killing
signpost fires: exit). Each resolved step is a trigger to resize. The thresholds come from the scorecard
over time, not from guesses.

## 9. Learning (scoring)

- Every probability is logged with a resolution date; scored on resolution (Brier score).
- **Calibration:** did the "30%" calls happen about 30% of the time? Fit a correction on the record.
- **Link strengths** are learned from how often and how fast effects followed causes.
- The LLM improves without retraining: its scored record goes back into the prompt.
- Feedback is slow: use many small, short-dated questions as well as the big ones. Expect a year or more
  before calibration means anything.
- The forward test's scoring rule is **declared before it starts** and does not change during it.

**Reuse candidates:** Echo (supply-chain reach, the forward-test pattern), Prometheus coverage (the company
view), the Pythia money data (insiders, funds, capex), `industry_index` and `daily_prices_recent` (prices),
the Prometheus scorecard pattern (commit, then grade).

## 10. Decisions so far (Roy, 2026-11-23)

1. US-centred.
2. Cap of 20 open nodes; the dropped questions and their count are always visible.
3. Forward-only scoring; past snapshots only to shape the format.
4. No "priced in" section.
5. Settled nodes are kept as chain links, outside the cap; their minority branch is dormant, not deleted.
6. Industries are scored over all paths, not the top path.
7. Companies are a second stage with their own current state.

## 11. Open questions — all decided 2026-11-23 (company stage deferred)

1. ~~How the LLM estimates each probability, and Roy's part in it.~~ **Decided (Roy, 2026-11-23): option b.**
   The LLM sets every probability (reasoning first, base rates where they exist, several runs → median, a
   confidence tag). Roy reviews only the open nodes (~60 numbers on the first build), then only open nodes
   that moved by more than ~10 points plus new ones. **Drift rule (Roy, 2026-11-23, from the replay):** the
   card also shows any open node that moved more than ~10 points **since Roy last reviewed it**, however
   slowly (the replay's "inflation rises" went +5, +6 over two weeks and never tripped the per-update line),
   and every **woken dormant branch**. Silence = accept, logged "LLM, not reviewed". An
   override keeps both numbers. The scorecard grades three groups: accepted, overridden (the LLM's number),
   and Roy's overrides. Settled nodes, dormant branches and connection sizes are the LLM's unless Roy flags one.
   **For later (Roy):** discuss a second model reviewing the probabilities.
2. ~~What triggers an update, and how far it propagates.~~ **Decided (Roy, 2026-11-23):** a **weekly
   update plus events**. Events are scheduled releases and deadlines, signposts firing, unscheduled news
   matched to nodes above a threshold, and nodes whose lag passed unresolved. Propagation runs **until it
   settles** (changes under ~1 point; a cap of ~10 rounds stops loops). It is code; the LLM re-judges only
   nodes that moved more than ~10 points and new open nodes. The monthly full rebuild of the state (§2) stays.
3. ~~How a branch maps to industries, and how effect sizes are set.~~ **Decided (Roy, 2026-11-23):** the
   LLM maps each branch to industries **from exposure data** (import share, China revenue, oil as a cost,
   rate sensitivity, foreign revenue — supplied by code) **and past reactions** (how each industry moved after
   similar events: the 2018 tariffs, oil spikes, rate shocks), and says why. Effects are a **direction plus a
   size bucket** (small / medium / large), no % yet. Scored on direction first; numbers only once the buckets
   prove calibrated. Still the weakest link: earlier industry calls failed, though from known data, not events.
4. ~~Entry rules.~~ **Decided (Roy, 2026-11-23): no trades yet.** The system makes calls and scores them,
   with no positions. It logs what entries **would have been**, at an industry's chance it wins (summed over
   all paths, not a single path) crossing 30, 50 and 70%, and when a killing signpost fires. Thresholds and
   sizes (§8) are set from that record later.
5. ~~The forward test.~~ **Decided (Roy, 2026-11-23), fixed before the start:**
   - **Nodes:** Brier score on every resolved question against an equal-odds baseline (½, ⅓, …); calibration
     per bucket (0–20%, 20–40%, …).
   - **Industries:** "long" = chance it wins ≥ 60%, "short" = chance it loses ≥ 60%; long minus short, each
     against the equal-weight average of all industries, at 3 and 6 months.
   - **Control:** the same LLM asked directly "which industries win in the next 6 months?", with no network,
     scored the same way.
   - **PASS when ALL hold:** (1) Brier better than equal odds on ≥ 100 resolved questions; (2) calibration
     within ~10 points in every bucket with ≥ 15 questions; (3) industry long minus short positive at 6 months
     with t ≥ 2; (4) the same sign in both halves of the period; judged after **12 months minimum**. The
     control comparison is reported beside it (the network must beat the plain question to be worth it).
   - Failing 3–4 = it describes the world but does not pick industries; failing 1–2 = the probabilities are poor.
6. ~~Where it lives.~~ **Decided (Roy, 2026-11-23):** a **house job**: a weekly cron plus an event watcher
   build the network in the engine; shared research, the same in all three workspaces. **Separate from Pythia
   for now.** **Axl is its voice** (a tool: "what's the situation?", "why gold?"). An **admin-only board**
   shows the diagrams and every probability (the state, the trees, the cross-tree connections, the dropped
   list, the industry scores and how each number moved), so Roy can see how it thinks. The open-node review
   (Q1) arrives as an admin card.
   **Access during the forward test (Roy, 2026-11-23): Roy and Marce only.** Both get Axl's voice and the
   board with its diagrams. Every other user has no access at all: no tool, no board, no mention. Marce is a
   trader, not an admin, so access is an **allow-list of users**, not the admin role. The open-node review card
   stays Roy's.
7. ~~Dated news.~~ **Decided (Roy, 2026-11-23): both.** A dated news API (GNews, which the engine already
   uses, and/or FMP news) is the backbone: the event watcher matches it to nodes. Web search adds depth for
   the open nodes at build time. **Every snapshot stores the exact articles it used**, so any week's state can
   be rebuilt and audited. To check before building: Render had no GNews key (memory, 2026-09).
8. ~~The company stage.~~ **Decided (Roy, 2026-11-23): industries only for now.** Stage 5 (§7) stays in
   the design and is **not built**. Its open points stay open until Roy brings it back: when a company node
   opens, how many names per industry, and when to build it.
9. ~~Does a woken branch get its own quick judgment?~~ **Decided (Roy, 2026-11-23, from the January 2025
   replay): yes, shown separately.** In the replay the network woke "China AI leap" on 20 Jan, a week before
   the DeepSeek crash, but at 22% it moved semis by one point and made no call. On waking, one LLM call asks
   "if this is true, how large, and which industries?". Its industry effects are shown **beside** the summed
   scores as an **early warning**, never inside them, until the branch firms up through normal updates. Early
   warnings are logged and scored on their own.
10. **Partial resolutions: split the node (Roy, 2026-11-23).** When one node holds outcomes that resolve
   differently (week 5: China's tariffs real, Canada's and Mexico's paused), it is **split** into nodes that
   resolve on their own ("China tariffs", "neighbour tariffs"). The split is a logged decision; links and
   probabilities carry to the parts; the forecast log keeps the original node's history.
11. **Events outside the network: logged (Roy, 2026-11-23).** An event that hits one industry and no macro
   node (the replay's LA fires → insurers) is logged with the industry it hits and changes no node. It stays
   visible on the board and can be promoted to a question if it grows.
