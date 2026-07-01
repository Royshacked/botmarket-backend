# App Spec

Behavioral contracts for the core domain. For the architecture overview + ASCII
flow diagrams see [README.md](README.md); for file layout see [CODE_MAP.md](CODE_MAP.md).

The app turns natural-language chat into **monitored trade ideas** that route to a
broker. Three agents produce work; one background monitor evaluates it; one
reconciler keeps idea state honest against the broker.

---

## 1. Trade Idea lifecycle

An idea is authored by the **Trade Agent** (`POST /api/orchestrator/stream`), which emits
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
- **Exits are always broker/stop-owned.** `touch` exit levels rest as broker closing orders
  (`positionId` reduce-only on hedging brokers); non-`touch` exits are watched by the software
  monitor and closed via a market order when they fire.
- **The reconciler is broker-authoritative.** On a reduce/close it asks the broker whether the
  position survived (`findOpenPosition`) before mutating idea state — it never closes an idea on a
  transient/unknown result.
- **Delete lock:** live ideas (`hit`/`long`/`short`) cannot be deleted (409 `reason:'in_position'`).

---

## 2. Condition trees & evaluators

Entry / stop / TP are **condition trees**: AND/OR group nodes over typed leaves. The monitor
(`monitor.service.js`, ~60s) evaluates them via `monitor.orchestrator.evaluateTree`.

**7 leaf types** (`monitoring/evaluators/*`):

| Type | Fires on | Notes |
|------|----------|-------|
| `touch` | price crossing a level, intrabar | becomes a native broker order for exits |
| `structured` | a pattern at candle **close** | monitored, not intrabar |
| `indicator` | TA condition (RSI/EMA/SMA/ATR/MACD/VWAP…) | grammar in `parsers/indicators.parser.js` |
| `time` | a session/clock condition | |
| `volume` | bar or cumulative volume threshold | intraday, session-anchored |
| `news` | an LLM judgment over recent news | Haiku YES/NO (`parseYesNo`) |
| `chart` | an LLM vision judgment over a chart image | |

- A leaf's **timeframe** resolves via `resolvePhaseTimeframe` (entry/stop/tp). Per-leaf pass/fail
  is persisted to `conditionStates` for the UI (both the tree path and the legacy flat-array path).
- Adding an 8th type = new `evaluators/<type>.evaluator.js` + wire into `_evalOne` + the parser.

### Invalidation (advisory, never executes)

`idea.invalidation.range = { lower, upper, *Anchor }` is the actionable entry band the agent
derives from chart structure. `invalidation.monitor.js` watches it deterministically (synthesizes
a `structured` leaf per edge — **no LLM in the hot path**). A candle **close** outside either edge
fires a one-shot advisory alert (bot message + edit deep-link), latched by `invalidation_status`.
It runs pre-entry AND in-position but only INFORMS; exits stay stop-owned.

---

## 3. Portfolios

Authored by the **Portfolio Agent** (`POST /api/portfolio/stream`), which emits a
`<portfolio_plan>` sized server-side (`_sizePlan`: allocation ratios → live prices → quantities).
Saved as one idea per asset linked by `portfolioId` via `POST /api/trade-ideas/batch`.

- Portfolio ideas start `waiting` with no entry conditions and carry `allocationRatio`.
- **Review cycle:** `reviewCadence` (`monthly`/`quarterly`), `nextReviewAt`. `GET /pending-reviews`,
  review-mode stream injects live P&L/drift, `POST /:portfolioId/rebalance`, `POST /:portfolioId/complete-review`.
- Portfolio holdings are governed by the scheduled review, **not** the intrabar invalidation watcher.

---

## 4. Scans

The **Scanner Agent** (`POST /api/scanner/stream`) emits a `<scan_list>` (normalized:
uppercased tickers, guaranteed period/thesis/direction/signals). A scan is a watchlist of
candidates (`{ ticker, direction, thesis, analysis, signals, conviction, sources }`), not ideas.
CRUD at `/api/scanner/scans` (`PUT` to update). A user promotes a candidate into the Trade Agent
to become a real idea.

---

## 5. Broker & paper routing

All trading goes through `broker.service.js` → `getBrokerAdapter(type)` → an adapter implementing
the `BrokerAdapter` contract. **Consumers branch on `capabilities()` flags, never on broker name.**

| Broker | Status | Trading |
|--------|--------|---------|
| `ctrader` | live | full (REST + ProtoOA WebSocket) |
| `paper` | live | full — virtual venue, fills against the live price feed |
| `ibkr` | in progress | data-only (`ohlcv` true, trading false) — **paused; do not extend without asking** |

### Paper mode

- Global per-user toggle (`/api/paper/mode`). When ON, `_partitionByBroker` routes **every new idea**
  to `broker:'paper'` / `accountId='paper-<userId>'`, **ignoring selected live accounts**.
- Paper is a real broker adapter, so the same monitor + reconciler drive it unchanged. Fills come
  from the app's OHLCV feed (NOT cTrader); cost model = spread (bps) + commission per trade.
- Decided at **save time**: flipping the toggle does not convert or freeze existing ideas.
- `trades` (append-only) captures BOTH paper and live, tagged `mode: 'paper' | 'live'`, since both
  flow through the same reconciler.

### Symbol normalization

The app speaks one **canonical asset** per instrument. `brokerSymbol.service.js` renames only genuine
index-future↔cash-CFD aliases per broker (cTrader `NQ↔US100`, `ES↔US500`, `YM↔US30`, `RTY↔US2000`);
everything else resolves by identity. Paper uses canonical symbols unchanged.

---

## 6. Key collections

- `ideas` — the central document (status, direction, condition trees, timeframes, invalidation,
  brokerOrders, exitOrders, allocationRatio, portfolioId, broker, accounts…).
- `trades` — append-only point-in-time capture of each opened/closed idea (paper + live).
- `paperAccounts` / `paperPositions` / `paperOrders` — the virtual broker store.
- `chat_conversations` / `chat_messages` — social DM + bot notifications.
- Portfolio/scanner chat state persisted per user/portfolio.

---

## 7. Auth & exposure

- JWT in an httpOnly cookie; `requireAuth` guards most routes. `req.user._id` is the custom string id.
- **Intentionally public:** news-feed list + SSE stream. **Authed (cost/abuse guard):** transcribe,
  and the per-asset news endpoints (`/asset/:symbol[/sentiment]`).
