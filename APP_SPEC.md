# App Spec

Behavioral contracts for the core domain. For the architecture overview + ASCII
flow diagrams see [README.md](README.md); for file layout see [CODE_MAP.md](CODE_MAP.md).

The app turns natural-language chat into **monitored trade ideas** that route to a
broker. Six desks produce work — Axl (reception) · Mentor (`setup`, the trader) ·
Atlas (portfolio) · Argus (scan) · Prometheus (`coverage`) · Pythia (`tilt`) — each kind is
watched by its own background monitor, and one reconciler keeps entity state honest
against the broker. Nothing reaches a broker while its venue is shut (§5). Every desk is
handed the user's venue on every turn, and every account-bound artifact belongs to one
workspace (§8).

**Kairos (`call`) is asleep.** Mentor took the trading over; the autonomous call builder
returns later as a premium Mentor mode. Calls in flight still run under Hermes and can
still be edited, so the kind is live everywhere below — but nothing new is authored there.

---

## 1. The `idea` kind — lifecycle

`idea` is the execution-tier kind served by `/api/trade-ideas`. **Portfolio holdings ride it**, so
everything below — the statuses, the condition tree, the execution path — is live, and is the
contract those callers hold. Nothing authors an `idea` conversationally: the authoring kinds are
Kairos's `call` (watched by Hermes) and Mentor's `setup` (watched by Talos), and Atlas writes
holdings straight to this kind through `POST /api/trade-ideas/batch`.

### Statuses

```
waiting ──► looking ──► hit ──► long / short ──► closed
                  │              │
                  └── resting ───┘   (broker-native stop entry)
```

| Status | Meaning |
|--------|---------|
| `waiting` | saved, entry conditions not yet actively watched (also the resting floor state) |
| `looking` | actively watched by the monitor; entry detection running |
| `resting` | a STOP working order is live at the broker; reconciler flips it to long/short on fill |
| `hit` | entry conditions met (or `immediate`); an order plan is built, awaiting user confirmation |
| `long` / `short` | position open; stop/TP condition trees + reconciler now govern it |
| `closed` | exited; `closedReason: 'stop' \| 'tp' \| ...`; a `trades` record is captured |

### Rules

- **Entry conditions met** → status `hit` → order plan built → user confirms via
  `POST /api/trade-ideas/:id/orders` → orders placed → status `long`/`short`.
- **Arm-time pre-flight.** When an idea is armed (→ `looking`), the update response carries
  `preEntry` when the entry level is **already held** on the last closed candle but the
  rising-edge won't fire (breakout already past). The frontend then prompts **Buy now / Edit /
  Reset**: *Buy now* force-triggers via `POST /api/trade-ideas/:id/trigger` (`triggerEntryNow`:
  → `hit` + built plan → normal confirm dialog); *Reset* re-arms `entryFloorAt=now` (the
  `resetPreEntry` PATCH flag) so only a fresh cross fires; *Edit* reopens the idea in chat.
- **Exits are always broker/stop-owned.** `touch` exit levels rest as broker closing orders
  (`positionId` reduce-only on hedging brokers); non-`touch` exits are watched by the software
  monitor and closed via a market order when they fire.
- **The reconciler is broker-authoritative.** On a reduce/close it asks the broker whether the
  position survived (`findOpenPosition`) before mutating idea state — it never closes an idea on a
  transient/unknown result.
- **Delete lock (every kind).** An entity holding a LIVE position (`long`/`short`) cannot be
  deleted — idea, call, setup and portfolio holding alike (`makeEntityCrud({ deleteLock:
  LIVE_POSITION })` → 409 `reason:'in_position'`). Deleting one would leave the position open at
  the broker with nothing describing it, so no monitor runs its stop. `hit` IS deletable (nothing
  is at the broker yet — only a parked order plan), and the client confirms intent first. The call
  route was the last kind without the lock; it has it as of 2026-07-29.
- **One reason → one answer.** Services refuse with a slug (`{ok:false, reason}`) and
  `api/_shared/reason.util.js` owns the slug→HTTP map, so no two kinds answer the same refusal
  differently. Refusal bodies are always `{ error, reason }` — branch on `reason`, never on prose.
- **Scheduled (timestamp) entries.** A regular idea whose entry is a `time` leaf enters on a
  wall-clock schedule — **not** an immediate trade: `saveIdea` only honours `immediate` when
  there is *no* gating entry condition (`resolveImmediate`). The agent converts the user's local
  clock time (browser `clientTz`) to absolute-UTC `after`/`before`. A pure time entry stays
  monitored even when the market is closed and defers as `awaiting_market`, surfacing the
  entry-confirm card at the next open (the market-open sweep, note `off_hours`). `updateIdea` refuses to
  revive a `closed` idea (`isClosedIdeaFrozen` → 409 `already_closed`).

