# Trades Data — the Canonical Trade Entity

The `trades` collection is the append-only ledger of every position that was ever
opened, across every mode and origin. It is the **single source of truth for
analytics** — statistics, reports, equity curves, and (later) the Axl performance
layer, which reads it over MCP.

Design rule: a trade is **self-contained and frozen at fill**. Everything needed to
analyse it later lives on the trade document itself — never joined at read time from
`ideas`, `kairos_calls`, or `portfolio_chats`, because those records get edited or
deleted and would make historical reports drift. Volatile context is *copied in* at
open time and never mutated afterwards (except the `exit` patch on close).

Written by `services/tradeCapture.service.js` (the only writer). One document per
`(accountId, positionId)`, upserted on open, patched on close.

> **Status legend** — ✅ stored today · ➕ net-new for the canonical entity.

---

## The trade document

```jsonc
{
  // ── identity ────────────────────────────────────────────────
  "tradeId":     "uuid",              // ✅
  "mode":        "paper|live|manual", // ✅ (manual — gap 4)
  "status":      "open|closed",       // ✅

  // ── instrument & venue ──────────────────────────────────────
  "symbol":      "US100",             // ✅  (idea.asset)
  "asset_class": "crypto|equity|...", // ✅
  "direction":   "long|short",        // ✅
  "quantity":    1.5,                 // ✅
  "broker":      "paper|ctrader|...", // ✅
  "accountId":   "…",                 // ✅
  "positionId":  "…",                 // ✅

  // ── origin: what spawned this trade ─────────────────────────
  "origin": {                         // ✅ (gap 1 — replaces the loose top-level ids)
    "type":        "idea|call|portfolio|null", // ✅  null = idealess/manual
    "ideaId":      "idea_…|null",     // ✅  execution vehicle (null only if idealess)
    "callId":      "call_…|null",     // ✅  set ⟺ Kairos call. This IS the "is-a-call" flag
    "groupId":     "…|null",          // ✅  fork group
    "portfolioId": "…|null",          // ✅
    "portfolioName":  "…|null",       // ✅
    "allocationRatio": 0.2            // ✅
  },
  "userId": "…",                      // ✅

  // ── entry ───────────────────────────────────────────────────
  "entry": { "price": 20000, "ts": 1720000000000 },   // ✅

  // ── exit (null until closed) ────────────────────────────────
  "exit": {                           // ✅
    "price":       20500,
    "ts":          1720003600000,
    "reason":      "stop|tp|manual|broker",
    "realizedPnl": 500              // authoritative P&L for this trade (see below)
  },

  // ── costs (round-trip total: entry-fill + exit-fill, $inc-accumulated) ──────
  "commission": 4.0,                  // ✅ gap 5 — 0 when not modeled (manual; paper w/ no fee)
  "spread":     2.5,                  // ✅ gap 5 — paper only (baked price → itemized); 0 for live/manual

  // ── frozen context at fill (never mutated) ──────────────────
  "snapshot": {                       // ✅ base, ➕ origin-specific additions
    // idea-originated setup — already frozen today ✅
    "entry_condition_tree": {…}, "stop_condition_tree": {…}, "tp_condition_tree": {…},
    "entry_conditions": [], "stop_conditions": [], "tp_conditions": [],
    "entry_timeframe": "…", "stop_timeframe": "…", "tp_timeframe": "…",
    "invalidation": {…},
    "notes": "…",
    "conviction": {…},

    // call-originated reasoning — frozen from the Kairos call ✅ (gap 2; null for idea/portfolio)
    "thesis":      "full call thesis text",
    "bias":        "long|short|both",
    "entry_zones": [{…}],
    "patterns":    [{…}],

    // portfolio-originated reasoning — frozen from portfolio_chats.thesis ✅ (gap 3; null for idea/call)
    "portfolioThesis": { "strategy": "…", "targetExposures": [] }
  },

  "accountSnapshot": { "equity": 100000, "cash": 50000, "currency": "USD" }, // ✅ best-effort at fill

  // ── timestamps ──────────────────────────────────────────────
  "openedAt": 1720000000000,          // ✅
  "closedAt": 1720003600000           // ✅ (null until closed)
}
```

---

## Origin model

A trade always records **what spawned it** via `origin`. The three cases:

