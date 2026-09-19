# Atlas + Themis — the `portfolio`

The user's book: **Atlas** builds it against a mandate from the house's research, reviews it as a
delta against its own thesis, and proposes changes the user accepts or not; **Themis** decides WHEN
a book deserves a look and rings once. Written 2026-09-19 from the code, the prompt and APP_SPEC §3
(which holds the contract — statuses, endpoints, the edit-vs-review gate, activation). This doc is
the reasoning behind that contract.

The one line: **Atlas is the PM, not the screener — every name it places came out of house coverage,
every weight is a risk decision against the mandate, and nothing it proposes executes without the
user's accept.**

## What a portfolio IS

A book is a set of `idea` documents sharing a `portfolioId` — each holding is a `portfolio_item`
(`kindForDoc`), riding the same execution tier as any trade. Beside them sits one `portfolio_chats`
document carrying what the book *means*: the **mandate** (objective, horizon, risk tolerance,
constraints, benchmark, the two schools), the **thesis** (strategy rationale + target exposures,
versioned, rewritten only on a deliberate change — never auto-synced to drift), the **lifecycle**
(`reviewCadence`, `nextReviewAt`), and the **fingerprint** (the "then" state the next review
measures against). The mandate is the contract; the thesis is the strategy layer on top of it.

A book binds to an account, so it belongs to a workspace (APP_SPEC §8) — but it carries `modes[]`,
not one mode: a book appended to across a workspace switch is genuinely mixed and shows in every
workspace it holds something in. Research binds to no account; the coverage a book is built from is
shared across all three.

Three ways a book comes to exist, and they are not the same desk turn:

| Origin | What Atlas does | Doc |
|---|---|---|
| **Built here** | the five phases below, two gates, a sized plan | this doc |
| **Adopted** — a real book at a bank the app cannot reach | reads a pasted book deterministically (`holdingsParse.util` — the model never reads a number), elicits the mandate with an anchoring rule, writes the holdings as `born: 'live'`, and reviews it monthly with a re-confirm ritual keyed on the unreadable venue | [design/adopted-book.md](../design/adopted-book.md) |
| **Manual** — real money placed by the user at a bank | built like paper, monitored like paper, filled by the user's confirmation | [architecture/virtual-venue.md](../architecture/virtual-venue.md) |

## Atlas — construction

`prompts/portfolio_system_prompt.md`. A seasoned PM: top-down, sequential, opinionated. Five
phases and exactly **two gates** — "gate only where the user's input changes the outcome; a PM
presents in flow, they don't ask permission to think":

1. **Mandate.** Objective · horizon · risk tolerance · constraints · benchmark, one question at a
   time, never a form; the minimum to proceed is the first three. The **benchmark is proposed, not
   asked** — growth → S&P 500, income/preservation → 60/40, absolute return → none — because the same
   mandate must produce the same yardstick every session, or Phase 3's over/underweights mean
   something different each run, and because those names are the ones `benchmarkTicker` can resolve to
   a priceable proxy. The two **investment schools** — selection (what qualifies) and allocation (how
   risk is spread), `services/investorSchools.js` — are inferred and stated, never asked as a sixth
   question; they are separate because "own great businesses cheaply" says nothing about sizing and
   "balance my risk" says nothing about what to own; and they are STICKY — changing one weighs the same
   as changing risk tolerance and never happens because the market moved. Emits `<portfolio_mandate>`
   as soon as the minimum is known. **→ Gate 1.**
2. **Macro regime.** Three horizons, weighted by the mandate's. The forward read must come back as a
   view, not a headline. Seasonality is deliberately not here — it is a trading-horizon edge and lives
   in Argus. No Aether tool.