---

## 2. Condition trees & evaluators

Entry / stop / TP are **condition trees**: AND/OR group nodes over typed leaves, evaluated by the
one shared `monitor.orchestrator.evaluateTree` — called by `positionMonitor` (stop/TP on an open
position) and by `invalidation.monitor` (which synthesizes its own leaves and runs them through the
same evaluator rather than growing a second one).

**7 leaf types** (`monitoring/evaluators/*`):

| Type | Fires on | Notes |
|------|----------|-------|
| `touch` | price trading **at** a level, intrabar | direction-agnostic; becomes a native broker order for entries/exits |
| `structured` | a deterministic threshold at candle **close** | pure math, no LLM; subjects: price/volume + RSI/EMA/SMA/MACD/ATR/VWAP vs a number |
| `indicator` | a qualitative TA judgment (e.g. "bullish engulfing") | Haiku YES/NO over the candle+indicator table; `parsers/indicators.parser.js` supplies the shared `family(N)` grammar |
| `time` | a wall-clock `after`/`before` window | cheapest leaf; can skip the candle fetch; a pure time entry = a **scheduled (timestamp) entry** (see Rules) |
| `volume` | bar or cumulative volume threshold | `bar` = candle close; `cumulative` = intraday, session-anchored, ~1-min poll |
| `news` | an LLM judgment over recent news | Haiku YES/NO (`parseYesNo`) |
| `chart` | an LLM vision judgment over a chart image | Sonnet vision; most expensive |

- A leaf's **timeframe** resolves via `resolvePhaseTimeframe` (entry/stop/tp). Per-leaf pass/fail
  is persisted to `conditionStates` for the UI (both the tree path and the legacy flat-array path).
- Adding an 8th type = new `evaluators/<type>.evaluator.js` + wire into `_evalOne` + the parser.
- **Entry legs must currently hold (`requireHeld`).** On the entry path a `structured` leg fires
  only if it had a fresh rising edge since the floor **AND** the level is still held on the last
  candle — so a reverted breakout (e.g. "close above 1150 AND cumulative volume", price back below
  1150) can't keep an AND leg latched true until a lagging sibling turns true. Scoped to entry
  (stop/TP unaffected); only `structured` legs (`touch` rests as a broker/monitor order). The
  evaluator's `stateLevel` snapshot mode (crossAbove→"is above now") backs both this and the
  arm-time pre-flight.

### Invalidation (advisory, never executes)

`idea.invalidation.range = { lower, upper, *Anchor }` is the actionable entry band the agent
derives from chart structure. `invalidation.monitor.js` watches it deterministically (synthesizes
a `structured` leaf per edge — **no LLM in the hot path**). A candle **close** outside either edge
fires a one-shot advisory alert (bot message + edit deep-link), latched by `invalidation_status`.
It runs pre-entry AND in-position but only INFORMS; exits stay stop-owned.

- **Pre-entry watches both edges** (above = "don't enter, too high"); **in-position watches only the
  adverse edge** — long → `lower`, short → `upper` (a favorable-side cross is fine; the TP owns it).
- The chat alert bubble offers **Update** (edit) / **Close** (in-position → resolves the open
  position by symbol → `closePosition`) / **Dismiss**. Dismiss is persisted per-message
  (`chat_messages.dismissed`) and never touches the `invalidation_status` latch, so a re-armed idea
  still produces a fresh new alert.

### Social-chat notification cards (notify + route)

Major events are surfaced as typed cards in social chat via one funnel — `sendBotMessage(userId,
content, type, payload, botId)` (`api/chat/chat.service.js`) → `chat_messages` → WebSocket →
`SocialChat/ChatWindow.jsx` dispatches by `type` to a card component. Each `botId` is the authoring
agent (`BOT_IDS = axl · portfolio · scanner · kairos · mentor · analyst · strategy`; only Axl is
conversational, the rest are notify-only feeds), so a card reads "from Atlas / Kairos / Mentor". A
kind picks its sender through the one `botForKind` map, and a kind with no desk of its own (`idea` —
see `RETIRED_BOT_IDS`) falls back to Axl rather than posting into a feed nobody reads. The card is the alert + a
clickable preview; the **existing action UI stays the destination** (deep-link, not embedded action).
Dismiss/handled state persists per-message.