| Origin        | `type`        | `ideaId` | `callId` | frozen reasoning in `snapshot`     |
|---------------|---------------|----------|----------|------------------------------------|
| Idea chat     | `'idea'`      | set      | `null`   | condition trees + conviction       |
| Kairos call   | `'call'`      | set      | **set**  | condition trees **+ call thesis/bias/zones/patterns** |
| Portfolio     | `'portfolio'` | set      | `null`   | condition trees **+ portfolioThesis** |
| Idealess/manual | `null`      | `null`   | `null`   | none                               |

Key facts:

- **`ideaId` is the execution vehicle and is almost always set.** Every trade rides
  the idea → monitor → reconciler → broker pipeline, so an idea exists even for
  Kairos calls. `ideaId` is `null` only for idealess capture (a broker fill with no
  matching idea).
- **A Kairos call is an idea *plus* a `callId`.** The confirm handoff materializes a
  real idea from the call; `callId` is the extra pointer recording that a call gave
  birth to it. `callId != null` is therefore the canonical "count this as a call"
  flag — used for filtering, grouping stats, and tracing back to the call's thesis.
  The call itself survives only as a lightweight shadow (`kairos_calls.linked_idea_id`,
  `position_state`); the authoritative lifecycle runs through the idea and lands here.
- The `origin.type` values (`portfolio` vs `idea`) are distinguished by whether a
  `portfolioId` is present; `call` by whether a `callId` is present.

---

## Stored vs derived

Everything an analytics layer needs is **derivable** from the stored fields — do not
store computed metrics on the trade:

| Metric              | Derived from                                              |
|---------------------|----------------------------------------------------------|
| P&L %               | `exit.realizedPnl` / notional at `entry`                 |
| R-multiple          | `(exit.price − entry.price)` vs `entry.price − stop level` (stop from `snapshot`) |
| Duration            | `closedAt − openedAt`                                     |
| Win / loss          | `sign(exit.realizedPnl)`                                  |
| Net vs gross        | `exit.realizedPnl` (net) vs re-add `commission` + `spread`|
| Per-symbol / mode / origin / portfolio breakdowns | group by the stored fields |

**Authoritative P&L is `trade.exit.realizedPnl`.** The idea also stamps its own
`realizedPnl` on close, but reports read the trade ledger — the idea copy is for the
idea's own UI and is not the analytics source of truth.

---

## Read API — `/api/trades` (`api/trades/trades.routes.js`)

The unified analytics read surface over the ledger — **every mode** (paper + live +
manual), unlike the paper-scoped `/api/paper/*` trade routes. Read-only, `requireAuth`,
scoped to the caller's `userId`. This is what reports/graphs consume and what the Axl
performance layer will hit over MCP.

| Route | Returns |
|---|---|
| `GET /api/trades` | `{ trades }` — newest first. Filters (all optional): `mode`, `status`, `symbol`, `origin` (=`origin.type`), `portfolioId`, `callId`, `accountId`, `fromMs`/`toMs` (openedAt range), `limit`. Omit `mode` → all modes. |
| `GET /api/trades/stats` | `{ stats }` — realized-performance fold over **closed** trades matching the same filters. |

`stats` shape — `{ overall, byMode, byOrigin, bySymbol }`, where each group is the same
summary (`computeTradeStats` → `_summarize`, a pure exported helper):

```
count, wins, losses, breakeven,
winRate,        // wins / count  (breakeven in the denominator)
netPnl, grossProfit, grossLoss,
profitFactor,   // grossProfit / grossLoss  (null when grossLoss = 0)
avgWin, avgLoss, expectancy,     // expectancy = netPnl / count
avgDurationMs, best, worst
```

All derived from `exit.realizedPnl` + timestamps — nothing computed is stored on the
trade. Service layer: `tradeCaptureService.listTrades` / `tradeStats`; the pure
`computeTradeStats(trades)` is exported for reuse (e.g. callers that already hold trades).

