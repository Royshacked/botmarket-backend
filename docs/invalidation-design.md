# Invalidation — design spec

Status: **v1 BUILT 2026-06-30** (backend + frontend, frontend build green; not yet live-verified).
v2 (auto-analysis proposal) and the portfolio slow-cadence taxonomy remain deferred.
Supersedes the "thesis" concept.

## v1 build — what shipped (as-built)

Backend:
- `tradeIdeas.service.js` — idea fields `thesis*` → `invalidation { range:{lower,upper,lowerAnchor,upperAnchor}, conditions:[] }` + `invalidation_status` ('fired'|null) + `invalidation_reason` + `invalidation_edge` ('lower'|'upper'). `_normalizeInvalidation` (`conditions:[]` reserved, stored not monitored).
- `monitoring/invalidation.monitor.js` (replaced `thesis.monitor.js`) — `checkInvalidation(db, idea, symbolMap, {inPosition})`: one structured candle-close leaf per edge via `evaluateTree`, deterministic, fires on close outside range. Fire-once latch on `invalidation_status`. Drops the old `_aiEval` judge.
- `monitoring/monitor.service.js` — calls `checkInvalidation` pre-entry (looking, in `_checkEntry`) AND in-position (long/short, after `checkPosition`, reusing the entry-tf `aeCandles`).
- `idea_system_prompt.md` — `<trade_idea>` + `<state>` schemas carry `invalidation.range`; authoring rules: derive both edges from chart, cite the anchor, never a round number, range null until a structured entry exists.

Frontend (build green):
- `event-bus.service.js` `THESIS_EDIT_IDEA`→`INVALIDATION_EDIT_IDEA`; `ChatWindow.jsx` `invalidation_alert` bubble; `SocialChat.scss` classes; `MainPage.jsx` `isInvalidationReview` + dismiss/re-arm clears `invalidation_status/reason/edge`; `ChatPanel.jsx` review labels; `IdeaPage.jsx` `DevInvalidationPanel` renders the range + fired edge/reason.
- **Fixed a pre-existing gap:** `deriveBuildingIdea` never forwarded the old `thesis` (why it was invisible) — now forwards `invalidation` on create + update; edit-seed restores `pending_trade.invalidation` from the idea.

Reused the existing alert→edit→dismiss/re-arm flow wholesale (renamed). The dismiss = clear status (re-arm); edit = user adjusts then save re-arms.

## Distant-entry / approach watch — **BUILT 2026-07-01** (not yet live-verified)

**The bug this fixes.** The v1 envelope assumes price is *inside* `[lower, upper]` at
authoring. For an entry far from spot — "buy the false-break of 10" while price is 100,
or a breakout buy-stop above the market — price STARTS outside the envelope on the side
it must travel from, so the very first candle close fired a false "missed/gone"
invalidation. This hits any patient/limit-style entry (buy-the-dip, breakout-pullback),
not a rare edge case.

**The model — a pre-entry two-state machine.** The watched side is decided by
`sign(spot − entry)`, NOT long/short (a breakout long watches the *bottom*, a breakdown
short watches the *top*).

- **waiting** — the envelope is disarmed. Price is en route. We only flag the setup dying
  before it arrives, via two structured close leaves (OR), fired as a softer `drifting`
  status:
  - **away pivot** (`range.approach`, agent-derived + cited): a close *past* it means price
    ran the wrong way — "not coming."
  - **overshoot**: a close clean through the *far* edge of the zone (the side price would
    exit if it blew past) — "gapped through, never set up."
- **armed** — reached when any candle CLOSES inside `[lower, upper]`. The existing envelope
  now owns it; a close outside fires the normal `fired` status.

The waiting state partitions the whole price line into four regions (ran-away / silent
corridor / arm-zone / overshoot) — every close lands in exactly one.