| `type` | Event | Card actions → destination |
|---|---|---|
| `invalidation_alert` | Entry envelope broken (above) | Update / Close / Dismiss |
| `portfolio_review` | Scheduled review due | Review → Atlas review mode |
| `manual_entry` / `manual_exit` | Broker-less fill needed | Inline FillCard (price/qty) — the one embedded-action card |
| `entry_confirm` | Entry triggered, confirm needed (`kind: idea`\|`call`) | idea → workspace + `OrderConfirmDialog`; call → `/call/:id` pop-out |
| `call_expiry` | Kairos thesis expiring/expired (`kind: edit`\|`expired`) | Edit → `/call/:id` pop-out · Delete · Dismiss |
| `call_reentry` | A call **stopped out** with its thesis still intact (Hermes `_maybeOfferReentry`, one-shot) | Re-enter (`reviveCall` → `waiting`) · Close (`declineReentry`) |
| `queue_ready` | The venue opened and something is waiting (`marketOpen.monitor`) | Open the queue → the Floor's **Queued** desk. ONE card per USER, from Axl (see §5) |
| `market_brief_offer` | Daily broadcast offer, one per user per weekday (`marketBrief.notify.js`) | Get the brief → routes to **Axl**, who writes it in his thread · Dismiss |
| `tilt_review` | The house view is past its clock — a stance matured, a macro catalyst landed, or the monthly floor expired (`tilt.monitor` → `reviewDecision`) | Run the review → routes to **Pythia**, who runs it in his thread · Dismiss |

Two cards are **not about the user** — `market_brief_offer` and `tilt_review`. Both announce a
BROADCAST (the daily brief, the house sector view), so the same text goes to everyone and neither
mentions a position, account or holding; both fan out over `listAllUserIds`, and both dedupe by
reading the cards already posted rather than by a flag, so a restart mid-fan-out resumes instead of
double-posting. Both are also **offers**: posted with no tokens spent, the work only runs when
someone confirms. Axl relays that same brief in chat via `get_market_brief`.

`tilt_review` is the strategy desk's wake, and the reason it asks rather than acts is that a
re-author SUPERSEDES the view every user reads — see §monitors. Its dedupe window opens at the last
publish/re-author (`reviewAnchorMs`, off the revision trail — deliberately **not** `updated_at`,
which the monitor's own maturity write moves), floored at the 30-day review cadence so a view left
stale is asked about again rather than forgotten.

Confirming does not answer in the social chat: it resolves the card as read, routes to Axl, and
streams the brief into his thread (`POST /api/axl/brief/stream`). A page of market prose does not
belong in a surface built for one-liners, and read in Axl's thread the obvious follow-up — "what
does that mean for my book?" — is the next thing the user types rather than a new journey. (The
answer to that follow-up still may not join the brief to their book; see the unbound tool above.)
The endpoint is a delivery dressed as a turn: no model runs on it, the brief goes out as one token
event, and the pacing the reader sees is the client's typewriter. The thread is per-mount, so the
brief is transient — it is re-askable, never re-read.

`entry_confirm` fires for paper/live idea entries (on `awaiting_confirm`) and
Kairos-ready calls; **manual** entries keep their own FillCard. `entry_confirm`/`call_expiry` for
calls come from Hermes (the Kairos monitor)'s card hook (`enter`→ready, `edit`→expiring, `let_expire`→expired
— the last previously expired silently). Once a call's card fires it leaves the monitor's active
statuses, so no re-fire.

### Axl reception hand-off: `<route>` vs `<edit>`

Axl (`POST /api/axl/stream`) is where the user lands, so it is also the way in to the desks. It hands
them over with one of two tags, and they are different acts: a route names a **desk**, an edit names a
**document**.

- `<route>desk SYMBOL</route>` — NEW work. The desk opens at its `entryTab`, on that name.
- `<open>…</open>` — the desk's FIRST TURN, in the user's own words, sent on arrival as their own
  message. Rides with a route (never with an edit, which resumes a conversation that already exists).
  This is the whole hand-off: Axl works out only what decides WHERE — one position or several, do
  they have a name — and everything else the user said travels as a sentence. Risk, horizon,
  constraints and benchmark are the receiving desk's own first phase, and asking at reception means
  answering twice. Replaced the `objectives` record (2026-08-05), which carried the job as structured
  fields, outlived the job it described, and reached every desk as "already established".
- `<edit>kind ID</edit>` — reopen something they ALREADY have, in the editor that owns it, with the
  conversation that built it restored. Same destination as the list-surface pencil, by design: an
  edit reached from a sentence and an edit reached from a click are one edit.