> **Not yet exposed:** R-multiple (needs reliable stop-price extraction from the
> snapshot's condition tree) and any *unrealized* view of open trades (needs live marks).
> Both are additive on top of this surface.

---

## Lifecycle & capture path

```
call ─confirm→ idea{callId} ─fill→ ┐
idea chat ────────→ idea ─fill→    ├─ execution.reconciler ─→ captureOpen  → trade{status:'open'}
portfolio ────────→ idea ─fill→    ┘                          captureClose → trade{status:'closed'}
broker fill (no idea) ─────────────→ captureOpenBare (idealess)
```

- Capture is driven by `monitoring/execution.reconciler.js` reacting to
  `executionBus` events (`position.opened` / `reduced` / `closed`).
- Capture is **best-effort** — it never throws into the execution hot path.
- One trade doc per `(accountId, positionId)`: `captureOpen` upserts it, `captureClose`
  patches `status`/`exit`/`closedAt` filtering on `status:'open'`.

---

## Capture gaps to reach canonical (deltas from today)

**All six gaps are DONE (2026-07-11).** The ledger is now the canonical self-contained
analytics asset: captures paper + live + manual, with origin context, frozen call/portfolio
reasoning, round-trip costs, and indexes. History below for provenance.

1. ~~**`origin` block + `callId`**~~ — **DONE.** `callId` stamped on the idea at the
   Kairos handoff (`buildIdeaFromCall`) + whitelisted in `saveIdea`; `captureOpen` /
   `captureOpenBare` build the `origin` block via the pure `buildOrigin(idea)` helper
   (`tradeCapture.service.js`); `listTrades` filters `origin.portfolioId` / `origin.callId`.
   Loose top-level ids (`ideaId`/`groupId`/`portfolioId`/…) are gone — replaced by `origin`.
   *Migration note:* trade docs written before this change keep the old flat shape (no
   `origin`); readers of historical docs must tolerate a missing `origin`, or run a
   one-time backfill.
2. ~~**Freeze call reasoning**~~ — **DONE.** `captureOpen` best-effort reads the
   `kairos_calls` doc when `idea.callId` is set (direct collection read, no service import)
   and freezes `thesis`/`bias`/`entry_zones`/`patterns` into `snapshot` via the pure
   `pickCallReasoning(call)` helper (null for idea/portfolio trades). The idea schema
   stays clean — call concepts never leak into `ideas`. Live-verified end-to-end.
3. ~~**Freeze portfolio thesis**~~ — **DONE.** `captureOpen` best-effort reads
   `portfolio_chats.thesis` (by `{portfolioId, userId}`, direct collection read) for
   portfolio-linked ideas and freezes `{strategy, targetExposures}` into
   `snapshot.portfolioThesis` via the pure `pickPortfolioThesis(thesis)` helper (null for
   idea/call trades; version/meta dropped). Live-verified.
4. ~~**Manual mode**~~ — **DONE.** Manual has no reconciler (the confirm endpoints flip
   idea status directly), so `manualIdea.service` now calls the same capture hook the
   reconciler uses: `captureOpen` in `confirmManualEntry`, `captureClose` in
   `confirmManualExit` (best-effort, never throws). `modeOf` maps `manual → 'manual'`.
   Reuse means manual trades inherit the `origin` block + call-reasoning freezing. Manual
   trades land with `mode: 'manual'`. Live-verified entry→exit. *(Read-side note: the
   `/api/paper` trade routes hard-code `mode:'paper'`, so manual trades aren't exposed via
   HTTP yet — that's part of the future analytics read API, not capture.)*
5. ~~**Discrete `commission` / `spread`**~~ — **DONE.** Per-fill `commission`/`spread`
   now ride the `BrokerExecution` event; `captureOpen` stores the entry fill and
   `captureClose` **`$inc`-accumulates** the exit fill → the trade holds the round-trip
   total. Paper emits both (commission = `commissionPerTrade` per fill; spread =
   `|fill − mid| × qty`); cTrader carries `deal.commission` (spread not itemized by the
   broker → 0); manual = 0 (no cost model — real costs are already in the reported net
   P&L). Both default to 0 (numeric, keeping `$inc` safe). Live-verified: paper producer
   emits + capture round-trip accumulation.
6. ~~**Index `trades`**~~ — **DONE.** `ensureTradeIndexes()` (`tradeCapture.service.js`,
   wired in `server.js` startup) creates: `(accountId, positionId)` **unique** (identity/
   idempotency), `(userId, openedAt desc)` (list + sort), and `(userId, origin.portfolioId)`
   / `(userId, origin.callId)` (analytics slices). Live-verified against the DB.

See `paper-trading-simulation.md` for the equity-curve time-series (`paperEquity`),
which is a separate, paper-only asset today.