3. **Architecture.** Sector targets as **deliberate active weights against the benchmark's REAL
   weights** — fetched (`get_fundamentals` on the benchmark ETF's look-through), never estimated: the
   S&P is a third technology, so a 30% sleeve is a neutral, and calling it a bet is a mistake about your
   own book. **The house view (Pythia's tilt) is an input, not an instruction**: agreement is real
   support; disagreement must be said and argued, because Atlas can see this mandate and Pythia cannot.
   **→ Gate 2** — the skeleton is the decision worth the user's input.
4. **Selection.** THE HARD RULE: **every name placed came out of `get_coverage`.** Not `web_search`,
   not `get_fundamentals`, not a name Atlas already knows — those are read tools for qualifying a
   sourced name; used to find names they make Atlas the screener, and then the book holds names nobody
   researched. The selection school is the bar, named when a name is rejected. An empty pool is not
   permission to improvise — it is information, and it ends the turn (below).
5. **Sizing.** By risk contribution, not capital weight: `get_risk_metrics` for σ, weights by the
   allocation school's rule (conviction-weighted `score/σ` by default; risk-balanced `1/σ`;
   benchmark-relative as active tilts), `get_correlations` (>0.7 pairs are not diversified), then the
   mandate's constraints as **hard limits** — max position clamped and the excess redistributed,
   sector caps trimmed, and the **cash floor honoured by deploying less capital** (`positionSize =
   capital × (1 − floor)`), because the server re-normalises ratios to 1.0 and a reserve left in the
   ratios would be silently deployed. A base/bull/bear pressure test before the plan. Then
   `<portfolio_plan>`, sized server-side (`_sizePlan`: ratios → live prices → quantities) and saved as
   one idea per asset via `POST /api/trade-ideas/batch`, every leg `waiting` with no entry conditions.

**An empty sleeve is SOURCED, not improvised — and it ends the turn.** Atlas emits one
`<screen_request>` per empty sleeve and stops; `sleeveSource.service` screens the sector under the
school (a coarse pond filter, honestly labelled a proxy — FMP's screener cannot express a school's
real bar), queues the hits with the sleeve as their reason, starts the research run if none is going,
and posts the requester a `sleeve_sourced` card — "Resume build" — when every name is decided. The
research runs **as the house** (`userId: null`): a thesis every book builds from must not be written on
the cheap model a trader past their ceiling is degraded to, and an hour of Prometheus is the house's
spend, not the price of asking Atlas a question. Before 2026-09-14 this hop was a button and the user
walked three desks by hand; a trader could not finish the walk at all. `<coverage_request>` is the
narrower form — one user-named ticker, queued, no card. Nobody at a desk in between is the point.

## Atlas — review

A review is a **delta operation anchored to the thesis**: the default is HOLD, and every proposed
change must be justified against what the book was built to do. Same stream, `reviewMode`, two kinds:

- **Pre-activation** — every holding still pending, ~$0 notional: a pre-flight before *Activate all*.
  No scoreboard; per-holding thesis check (has a catalyst landed since the build?) and shape check
  (do the weights still fit the mandate, does the regime still support the construction?).
- **In-position** — the full memo: a **benchmark-relative scoreboard** (book vs its proxy over the
  window), a **regime then→now delta**, per-holding drift and conviction, then a rebalance memo.

Both are computed, not estimated: the **fingerprint** (`buildFingerprint` — book value, benchmark
price, regime, per-holding weight and conviction, the tilt in force) is captured at construction and
at every review close, because the book's "then" state is not recoverable after the fact, and the
server renders the deltas into the review-state block rather than letting the model re-reason them.
The snapshot is short-TTL cached (`portfolioState.service`) so a review's follow-up turns re-use it —
prices frozen for the window — and the context tail stays byte-identical for the prompt cache.

A proposal is a `<portfolio_update>` in the `_item` vocabulary — `update_item · remove_item ·
exit_item · trim_item · add_item · add_to_item` (swap = exit/trim + add) — and **the user confirms the
whole block** before `portfolioRebalance.service` turns it into orders. That is the only path from a
review to a broker, nothing in it is autonomous, and every close/trim is sized per `brokerOrders[]`
leg, never on aggregate. After the moves: a conviction snapshot, the thesis rewritten if the proposal
carried one (`reason: 'accepted-rebalance'`), the review clock advanced.

**Edit or review is the book's call.** A book with nothing in a position reopens as a construction
edit (every holding back to `waiting`); any leg `long`/`short` opens as a review, because re-planning
would take an open position off monitoring to rewrite a plan the market has already acted on. `hit` sits
below the line — a parked order is not a position. One client-side gate (`isPortfolioReview`), after
four paths disagreed. A held name Atlas judges stale can be sent back to Prometheus mid-review
(`<coverage_refresh>`, admin-only because it rewrites house coverage) — route-and-return, Atlas re-reads
the doc on resume ([prometheus-coverage.md](prometheus-coverage.md)).

## Themis — the doorbell

`monitoring/themis.monitor.service.js`. Its own loop, sharing no state — the review check used to ride
inside the `idea` monitor's tick, and giving it its own loop is what kept it alive when that monitor
was deleted. **LLM-free by design**: Themis decides WHEN and WHY to look; Atlas, opened in review mode
from the card, decides WHAT to do. It runs only for in-position books and is mostly asleep — a
long-term hold must not be intrabar-monitored.

Hourly tick; each book leases `themis.next_check_at` forward to the next **end-of-day anchor**
(21:00 UTC — at or after the US close year-round), so the gate is read ~once a day on settled state,
not on intraday noise. Not eager on start. Three gates, all cheap and deterministic:

- **Scheduled** — the review cadence (`weekly · monthly · quarterly`; a book with none is `weekly`,
  and that answer used to differ between the seed, the readers and the display) via `nextReviewAt`.
- **Event (EOD)** — the trigger panel, `computeReviewSignals` → `computeReviewTriggers`, pure:
  conviction fell · drawdown since the last look (the "nuclear war" proxy — the market's own reaction
  rather than a news classifier) · the yield curve flipped · **the house sector view moved**
  (`diffStances` against the fingerprinted tilt) · a holding drifted · trailing the benchmark ·
  earnings within seven days.
- **Coverage-delta** — a held name's Prometheus coverage flipped terminal (`thesis_broken`,
  `target_hit`), or **our own price target fell to or below our entry, or was cut materially since
  entry** — the frozen `research_basis` against the revised coverage. This is where research
  invalidation lives, because research has no position and a book does.