- `<suggest>…</suggest>` — up to three follow-up questions the user can send with one click, offered
  as chips under the reply. They ride INSIDE the reply already streaming (no second model call, so no
  added latency), and `services/suggestions.service.js` owns the wire format — the tag, the capture,
  the cleaning, the cap of 3 — so one line wires any desk in and the client renders one thing. WHAT
  to suggest is the desk's own judgment and lives in its prompt; a shared "suggestion generator"
  would be the cross-desk unifier the house rule forbids. **Never on a routing turn**: the door Axl
  just opened IS the next step, and three questions beside it compete with the one thing he decided.
  Guarded three times over — the prompt asks, the agent drops them when a `route`/`edit` exists, and
  the controller re-gates at the contract tier. Zero suggestions is a normal turn; filler ("tell me
  more") teaches the user to stop reading the chips, and then the good ones go unread too.

| kind | desk | reopens in |
|---|---|---|
| `call` | trade | Kairos — chat + draft restored (note the trade desk *enters* at Argus; the item picks the tab) |
| `setup` | assist | Mentor — chat + worksheet restored |
| `coverage` | research | Prometheus, in revise mode |
| `scan` | scan | Argus, list primed for refining |
| `portfolio` | portfolio | Atlas — **edit or review, decided by the book** (§3) |

`kind → desk` resolves server-side (`EDIT_KIND_DESKS`), so the client is told which pipeline it is
arriving at and the crumb reads like any other arrival. The controller drops an unknown kind or a
malformed handle and the turn falls back to a plain reply — the same discipline as the desk gate.

The handle is the item's **id**, surfaced by `get_watched_items`, whose every row leads with
`[kind:id]`. A bare ticker (or a one-word book name) also resolves, but **only when it matches
exactly one item** — on two live NVDA calls a ticker is a coin flip, and losing it means editing a
different trade than the user meant, so ambiguity opens nothing. Resolution runs against the lists
the client already holds, which is also the authorization: a ref that isn't in the user's own list is
inert. And an edit carries no `<open>` — the document arrives with its own conversation attached.

---

## 3. Portfolios

Authored by the **Portfolio Agent** (`POST /api/portfolio/stream`), which emits a
`<portfolio_plan>` sized server-side (`_sizePlan`: allocation ratios → live prices → quantities).
Saved as one idea per asset linked by `portfolioId` via `POST /api/trade-ideas/batch`.

- Portfolio ideas start `waiting` with no entry conditions and carry `allocationRatio`.
- **Data tools (FMP Starter):** beyond quotes/risk/correlation, Atlas grounds decisions in `screen_candidates`
  (cross-universe discovery), `get_macro_snapshot` (Treasury curve + 2s10s, key economic indicators, sector
  rotation), and an enriched `get_fundamentals` (EV/EBITDA + FCF/earnings yield + ROIC and the forward analyst
  view — consensus target + buy/hold/sell split; ETF sector look-through). Used in both construction and review.
- **Construction** is gated at two decision points (lock mandate → present regime + architecture →
  then selection/sizing/plan flow); sizing enforces the mandate's hard constraints (max-position /
  sector caps, and the cash floor via a reduced `positionSize`, since `_sizePlan` re-normalizes ratios to 1.0).
- **Review** runs in two modes on the same `reviewMode` stream: **in-position** (live P&L/drift →
  scoreboard + rebalance memo) and **pre-activation** (all-pending book, `~$0` notional — a pre-flight
  check before *Activate all*, no scoreboard). It is **thesis-anchored and data-grounded**: a **fingerprint**
  (`lastFingerprint` — book value, benchmark price, regime, per-holding weight+conviction) is captured at
  construction and each review close, so the review computes a **benchmark-relative scoreboard** (book vs its
  benchmark over the window) and a **regime then→now delta** (rendered into the review-state block by the
  server, not estimated by the model). The scheduled cadence (`reviewCadence`, `nextReviewAt`, 60s monitor)
  **notifies only** — but the notification carries a cheap non-LLM **pre-check** (`computeReviewSignals` →
  `triggers[]`: conviction fell / regime shift / drift / benchmark lag / imminent earnings); the full memo is
  generated only when the user opens the review (user-initiated via the bubble, the portfolio-row review
  action, the *Activate all* gate, or simply reopening a book that holds a position — see the next
  bullet). Nothing auto-executes — changes stay Accept-gated. Endpoints:
  `GET /pending-reviews`, `POST /:portfolioId/rebalance`, `POST /:portfolioId/complete-review`.
- **Edit or review is the BOOK's call, never the caller's.** Every path that reopens a book — the
  three pencils (cards / table / Floor) and Axl's `<edit>portfolio` hand-off — goes through one
  client-side gate (`handleEditPortfolio` → `isPortfolioReview`, FE `tradeIdea.utils.js`):
  nothing in a position → the plan reopens as a construction **edit**, which sends every holding back
  to `waiting` until re-activated; any leg `long`/`short` → it opens as a **review** instead, because
  re-planning would take an open position off monitoring in order to rewrite a plan the market has
  already acted on. A caller may still FORCE a review (a due-review pencil, the review card, the
  *Activate all* gate); none can force a plain edit on a book holding a position. `hit` sits below the
  line — a parked order is not a position — so an activated-but-unfilled book still re-plans, and its
  pending orders stand down with it. The four paths disagreed before this gate existed: the lists
  forced a review only when one was DUE, the Floor pencil never did.
