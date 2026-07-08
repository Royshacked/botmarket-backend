# Manual (broker-less real-money) mode

Status: **Phase 1 (backend) DONE** 2026-07-07 · **Phase 2 (frontend) DONE** 2026-07-08
(BE 150/150 green, FE build+lint green; NOT live-verified). Idea + portfolio flows both wired
end-to-end. Next: live-verify the full stack (Phase 3). Design settled 2026-07-07.

## Phase 2 (frontend) — what's built
- **Workspace toggle** (parallel agent): tri-state `ideaWorkspace`/`isManualIdea`/`useWorkspaceMode`;
  header cycles Live→Paper→Manual; MainPage filters by `ideaWorkspace`.
- **Account isolation:** `useBrokerAccounts` + `usePositions` now workspace-aware via a shared
  `resolveWorkspace(paperConnected)` (paper→paper, manual→manual, live→real brokers) — no cross-leak.
- **Account picker:** `AccountSelector` treats manual like paper (single-select radio, one per idea).
- **Account manager:** `ManualTradingSection` in UserProfile (lean fork of PaperTradingSection — no cost
  fields, no toggle, no trades) via `manual.service.remote.js` (accounts on `/api/paper/accounts?mode=manual`).
- **FillCard:** unified `ManualFillCard` in ChatWindow renders `manual_entry`/`manual_exit` (N legs,
  inline price/qty, per-leg incremental submit → `manual.service` → `MANUAL_FILLED` event → MainPage
  patches idea + refreshes positions). Dismiss persists like other cards.
- **Suppress + badges:** OrderConfirm skipped for manual ideas (their `orderState` is
  `awaiting_manual_fill`, plus an explicit `ideaWorkspace==='manual'` skip); MANUAL badge (amber) on
  IdeaCard + TradeIdeaCard.
- **Backend touch:** `/api/paper/accounts` GET/POST made mode-aware (`?mode=`/`{mode}`), default paper.

### Portfolio triggers (DONE)
- The portfolio row (both the table `PortfolioGroupRow` and card `PortfolioCard`) detects a manual
  book (`group.ideas.every(isManualIdea)`) and routes its activate/exit through the eventBus:
  **activate** → `MANUAL_PORTFOLIO_ACTIVATE` → `manualService.activatePortfolio` (posts the N-leg
  entry card); the active-state button shows **fill** (re-post entry, `anyOpen` false) or **exit**
  (`anyOpen` true) → `MANUAL_PORTFOLIO_EXIT` → `requestPortfolioExit` (posts the N-leg exit card).
  The pre-activation ActivatePortfolioDialog + Atlas "Review first" still apply (manual-tuned copy).

### Known v1 limits
- FillCard reload shows unfilled inputs again (backend guards prevent double-fill) — cosmetic.
- A manual book reset to waiting isn't offered (the active button records an exit instead) — the
  legs are real tracked positions, so silent deactivation is intentionally disallowed.

A third trading mode beside `live` (cTrader/IBKR) and `paper` (simulation), for a user who
trades **real money** at an institution (a bank brokerage) that **can't be wired to the app**
via API. The app can't place orders or read fills, so execution happens off-platform and the
app records what the user reports.

## The one-line shape

**Manual reuses everything on the *watching* side and only replaces the *acting* side.**
Monitoring, condition trees, positions display, mark-to-market and portfolio-review cycles
are the shared engine, unchanged. The only net-new behaviour swaps
"place order at broker → reconcile off broker events" for
"**notify in social chat → user confirms + types the real price**".

The lifecycle is driven **entirely by two user confirmations** (entry fill, exit fill),
**not** by a broker reconciler or fill engine.

## Two-layer reframe (see paper-trading-simulation.md)

- **Layer A — account / journal (SHARED with paper):** the virtual-account store
  (`paperBroker.service`, `mode:'manual'` + `manual-<userId>-<id>` ids), mark-to-market
  (the 3s `paperMark` loop sweeps *all* store positions, so manual marks for free),
  `computeEquity`, equity curve, workspace scoping.
- **Layer B — execution (SWAPPED):** paper's simulated fill engine + cost model is replaced
  by `manualExecution.service` — open/close a position at the **user-reported price**, with
  **no cost model** (a real fill already includes real costs) and **no `executionBus` emit**
  (nothing to reconcile; the confirm endpoint mutates the idea directly).

`manualExecution` is a *sibling* of `paperExecution` writing to the same store — the physical
Layer A/B seam, done pragmatically (no refactor of paperExecution).

## Components