Any gate → **one** `portfolio_review` card, carrying the triggers so the user knows why before they
open it; the card routes to review mode, and the full memo is generated only then. Re-nudging is
suppressed for the cadence window so an unanswered card is not re-rung every EOD. The header names
the next step without reshaping the loop: a future Themis slots an *assess* between gate and notify.

A holding is still an `idea`, so `entry.monitor` sweeps it if it was armed with conditions and
`exit.monitor` if it carries a stop the broker could not hold. No intrabar invalidation watcher
exists for any kind.

## The hops

| With | Direction | Mechanism |
|---|---|---|
| **Pythia** | reads | `getCurrentTilt` into the mandate build (advisory — the mandate wins) and into the fingerprint; a moved view is a Themis trigger |
| **Prometheus** | reads; asks | `get_coverage` (the only source of names, filtered by sector + school); `<screen_request>` / `<coverage_request>` to fill a sleeve; `<coverage_refresh>` mid-review |
| **Argus** | via the sleeve | never directly — the screen inside `sleeveSource` is the same mechanism as Argus's house scan, and Atlas has no screener of its own |
| **Axl** | hand-off in | `<edit>portfolio` opens the book through the same edit-vs-review gate as the pencils |
| **Mentor** | none | a single-name conviction trade is Mentor's; Atlas does not build a one-asset book for it *(the vision lists one — see Open)* |
| **The broker** | via accept | `portfolioRebalance` after a confirmed `<portfolio_update>`; activation moves each `waiting` leg to its activation status, or posts the N-leg entry card in manual |

## Why it is shaped this way

- **Coverage-only, because a book of unresearched names is a list.** The rule costs Atlas the ability
  to "just add NVDA" — and that cost is the feature: a name in the book has a thesis, a target and a
  monitor behind it. The sleeve hop exists so the rule never leaves the user empty-handed.
- **Two gates, not six.** The mandate and the skeleton are the two decisions the user's input changes;
  everything else is the PM's job to carry in one flow.
- **Delta reviews, because a review that re-reasons from scratch has no memory.** The fingerprint is
  what makes "what changed" a computation rather than a guess, and the thesis is what "changed
  relative to what" means.
- **Themis never thinks.** Every gate is arithmetic on stored facts; the model is spent only when a
  human opens the review. A book of long-term holds does not need a model looking at it daily.
- **Accept-gated, because a rebalance is the user's money moving.** The whole proposal is one confirm,
  and the only executor is the one path that reads it.

## Open

- **The vision's three entry modes.** [design/architecture-vision.md](../design/architecture-vision.md)
  describes Atlas as *mandate build* · *conviction trade* (one asset, no forced phases) · *manual
  monitoring* (existing names, ask only for what cannot be derived) · plus on-demand single-name
  research. Built: the mandate build, adoption (the third, in a stronger form), and the on-demand
  hop. The prompt still forces the phase sequence on free chat, and the conviction-trade mode is
  unbuilt — this rework is deferred, deliberately, until the other desks are done.
- **A Themis *assess* step** between gate and notify (the header's own next step).
- **`max_names` as a mandate field** — parked (adopted-book §10); `RESEARCH_TOP_N` stays hardcoded.
- **The cash floor is honoured by shrinking `positionSize`**, which works but means a book's stated
  capital and its deployed capital are two numbers a reader must reconcile. *(Observation, not a
  recorded decision.)*