- **Activation is offered wherever a book is listed.** A built book sits at `waiting` doing nothing,
  so every list that shows one can send it live: the cards, the ideas table, and (since 2026-08-05)
  the Floor's portfolio row, which shows `waiting` on the row and reveals an Activate control on
  hover. All three open the same pre-activation gate (`ActivatePortfolioDialog` — *Review first* /
  *Activate now*) and share one meaning of activation (`activatePortfolio`, FE `tradeIdea.utils.js`):
  on a broker each `waiting` leg moves to its own activation status; in **manual** nothing flips and
  the N-leg entry card is posted instead, because with no broker to tell, moving a status would claim
  a position nobody opened. Offered only while EVERY leg is still waiting — a half-working book is
  managed leg by leg.
- Portfolio holdings are governed by the scheduled review, **not** the intrabar invalidation watcher.

---

## 4. Scans

The **Scanner Agent** ("Argus", `POST /api/scanner/stream`) emits a `<scan_list>` (normalized:
uppercased tickers, guaranteed period/thesis/direction/signals). A scan is a watchlist of
candidates (`{ ticker, direction, thesis, analysis, signals, conviction, sources }`), not ideas.
CRUD at `/api/scanner/scans` (`PUT` to update). A user promotes a candidate into **Mentor**, where
the same funnel converges to a single pick and becomes a monitored `setup`. The hand-off tag is
still literally `<kairos_pick>` — it was named for the desk that used to receive it, and renaming a
tag both repos parse is a migration, not a docs fix. Read it as "the single-pick hand-off".

Argus runs a **systematic-discovery funnel** — candidates come from grounded sources, never
model memory. Phase 2 casts a wide net (`screen_candidates`, `get_market_movers`,
`get_sector_snapshot`, `get_analyst_actions`, `web_search`) then coarse-triages via
`get_price_action`; Phase 3 narrows survivors with a `get_candles`/`get_indicators` baseline plus
angle-triggered tools (fundamentals, positioning, cycle, `get_orderblocks`/`get_false_breaks`) and
`get_chart` (KLineChart image, model-only) reserved for the top shortlist; Phase 4 emits the ranked
list. Via the single-pick hand-off (`<kairos_pick>`, see above) the same funnel converges to one name.

---

## 5. Broker & paper routing

All trading goes through `broker.service.js` → `getBrokerAdapter(type)` → an adapter implementing
the `BrokerAdapter` contract. **Consumers branch on `capabilities()` flags, never on broker name.**

| Broker | Status | Trading |
|--------|--------|---------|
| `ctrader` | live | full — OAuth+REST for accounts, ProtoOA WebSocket for orders/positions/exec (`nativeProtection` true); serves candles via trendbars (`ohlcv` true) |
| `paper` | live | full — virtual venue, fills against the live price feed (`nativeProtection` false → exits rest as `positionId` closing orders) |
| `ibkr` | in progress | data-only over IB Gateway / TWS socket (`@stoqey/ib`; `ohlcv` true, trading false) — **paused; do not extend without asking** |

### Off-hours: nothing executes while the venue is shut

**RULE (2026-08-07): nothing executes off-hours, paper included.** A real market order cannot fill
into a shut market, and a simulation that fills anyway — at yesterday's close — is not simulating
anything. A decision confirmed while the venue is closed is **queued**, the user is told so at the
moment they act, and they execute it from a list at the open. Full design:
[docs/architecture/off-hours-queue.md](docs/architecture/off-hours-queue.md).

- **One gate, one place.** `executionGate.deferIfClosed({ userId, asset, assetClass, origin, action })`
  → `{ deferred:false }` (proceed) or `{ deferred:true, id, nextOpenMs }` (queued — **do not touch the
  broker**). Every path about to send an order asks it. It replaced five call sites that each decided
  hours policy and disagreed: two refused, one deferred, and the review's add/trim/exit fired blind
  into a closed market. It ENQUEUES rather than merely refusing — refusing alone loses the decision.