### Adapter + routing
- `adapters/manual.adapter.js` — a **read-only** adapter reusing the shared store reads
  (`getAccount` via `computeEquity`, `getPositions`, `findOpenPosition`, `getTradingAccounts`,
  `resolveSymbol` = identity, `isConnected` = has ≥1 manual account). `capabilities()` are all
  **false** (data-only): the manual lifecycle never calls `placeOrder`/`closePosition`, so
  trading ops stay unimplemented as a guard, and `ohlcv:false` routes the monitor to the app feed.
- Registered in `broker.factory` → `SUPPORTED_BROKERS` includes `manual`, so
  `resolveUserAccounts` resolves manual accounts and an idea/portfolio bound to a manual account
  **forks onto `broker:'manual'`** through the normal path.
- `broker.service.listConnections` reports `manual` connected when the user owns ≥1 manual account.
- **Mode-scoped positions:** `getPositions(userId)` with no accountId filters by `accountMode`, so
  paper and manual positions never leak into each other's view (applied to the paper adapter too).

### Accounts
- Created via the existing `paperBroker.createAccount(userId, { mode:'manual' })`, but manual
  accounts get **zero-cost settings** (`spreadBps:0, commissionPerTrade:0`) — real fills carry
  real costs. Otherwise identical (name, starting balance for equity tracking, reset/delete).

### Lifecycle seams (the two confirmations)
1. **Idea entry** — `monitor._checkEntry` detects the entry hit → for a manual idea it **skips
   the broker order plan**, sets `status:'hit'` + `orderState:'awaiting_manual_fill'`, and posts a
   1-leg `manual_entry` FillCard to social chat (`sendBotMessage`). The broker OrderConfirm dialog
   is suppressed for manual ideas.
2. **Portfolio activation** — clicking *Activate* posts an **N-leg** `manual_entry` FillCard
   immediately (a market-entry basket the user is executing now — not condition-monitored entries).
3. **Confirm entry** — card submit (per leg, incremental) → `manualExecution.openManualPosition`
   at the reported avg price + qty → stamps the idea's position link and flips it `long/short`.
   The position then shows in the positions view and marks live like any other mode.
4. **Idea exit** — `positionMonitor._exitNow` fires (stop/TP condition) → for manual it **skips
   `closePosition`**, posts a `manual_exit` FillCard + parks `awaiting_manual_close` so it doesn't
   re-alert each poll. Submit → `manualExecution.closeManualPosition` at the reported exit price →
   `closed`. (v1: full close per leg; partial exits later.)
4b. **Portfolio exit (for-now model)** — **USER-initiated, not monitor-driven.** The user notifies
   in social chat that they've exited → the system responds with the **same `manual_exit` FillCard**,
   one row per still-open portfolio leg, each with an exit-price input. Each leg closes incrementally
   via `closeManualPosition` as its price is submitted (same path as the idea exit); flips that leg's
   idea to `closed`. **Partial baskets allowed** — the user fills only the legs they actually exited
   and the rest stay open (the card "waits for him", mirroring the incremental entry card). No
   monitored stop/TP drives a portfolio exit for now; if that's added later it's just a second
   trigger posting the same card — the card and close path don't change.
5. **Portfolio review cycle** — unchanged (shared `portfolio.monitor`).

### Social-chat cards (the only net-new UI, Phase 2)
Reuses the existing specialist-notification pattern (`sendBotMessage` + payload + persisted
Update/Close/Dismiss, exactly like `invalidation_alert`) — **not** the abandoned social-chat
router. One unified `FillCard`: N legs (1 for an idea, N for a portfolio), inline price input
(+ editable qty on entry), each leg opening/closing the moment its price is submitted, card
persisting until all legs are done. Message types `manual_entry` / `manual_exit`.

## Build order
1. **Phase 1 — backend:** account defaults, `manual.adapter` + factory/routing + listConnections
   + mode-scoped positions, `manualExecution.service`, the three monitor/confirm seams, the
   card payloads + endpoints, unit tests on the pure bits.
2. **Phase 2 — frontend:** tri-state `ideaMode` + third workspace tab, manual account manager +
   picker branch, the unified `FillCard` in social chat, suppress OrderConfirm for manual, badges.
3. **Phase 3 — polish, tests, QA/CR/docs cycle.**

## Deferred
- Partial manual exits (v1 closes a leg in full).
- The paid FMP/Massive live-candle feed (removes the monitor's delay — a separate upgrade).
- Trade capture / `trades` journal for manual — handled with the Axl agent work, not here.

Relates to: paper-trading-simulation.md, and memories project_manual_mode,
project_paper_trading_sim, project_paper_live_workspace, project_axl_agent.