**Arming is STATE-based, not a rising edge.** `_closedInZoneSinceFloor` scans for any
candle whose close is inside the band. A rising-edge leaf would (a) never arm an idea
authored with price already in the zone, and (b) miss a dip-in between checks. Arming is
checked FIRST each tick, so a dip-into-then-through in one window arms rather than
false-drifting. Once armed it stays armed (leaving the zone = the fire).

**As-built:**
- `tradeIdeas.service.js` — `range` gains `approach` + `approachAnchor`; new `invalidation_armed`
  bool (false on create; reset to false whenever the range is edited → full re-arm).
- `invalidation.monitor.js` — rewritten: `checkInvalidation` branches waiting→armed pre-entry;
  `_checkApproach` builds the away/overshoot leaves from `approach` vs the envelope;
  `_closedInZoneSinceFloor` arming scan; new `drifting` status + `approach`/`overshoot` edges;
  `_notify` payload gains `status`. In-position path unchanged (no waiting phase — you're past entry).
- `idea_system_prompt.md` — DISTANT ENTRY authoring rule + `approach`/`approachAnchor`
  in the `<trade_idea>`/`<state>` schemas. Omit `approach` when the entry is near spot.
- Frontend — `ChatWindow` bubble reads `payload.status` (drifting vs fired wording/colour);
  `MainPage` dismiss + review-save also clear `invalidation_armed`; `IdeaPage`
  `DevInvalidationPanel` shows the approach pivot + a waiting/armed phase chip; `SocialChat.scss`
  + `IdeaPage.scss` `--drifting`/`--waiting`/`--armed` variants.

**Decisions locked (2026-07-01):** approach breach = softer `drifting` status (distinct from
`fired`); away pivot must be structural + cited (no naked number); arming = a candle *close*
inside the zone (a fast wick that closes back out does not arm); waiting-state overshoot maps
to `drifting` (pre-entry, never-in-play). A full envelope with NO `approach` authored, created
with price outside the zone, waits silently until arm (safe default — no false fire). One-sided
ranges (only lower or only upper) skip the waiting machinery entirely (legacy single-edge behaviour).

## In-position adverse edge + alert actions — **BUILT 2026-07-01** (not yet live-verified)

Two in-position refinements (matches the "yellow = structure break" model in *Lifecycle /
monitoring behavior* below, which the code wasn't honoring):

- **In-position watches only the ADVERSE edge.** `buildEnvelopeEdges` still yields both edges, but
  `checkInvalidation` filters to the adverse one when `inPosition` — long → `lower`, short → `upper`
  (via `idea.direction`/`status`). Pre-entry is unchanged (both edges — you also don't want to enter
  too high). Fixes a long alerting when price closed *above* the upper edge (favorable; the TP owns
  that exit).
- **Alert bubble actions.** `InvalidationAlertBubble` now renders **Update** (edit) / **Close**
  (in-position only → `INVALIDATION_CLOSE_TRADE` eventBus → `MainPage` resolves the open position by
  the idea's symbol/broker-alias → `closePosition`) / **Dismiss**.
- **Dismiss is persisted per-message.** New `chat_messages.dismissed` flag + `dismissMessage` service
  / `POST /api/chat/conversations/:id/messages/:msgId/dismiss`. The bubble renders from `msg.dismissed`,
  so the choice survives reload. It deliberately does **not** touch `invalidation_status`, so a
  re-armed idea (edit / Update) still emits a brand-new alert message.

## Why this exists / what it replaces

The word **thesis** was overloaded into three incompatible meanings (a structured
object on ideas, a string label on scans, `thesisAgeDays` on portfolio holdings)
and its one real surface was a self-hiding `[DEV]` panel. We are renaming and
re-grounding the idea concept as **Invalidation**.

We are not defining the thesis — we are defining **what would break it**.
"Invalidation" describes the breaker, not the belief. It is the trading term
("where's my invalidation"), and it slots in as the idea's fourth condition
concept alongside **entry / stop / tp**.

- Idea thesis-object  → **Invalidation** (this doc)
- Scan `thesis` string → out of scope here (scan items aren't ideas yet; leave as-is)
- Portfolio `thesisAgeDays` → unrelated (holding age); not touched

## Core model

An idea is the atomic unit. It carries condition logic for entry, stop, tp — and
now **invalidation**. Invalidation is **a structured price RANGE** the agent
derives from candles/chart at authoring time:

- price **inside** the range  → invalidation `false` → idea valid, original plan continues, no interruption.
- price **outside** the range (either edge) → invalidation fires → Axl notifies user in social chat + deep-links into the idea in **edit mode**, where the user reviews chart + news and decides.

Invalidation is two-sided. A setup dies two ways:
- **Wrong** (lower edge): price *accepts below* the defended structure the entry relied on (e.g. the swing low a false-break must hold).
- **Gone / missed** (upper edge): price *runs past* the actionable zone so the entry can't trigger / R:R is destroyed (e.g. plan a false-break of 100, gap up to 120).

So the range is an **envelope around the actionable entry zone**, narrower than
the stop→target span. The two edges have **different derivations**:
- lower edge ← defended structure (swing low / range floor)
- upper edge ← entry reachability + R:R ("entry can't fire from here / risk is blown")

## Data shape vs monitored scope (IMPORTANT)

The invalidation **data shape carries the FULL condition-type taxonomy** from day
one — same general condition-tree shape as the entry tree (structure / news /
earnings / chart / indicator / time / volume). In **idea mode v1 we only MONITOR
the structured leaves**; the other slots exist but hold nothing.

Reason: **portfolio (swing → long-horizon) mode** will need invalidation that is
*not only range* — news, earnings, chart, indicator — evaluated on a **slow cadence
(weekly / monthly)**, not intrabar. Keeping the empty slots now means portfolio can
populate them later with **zero schema change**. So: author/store the full tree,
filter to structured leaves at monitor time for v1.

(Portfolio invalidation mechanism + cadence is a separate, later conversation.)

## Scope for v1 (monitored)

Structured (price/candle) invalidation only. Everything non-price is handled
**reactively** by the agent once the user is in edit mode (it re-reads news, chart,
checks if the setup now looks like a short, etc.). Conscious tradeoff:

- ✅ price-driven breaks → caught proactively.
- ❌ non-price breaks (war/Fed/earnings) while price stays in range → NOT proactively caught.

This blind spot is intentionally accepted because:
1. In-position drawdown from surprises is just trading; the **stop is the in-position invalidation of last resort**.
2. **Foreseeable** catalysts are handled at planning time as ordinary **entry conditions** — e.g. `time` leaf "don't enter before the Fed print" + `news` leaf "and only if it's positive." You never enter into a known landmine.
3. Real-time news monitoring is deferred until the paid websocket news APIs are in; then non-price invalidation leaves (`news`/`time`) can be OR'd into the range cheaply.

## Lifecycle / monitoring behavior

Invalidation monitoring runs **continuously — pre-entry AND in-position** — same
flow both times. Exits are **always stop-owned**; invalidation can *inform*, never
*execute*.

- **Pre-entry, range breaks** → fire → notify + edit link. Natural user action: re-arm / edit the entry.
- **In-position, price in range** → nothing; original plan continues.
- **In-position, price breaks range bottom but still above stop** → "**yellow**": the structure the trade relied on broke, but the stop (buffered below structure) hasn't. Fire → notify-only + edit link. The user reviews (hold / tighten / scale / bail); **the stop still owns the exit**. Natural user action: review, not re-arm.
- **In-position, price hits stop** → "**red**": stop executes as today. Not an invalidation concern.

The range bottom and the stop are **two deliberate lines**: range bottom = structure
(yellow, informational), stop = buffered below structure (red, executes).

**Hard guardrail:** never auto-act above the stop. The stop is the only thing that
moves money in-position.

## Division of labor

- **AI, once, at authoring:** read candles/chart → define the actionable entry range (both edges, each anchored to a cited structure). Must **state the structural reference in chat**, not emit a naked number ("invalidation = close below the 93.40 swing low the false-break must hold" — not "90"). A naked number is the unauditable "why 90 not 95" problem.
- **Monitor, continuously:** is price in or out of range → boolean. No AI in the hot path. (Drops v1's AI holding/weakening/invalidated re-eval entirely.)
- **Human, on fire:** Axl notifies → edit mode → review chart + news → decide.

## Agent authoring rules (no user help — agent derives it)

When the agent defines a **structured entry** condition it must also:
1. Call `get_chart` (often already has the data from entry/stop reasoning).
2. Identify the **actionable entry range**: lower edge from defended structure, upper edge from entry reachability / R:R.
3. Emit the invalidation as a structured range, each edge anchored to a cited pivot.
4. State the reference in chat in plain English ("inside this zone we proceed; outside it we rethink").

This mirrors how the agent already derives stops ("where is the thesis wrong",
`idea_system_prompt.md`) — same competence, different timing (pre-entry).

## Portfolio & scans

- **Portfolio:** ideas are structurally identical, so invalidation applies per-idea unchanged. (Portfolio default entry = immediate/market; condition editing blocked for now — but invalidation still watches + notifies + edit-links per idea.) Swing→long-horizon invalidation runs on a **slow cadence (weekly/monthly)** and uses the **full taxonomy** (range + news + earnings + chart + indicator), not structure-only — which is exactly why the idea-mode data shape keeps all leaf slots even though v1 monitors only structured. Mechanism + cadence = separate later conversation.
- **Scans:** excluded. Scan items aren't ideas yet; nothing to watch until one is built into an idea. (Scan→idea handoff already passes ticker + analysis summary + datetime→`time` condition.)

## Reuse / what NOT to build

The whole "thesis" problem collapses into things we mostly already have:
- **(a)** an entry-range **invalidation tree** (new, but reuses structured-leaf evaluation — see `thesis.monitor.js:52` which already wraps strings as `{type:'structured'}` leaves and ORs them).
- **(b)** **entry conditions** reused for catalyst gating (`time` + `news` leaves — existing).
- **(c)** the **stop** as in-position invalidation of last resort (existing).

Nothing new is invented for catalysts or in-position exits.

## v2 — auto-analysis proposal (NOT v1; recorded, deferred)

Same invalidation fire, richer payload. Instead of a bare alert, Axl runs the
idea-building **analysis phase** once on the user's behalf (re-reads news + chart +
candles) and returns a **summary + options card** to social chat:

- **Accept new idea** — confirm the agent's proposed setup/exit changes.
- **Dismiss the whole trade.**
- **Leave things the same** — keep the original plan.
- (optional) open edit to discuss.

**Constraints (idea mode):**
- Agent runs the re-analysis **exactly ONCE per fire/setup** — not a loop. After it
  posts the options, it does not auto-re-run; the user picks one of the three
  outcomes. Combined with the fire-once latch, the agent fires **at most once per
  setup**.
- More autonomous / recurring re-analysis lives in **portfolio mode** (weekly/monthly
  cadence), not here.

Reuses the existing **agent-proposes → user-confirms** pattern (`portfolio_update` +
`OrderConfirm`). Genuinely new pieces: (1) an autonomous, user-less agent run kicked
off by a monitor event (no user turn exists today); (2) a structured *proposal* emit
type + frontend options card (new vs old setup / exits / dismiss). Guardrail holds:
agent only **proposes**, user confirms, nothing auto-executes, exits stay stop-owned.

(Pin the exact building phase to re-enter when building this — it's in
`idea_system_prompt.md`.)

## Portfolio invalidation — **v1 BUILT 2026-06-30** (incl. execution; not live-verified)

Status: design locked + v1 built 2026-06-30 (backend + frontend, FE build green).
Builds on `portfolio-managing-design.md`. This is the portfolio half of invalidation;
it is NOT a separate mechanism — it is the *content* of the scheduled portfolio review.

**As-built (v1):**
- Foundation: `portfolioChat.service.js` — weekly cadence (new default) + versioned `thesis` (`getThesis`/`setThesis`, `updatedReason`) + `completeReview`; exclusion lock in `invalidation.monitor.js` (portfolioId ideas skip the intrabar watcher); weekly-aware notify window in `portfolio.monitor.js`.
- Review behavior: REVIEW MODE prompt = delta-op phases anchored to thesis, post-earnings, default-HOLD; agent gets PORTFOLIO THESIS section + conviction (cur vs prior, from new `conviction_history`); `<portfolio_thesis>` capture (suppressed from UI stream, persisted construction/edit only — **review thesis changes persist only on accept**).
- Execution: `portfolioRebalance.service.js` `applyRebalance` — `exit_idea` (full close all legs), `trim_idea` (per-leg `closePosition({quantity})`), `add_idea` (saveIdea, construction semantics), `update_idea`/`remove_idea`; capability-gated (cTrader close only), then snapshot conviction + persist thesis (`accepted-rebalance`) + `completeReview`. Endpoint `POST /api/portfolio/:portfolioId/rebalance`. Prompt vocabulary extended (`exit_idea`/`trim_idea`; swap = exit+add).
- Frontend: review `portfolio_update` → **RebalanceConfirmDialog** (nothing auto-trades) → `applyRebalance` POST; thesis forwarded/displayed; construction/edit keeps legacy client-side apply.

**NOT live-verified — money-moving:** execution reuses proven primitives (`closePosition`, reconciler, `saveIdea`) and is capability-gated, but there's no broker in the build env to test. Verify before real use: per-leg `trim_idea` against the reconciler's `_onReduced` resync; multi-account leg sizing; exit canceling resting exits. Known minor UX gap: review panel doesn't auto-close after a confirmed rebalance.

### The inversion vs idea-mode

Portfolio (swing → long-horizon) flips almost everything about idea-mode invalidation:

| | Idea-mode | Portfolio |
|---|---|---|
| Substrate | price RANGE | the THESIS (fundamentals/earnings/macro/regime) |
| Measurement | deterministic boolean, every tick | LLM analysis, weekly cadence |
| Reaction | notify → user edits in edit mode | agent PROPOSES a portfolio action (editing is blocked) |
| Exit backstop | the stop owns exits | often no stop → the review IS the main "still hold?" check |
| Phase | mostly PRE-entry (envelope) | purely IN-position (default entry = immediate/market) |

So portfolio invalidation re-introduces the AI judge that idea-mode dropped, because
the conditions are qualitative.

### Granularity — portfolio-level, not per-holding

You do NOT invalidate each idea independently. A scheduled **portfolio-level review
re-runs the relevant phases over the whole book**; the per-holding check is the FIRST
phase *inside* it, feeding one consolidated proposal. Rationale: portfolio risk lives
at the portfolio level (correlation, concentration, weight drift, cash); actions are
interdependent (an exit frees cash → redeploy → reweights everything → may breach the
mandate); one `portfolio_update` proposal beats N idea alerts.

Decision (2026-06-30): we DON'T author/store per-holding invalidation condition leaves
for portfolio holdings. The "full taxonomy" coverage is **behavioral** — the agent uses
its tools (fundamentals/earnings/chart/news) DURING the review — not declarative stored
leaves. The reserved `invalidation.conditions[]` slots stay empty (kept for a future
news-websocket phase). The only per-holding carry-over is the original rationale as
prose context (notes / conviction.rationale / chat), which the review reads.

### Cadence + earnings trigger

- **Weekly calendar review** (start with weekly; `portfolio_chats.reviewCadence` already
  exists, defaults monthly → set weekly). Always runs.
- **Earnings trigger is POST-report** (let it report, then review the result + market
  reaction + forward outlook — not pre-print positioning).
- **For the beginning the event-driven review folds INTO the weekly pass** (earnings-aware
  weekly review), not a separate faster loop. Each weekly run: (1) refetch earnings dates
  for all holdings so none are missed; (2) flag any holding that reported since
  `lastReviewAt`; (3) re-run phases with those holdings getting focus; (4) emit one
  proposal. Tradeoff: worst-case ~7-day latency on a post-earnings review — fine for
  long-horizon. A daily date-check to pull reviews forward is a later option.
- **Earnings data is already available per holding:** `computePortfolioState` attaches
  `upcomingEarnings {date, epsEstimate}` per holding via FMP `/earnings-calendar`
  (`portfolioState.service.js:207`). **US equities only** (no earnings for ETF/crypto/FX/
  futures — those ride the calendar cadence only).
- **Forward outlook data:** we have forward **consensus EPS** (FMP) + **actuals/surprise
  history** + `get_sec_filings` (SEC 8-K item 2.02 / 10-Q / 10-K — dates + links, authoritative
  actuals). We do NOT have parsed management **guidance text** (lives in the press-release
  exhibit / earnings call, not cleanly in a filing). So "next-quarter/year" = consensus +
  reaction + news for now; guidance-text extraction is a later enhancement.

### The review phases (a DELTA op, default = HOLD)

A review is anchored to the existing holdings + the thesis; the default is "hold, no
change" and changes require justification (long-horizon — don't churn). Skips nucleus/
mandate (fixed). Re-runs:

1. **Formation — per-holding "is the reason still intact?"** Refresh each holding with
   tools: price vs entry / P&L, trend, recent news, and for holdings that reported since
   `lastReviewAt` the earnings result + reaction + forward consensus (actuals grounded via
   `get_sec_filings`). Output: a fresh read AND a **re-scored conviction**, compared to the
   stored one → verdict intact / weakening / broken.
2. **Construction — what should the book BE now?** Whole-book altitude: recompute weights
   (drift), check allocation / correlation / concentration / cash vs the **mandate + target
   exposures**. Turn formation verdicts + conviction trajectory into candidate moves
   (keep / trim / exit / add / swap). Only phase that decides changes; sizes off conviction
   (low/falling → trim/exit; high/stable → hold/add).
3. **Validation — pressure-test the PROPOSED book.** Run risk/correlation on the *proposed*
   state; confirm freed cash handled (redeploy or hold per mandate); finalize conviction on
   the changes. Emit **one consolidated `portfolio_update` + OrderConfirm** + Axl summary.
   Propose-not-execute; nothing auto-trades.

Review inputs = price/news + earnings result/reaction + **conviction trajectory** +
portfolio-level weights/drift/correlation/cash/sector.

### Conviction as a signal

Conviction already exists per holding (`{level, score, rationale}`, via `cleanConviction`).
The review **re-scores it and uses the DELTA since last review** as an early-warning
(falling conviction = thesis decaying before it's outright broken) and as a sizing input.
- **Store conviction history** (or at least last-review conviction) on the holding so the
  trajectory is visible.
- **Soft signal, not a hard trigger** — it's the agent's subjective score; use the *change*,
  require `rationale` to name what new info moved it, feed the proposal (user confirms),
  never auto-act.

### Explicit portfolio thesis (NEW)

Today the portfolio's "intent" is implicit: the **mandate** (objective/horizon/risk/
constraints/benchmark — already persisted on `portfolio_chats`) + per-holding conviction +
chat messages. There is NO portfolio-level "why these holdings together." We add an explicit
**portfolio thesis = mandate + strategy rationale + target exposures**, persisted, as the
stable anchor the review validates drift against (raw chat scrollback is trimmed/lossy/
expensive — a bad anchor).

**Validate-weekly / rewrite-on-accept (critical):**
- Re-VALIDATED every week (the review reads it and checks the live book against it; records
  the assessment).
- Re-WRITTEN only on a deliberate change — when the user **accepts a rebalance** (the accepted
  proposal IS the new intent) or **edits the mandate**. NEVER auto-synced to current state, or
  the anchor drifts with the drift and drift becomes undetectable.
- A thesis change is itself **proposed-and-confirmed** (if the review judges the *strategy*
  stale, it proposes a thesis update in the same `portfolio_update`).
- Carry `version` / `updatedAt` / `updatedReason` (`mandate-edit` | `accepted-rebalance`).

Naming note: "portfolio thesis" is fine here (unlike the old idea mess) — it's a single,
explicit, persisted strategy object. Portfolio thesis = the intent; the weekly review = its
invalidation check.

### The portfolio entity (extend `portfolio_chats`, keyed by {portfolioId, userId})

Already persisted: `mandate`; review lifecycle `reviewCadence` / `nextReviewAt` /
`lastReviewAt` / `reviewHistory` (capped 50); the portfolio chat; `portfolioName`; `userId`.
`getPendingReviews` already returns portfolios due (`nextReviewAt <= now`).

Add: the **portfolio thesis** object (mandate + strategy rationale + target exposures +
version/updatedAt/updatedReason); **target allocation** (intended weights / sector-sleeve
caps — the reference live weights drift from; per-holding intended weight may instead ride on
the idea as `allocationRatio`); **status** (constructing/active/closed). Earnings markers:
prefer DERIVE (compare `computePortfolioState.upcomingEarnings` to `lastReviewAt`) over store.

NOT in the entity (by design):
- **Holdings/positions** = separate idea docs carrying `portfolioId` (own conviction,
  invalidation, fills, chat). Entity LINKS (query by portfolioId), never embeds.
- **Live metrics** = computed by `computePortfolioState` (cached via `getPortfolioStateCached`):
  per holding `actualWeight` (current ratio), `allocationRatio` (target), `drift`, `pnl/pnlPct`,
  `conviction`, `upcomingEarnings`, `notes`, sector. Ephemeral, recomputed each review. The
  review agent already receives this via `_buildPortfolioStateSection`. (Weights depend on live
  broker positions — unmatched holdings show null weight.)

Mental model: Intent (thesis) + lifecycle = entity (persisted); holdings = linked ideas; live
state = derived snapshot. The snapshot is the eyes; the thesis is the memory.

### Key consequences to lock

- Portfolio holdings are governed by the **scheduled review, NOT the intrabar idea-invalidation
  monitor** we built for standalone ideas. (At build, exclude `portfolioId` ideas from
  `checkInvalidation`, or simply don't author a range on them.)
- Reaction is always **one consolidated `portfolio_update` proposal the user confirms** —
  "autonomous" means auto-*review*, never auto-*trade*.

### Reuse (already exists)

`computePortfolioState` (weights/drift/conviction/earnings/sector) · `portfolio_chats` lifecycle
(`reviewCadence`/`nextReviewAt`/`lastReviewAt`/`reviewHistory`, `getPendingReviews`) · `mandate`
· FMP earnings calendar · `get_sec_filings` · the `portfolio_update` + `OrderConfirm` propose-flow
· conviction (`cleanConviction`).

## Open implementation questions (for build phase, not design)

1. Field name/shape: `invalidation_condition_tree` mirroring `entry_condition_tree`? Range stored as two anchored structured leaves OR'd, or a dedicated `{lower, upper}` shape?
2. Fire-once latch: after firing, suppress re-fire until user acknowledges/edits (v1 used `thesis_status != null` as the latch — port that idea).
3. Notification payload: keep `thesis_alert` type or rename to `invalidation_alert`? (Frontend sync rule applies — update frontend when this contract changes.)
4. Rename pass: `thesis` / `thesis_status` / `thesis_status_reason` fields, `thesis.monitor.js`, the `[DEV] Thesis` panel, system-prompt sections.