- **A queued action is an intent with no entity of its own** (`pending_actions`). Deliberately not an
  `orderState` flag: `awaiting_market` means one specific thing ("this entity carries a pending
  ENTRY plan") and cannot hold two intents for one holding. `enqueue` is idempotent per
  `(user, entity, verb)` while the row is open.
- **Cancelling reaches back into the desk that decided.** `originRegistry` holds one `execute` +
  `cancel` per origin (`portfolio_item · call · setup · idea`), keyed not switched; the gate
  **refuses to queue an unregistered origin**, so nobody can ship a queued item whose desk could
  never be told it was cancelled (an Atlas holding records the refusal in `rebalance_history`, or the
  next review re-proposes the identical trim).
- **`queuedBy` is the dispatch, not the verb.** A holding carries BOTH a review's exit and a
  monitor's and both spell `exit` — but a monitor's can be a SLICE (a scaled target carrying one leg),
  and `_exitItem` closes everything, so running it through the user path would liquidate a position
  meant only to be trimmed (`_byDecider`). `user` rows are cancellable; `monitor` rows are **not** —
  the stop is still breached, so dropping the row just re-queues it next tick.
- **Two deferral stores, merged by a READ.** `awaiting_market` on an entity (an entry whose plan is
  built) and `pending_actions` (an intent). `pendingWork.listWaiting` unions them into one row shape;
  neither is ever copied into the other, which would give one order two owners and two states to
  drift. `GET /api/pending-actions` exposes it; `POST /:id/execute` replays the action through the
  SAME `_trimItem`/`_exitItem`/`_addToItem` that first tried it, `POST /:id/cancel` drops it.
- **The market-open sweep drains both stores** and posts ONE `queue_ready` card per USER, from Axl,
  pointing at the list — replacing a per-desk per-kind fan-out that put two cards in the same second.
  Exactly-once twice over: entities via `claimIf`, queued rows via `transition(…, { from: QUEUED })`
  (the default is "any OPEN state" and RELEASED *is* open, so without it two overlapping ticks each
  post a card).
- **A queued close freezes its position's exit checks** (`awaiting_market_close`, the rule
  `awaiting_manual_close` already had) — otherwise the still-true condition re-fires every poll and a
  stop and a target both look true on one stale candle. `awaiting_market_close` is NOT a variant of
  `awaiting_market`: the sweep's entity drain matches the latter exactly, so a deferred CLOSE is never
  promoted to `awaiting_confirm`.
- **Carve-outs.** Manual books are never gated (a Fill card is an instruction, not an execution).
  Crypto never defers. A failed queue write still BLOCKS the order — losing the row is a bookkeeping
  failure, sending the order anyway is a trading one.
- **Known gap:** no expiry. `STATES.EXPIRED` exists and nothing sets it, so an action whose venue
  never opens (delisted symbol, bad asset class) sits queued forever.

### Paper mode

- **Account binding is per-idea and explicit** (paper account picked in the selector, exactly one per
  idea). There is **no silent default** — the global toggle (`/api/paper/mode`) is a workspace VIEW
  switch only, never a router. An item with no account bound resolves to no venue; the authoring
  desk prompts the user to pick an account before the setup is finalized.
- Paper is a real broker adapter, so the same monitor + reconciler drive it unchanged. Fills come
  from the app's OHLCV feed (NOT cTrader); cost model = spread (bps) + commission per trade.
