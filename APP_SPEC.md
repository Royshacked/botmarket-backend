# App Spec

Behavioral contracts for the core domain. For the architecture overview + ASCII
flow diagrams see [README.md](README.md); for file layout see [CODE_MAP.md](CODE_MAP.md).

The app turns natural-language chat into **monitored trade ideas** that route to a
broker. Three agents produce work; one background monitor evaluates it; one
reconciler keeps idea state honest against the broker.

---

## 1. Trade Idea lifecycle

> **ARCHIVED 2026-07-29.** The `idea` kind described in this section is legacy: nothing authors
> one any more and neither its agent nor its monitor runs. It is superseded by Kairos's `call`
> (monitored by Hermes) and Mentor's `setup` (monitored by Talos). `/api/idea` is unmounted and
> Minos is not started; the condition-tree machinery below is retained but dormant.

An idea is authored by the **Trade Agent** (`POST /api/idea/stream`), which emits
a `<trade_idea>` block the frontend saves via `POST /api/trade-ideas`.

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

Entry / stop / TP are **condition trees**: AND/OR group nodes over typed leaves. The monitor
(`minos.monitor.service.js`, ~60s) evaluates them via `monitor.orchestrator.evaluateTree`
(ARCHIVED — Minos is no longer started; `evaluateTree` itself stays in use elsewhere).

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
agent (`BOT_IDS = axl · idea · portfolio · scanner · kairos`; only Axl is conversational, the rest
are notify-only feeds), so a card reads "from Idea / Atlas / Kairos". The card is the alert + a
clickable preview; the **existing action UI stays the destination** (deep-link, not embedded action).
Dismiss/handled state persists per-message.

| `type` | Event | Card actions → destination |
|---|---|---|
| `invalidation_alert` | Entry envelope broken (above) | Update / Close / Dismiss |
| `portfolio_review` | Scheduled review due | Review → Atlas review mode |
| `manual_entry` / `manual_exit` | Broker-less fill needed | Inline FillCard (price/qty) — the one embedded-action card |
| `entry_confirm` | Entry triggered, confirm needed (`kind: idea`\|`call`) | idea → workspace + `OrderConfirmDialog`; call → `/call/:id` pop-out |
| `call_expiry` | Kairos thesis expiring/expired (`kind: edit`\|`expired`) | Edit → `/call/:id` pop-out · Delete · Dismiss |
| `market_brief_offer` | Daily broadcast offer, one per user per weekday (`marketBrief.notify.js`) | Get the brief → routes to **Axl**, who writes it in his thread · Dismiss |

The market brief is the one card that is **not about the user**: the same text goes to everyone, is
cached across users, and by construction mentions no position, account or holding. Its offer is
posted with no tokens spent — the brief is only written when someone confirms, and Axl relays that
same brief in chat via `get_market_brief`.

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
CRUD at `/api/scanner/scans` (`PUT` to update). A user promotes a candidate into the Trade Agent
to become a real idea.

Argus runs a **systematic-discovery funnel** — candidates come from grounded sources, never
model memory. Phase 2 casts a wide net (`screen_candidates`, `get_market_movers`,
`get_sector_snapshot`, `get_analyst_actions`, `web_search`) then coarse-triages via
`get_price_action`; Phase 3 narrows survivors with a `get_candles`/`get_indicators` baseline plus
angle-triggered tools (fundamentals, positioning, cycle, `get_orderblocks`/`get_false_breaks`) and
`get_chart` (KLineChart image, model-only) reserved for the top shortlist; Phase 4 emits the ranked
list. Via the Kairos hand-off the same funnel converges to a single `<kairos_pick>`.

---

## 5. Broker & paper routing

All trading goes through `broker.service.js` → `getBrokerAdapter(type)` → an adapter implementing
the `BrokerAdapter` contract. **Consumers branch on `capabilities()` flags, never on broker name.**

| Broker | Status | Trading |
|--------|--------|---------|
| `ctrader` | live | full — OAuth+REST for accounts, ProtoOA WebSocket for orders/positions/exec (`nativeProtection` true); serves candles via trendbars (`ohlcv` true) |
| `paper` | live | full — virtual venue, fills against the live price feed (`nativeProtection` false → exits rest as `positionId` closing orders) |
| `ibkr` | in progress | data-only over IB Gateway / TWS socket (`@stoqey/ib`; `ohlcv` true, trading false) — **paused; do not extend without asking** |

### Paper mode

- **Account binding is per-idea and explicit** (paper account picked in the selector, exactly one per
  idea). There is **no silent default** — the global toggle (`/api/paper/mode`) is a workspace VIEW
  switch only, never a router. An idea with no account bound resolves to no venue; the idea agent
  prompts the user to pick an account before the setup is finalized.
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
  research — NOT an execution-tier entity, watched by its own monitor, not Hermes/Minos/Themis.
- `paperAccounts` / `paperPositions` / `paperOrders` — the virtual broker store.
- `chat_conversations` / `chat_messages` — social DM + bot notifications; one notify bot per agent
  (`BOT_IDS`, incl. `kairos`). `chat_messages.type`/`payload` drive the typed notification cards
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