- Decided at **save time**: changing the view does not convert or freeze existing ideas.
- **Touch working orders fill on a sampled price.** The paper fill engine samples the Yahoo last quote
  (`latestMarkPrice`, ~3s fast cache; candle-close fallback for symbols Yahoo can't price) and fills a
  resting limit/stop the first sweep price crosses the level. This is a touch approximation — a spike
  that reverts inside a ~3s window can be missed. Only paper working orders (`touch` exits/entries) go
  through this path; `structured` exits still fire at candle close via the monitor.
- `trades` (append-only) captures BOTH paper and live, tagged `mode: 'paper' | 'live'`. Idea-linked
  fills are captured by the reconciler; a paper position with **no matching idea** is still captured
  directly (`captureOpenBare`, idealess fallback — mutually exclusive with the idea path, no double
  capture) so every closed paper trade appears in trade history.

### Venue gate

Every monitored idea must have a venue. If a child resolves to `broker == null` (no account resolved and
paper off), `saveIdea` **rejects** it (`{ok:false, reason:'no_venue'}` → HTTP 422) and the monitor skips any
`broker === null` idea. The *primary* gate is agent-level (setup won't proceed without a marked account/paper);
this is the backstop. (Legacy ideas predating the `broker` field are `undefined`, not `null`, and are untouched.)

### Symbol normalization + getTicker

The app speaks one **canonical asset** per instrument. `brokerSymbol.service.js` renames only genuine
index-future↔cash-CFD aliases per broker (cTrader `NQ↔US100`, `ES↔US500`, `YM↔US30`, `RTY↔US2000`);
everything else resolves by identity. Paper uses canonical symbols unchanged. At fork time the persisted
`brokerSymbol` is the broker's **real** tradable name, resolved by `adapter.resolveSymbol` (getTicker) against
the live symbol list (`NQ`→static `US100`→broker `US100.cash`), falling back to the static map on
unsupported/unreachable/not-listed. Cross-account suffixes (`.cash`/`.spot`) resolve tolerantly.

### Native price space (basis conversion)

A broker may price an instrument differently from the real-market reference the user analyzes: cTrader trades
the Nasdaq-100 as the **US100 cash CFD**, but levels are read off the **NQ future** — a ~227pt basis. Only
**index futures** carry such a gap (oil/gold/stocks ≈ the same instrument the broker lists → ~0).

- **Measured once, at fork.** `computeBasisOffset` = `yahooClose(cashIndex) − yahooClose(future)` (e.g. `^NDX − NQ=F`,
  both settled daily closes → delay-free, alignment-free). Persisted as `idea.basisOffset` (a scalar; `0` for
  everything that isn't an aliased index future, so a no-op elsewhere).
- **Conditions are never rewritten** — they stay in the authored (real) price space.
- **Monitor:** the primary instrument's candles come from the broker (`capabilities().ohlcv`) and are shifted by
  `−basisOffset` (O/H/L/C only) into the authored space, so conditions compare unchanged. Cross-asset legs / paper /
  no-broker use the app feed. (Broker-served candles are also cost-free vs the paid app feed.)
- **Execution:** order prices are shifted by `+basisOffset` into the broker's space (`buildExitOrder`, resting entry).
  Persisted `entryTriggerPrice` / `exitOrders.price` stay REAL (the app shows real prices; the broker order holds the
  shifted price — surfaced by a "trades as US100" pill). The legacy `basisReferenceQuote` adapter shift is neutralised
  (no double-conversion).

---

## 6. Key collections

- `ideas` — the central document (status, direction, condition trees, timeframes, invalidation,
  brokerOrders, exitOrders, allocationRatio, portfolioId, broker, accounts, `brokerSymbol` (getTicker-resolved),
  `basisOffset` (fork-measured price shift, 0 unless aliased index future), `groupId` (multi-broker fork display)…).
- `trades` — append-only point-in-time capture of each opened/closed idea (paper + live).
- `kairos_calls` — the Kairos discretionary "call" (identity + plan + monitor_state), watched by Hermes.
  Two context fields are **frozen at build** for the monitor to weigh: `event_risk` (upcoming earnings +
  Fed/macro within ~10d, `buildEventRisk`) so Hermes holds off entering into an unresolved binary; and
  `market_sensitivity {level, drivers, note}` — how much the asset tracks the broad market. Hermes reads
  the tape **live** at assessment (gated by `level`; `drivers` are the correlated proxies it pulls), and
  a tentative entry on a market-sensitive call is web_search-confirmed before it fires.
- `coverage` — the Analyst's living per-name research thesis (one doc per user+symbol): the variant
  perception (`thesis`), `rating`, OUR `price_target` + `estimates` vs consensus, the `gap` (our PT vs
  the Street — the edge), monitorable `kill_criteria`, `status` (active│thesis_broken│target_hit│retired│
  watchlist), and an append-only `revisions[]` history. `compute_valuation` (deterministic, `services/
  valuation.engine.js`) fills the PT/gap; the Analyst agent + coverage-monitor are in progress. Buy-side
  research — NOT an execution-tier entity, watched by its own monitor, not Hermes/Talos/Themis.
- `pending_actions` — the OFF-HOURS QUEUE (§5): one row per decision confirmed while the venue was
  shut. An intent, not an entity — `{ userId, origin{kind,id,label}, action{verb,…}, queuedBy,
  cancellable, state }`, idempotent per `(user, entity, verb)`. Lifecycle `QUEUED → RELEASED
  --claim--> EXECUTING → DONE`, unwinding to RELEASED on failure. Never joined into the entity it
  acts on; unioned with parked entities only by the `listWaiting` READ.
- `paperAccounts` / `paperPositions` / `paperOrders` — the virtual broker store.
- `chat_conversations` / `chat_messages` — social DM + bot notifications; one notify bot per agent
  (`BOT_IDS`, incl. `kairos`). A RETIRED bot's thread is kept but hidden from `getConversations`
  (`RETIRED_BOT_IDS` — `idea`). `chat_messages.type`/`payload` drive the typed notification cards
  (invalidation_alert, portfolio_review, manual_entry/exit, entry_confirm, call_expiry — see §2);
  `chat_messages.dismissed`/`dismissOutcome` persist the handled state of an actionable card.
- `threads` — unified agent conversation threads (idea / portfolio / scanner). A conversation gets a
  subject-independent `threadId` at the start and moves through three tiers: **trivial** (below the
  agent's substantive floor — `thread.util.isSubstantive` over the agent's *emitted phase*, not
  content → never saved), **draft** (`saveDraft`; TTL-expired via `expiresAt` + LRU-capped per user),
  **linked** (`linkToArtifact` stamps `subjectId` to the generated idea/portfolio/scan and clears the
  TTL). Portfolio drafts persist server-side inline; idea/scanner drive drafts client-side through
  `/api/threads` (their server never holds the full conversation). Fixes the mandate re-send hack —
  construction state is durable before the artifact exists.
- Portfolio/scanner legacy chat state (`portfolio_chats` / `scanner_chats`) still persists per
  user/portfolio for post-create edit restore; being superseded by `threads`.

---

## 7. Auth & exposure

- JWT in an httpOnly cookie; `requireAuth` guards most routes. `req.user._id` is the custom string id.
- **Authed (cost/abuse guard):** transcribe.

---

## 8. Workspaces & venue awareness

### The three workspaces

`live` · `paper` · `manual` are the **book the user is standing in**. Siblings, not a toggle plus a
special case:

| Workspace | Money | Who executes | How it is derived |
|---|---|---|---|
| `live` | real | the app, at a connected broker (cTrader; IBKR in progress) | the default |
| `paper` | simulated | the app, against live prices | `listConnections().paper` — the paper `enabled` flag |
| `manual` | **real**, at an institution the app cannot reach | **the user**, at their bank; they confirm the fill here | the user's stored choice |

**Manual is paper's twin in everything the app does** — same virtual account store, same marks off
live prices, same condition monitoring, same journal (it inherits paper's Layer A and swaps only the
fill engine for a user-confirmation loop). Exactly two things separate it from paper: the money is
real, and execution is external. One thing separates it from live: the numbers are the user's word,
not a broker read — an adopted book's balances and cost basis are what they told us.

**Resolution rule** (`api/workspace/workspace.model.js#resolveWorkspace`, mirrored verbatim in the
frontend's `useWorkspaceMode`): the paper flag WINS over anything stored; otherwise a stored
`manual` means manual; otherwise live.

Manual is broker-less, so unlike paper it has **no connection flag to derive itself from**. The
choice is persisted per user (`user_workspace`) and served by `GET`/`PUT /api/workspace` →
`{ workspace, stored }`. Before that record existed the server read every manual user as live.

### What is scoped, and what is shared

An entity belongs to a workspace **if it binds to an account**:

- **scoped** — `call`, `setup`, `portfolio`. Each is real money or simulated money and never both,
  so mixing them into one list is not an answer. A book carries `modes[]` rather than one value: a
  book appended to across a workspace switch is genuinely mixed and shows in **every** workspace it
  holds something in, because listing it in only one makes the other half unreachable.
- **shared** — scans, coverage, the house forecast, and the market brief. Research binds to no
  account. There is nothing to scope them by and nothing gained by trying.

Enforced in both places it is visible: `listWatchedItems({ workspace })` for what the desks report,
and `inWorkspace()` over every list on the frontend.

**The workspace is a UI/authoring scope and NEVER an engine filter.** The monitors and the
reconciler process every mode regardless — a live stop must fire while the user is looking at paper.

### The venue block — every desk, every turn

`get_trading_context` was wired into every agent and desks still opened turns asking "are we in paper
or live?". A tool is an invitation, and a model mid-thought declines it. So the four venue facts are
**pushed** into every turn instead of waited for (`buildVenueSection`), and `VENUE_RULE` (authored
once beside `LANGUAGE_RULE`) states that asking anyway is a failure:

1. the current workspace, 2. the connected live broker, 3. every account, 4. **available to deploy**.

It forbids asking for FACTS, never deciding with them — which account fits and whether the cash
supports the trade remain the desk's own judgment.

- **Placement is load-bearing.** The block rides the last user message (`attachTurnContext`), not the
  system prompt: free cash moves whenever anything fills, and a volatile system block sits ahead of
  the whole conversation in the cache prefix.
- **Positions and P&L are deliberately excluded** — they move every tick and are the bulk of the
  tokens. That is what `get_trading_context` is still for.
- **Excluded desks:** Pythia and the market brief. Both write for every user at once, so neither has
  a book to report; neither carries the venue tools either, for the same reason.
- **A failed read says so.** Silence would let a desk invent a mode; the block reports the failure and
  forbids both guessing and asking the user to fill the gap.

### Available to deploy ≠ balance

Sizing must use **free cash**: the balance minus what open positions already tie up. A virtual
account's cash is never debited when a position opens, so only the adapter derives it — reading the
account documents directly (which `getTradingContext` once did for paper/manual) yields no
`freeMargin` at all, and every desk silently falls back to balance and spends the same money twice.
Where a venue genuinely does not report it, that absence is stated rather than papered over.
