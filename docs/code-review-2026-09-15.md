# Code review — full backend, section by section — 2026-09-15

Scope, applied identically to every section: **(a)** architecture · **(b)** conventions ·
**(c)** duplications · **(d)** dead code · **(e)** proper MVC · **(f)** no spaghetti ·
**(g)** no plaster code · **(h)** shared services and helpers.

Method: read every file in the section in full (not the CODE_MAP summary of it), cross-check
callers in backend, tests, and `botmarket-frontend/src`, write the findings with `file:line`,
land approved fixes as one commit per finding-group with the full suite green before each.

Reviewed from backend commit `55f5fbb` (`main`). Test health at start: **2815 pass / 0 fail**.

## Sections

| # | Section | Files | Status |
|---|---|---|---|
| 1 | Broker + execution | `api/broker/**`, `api/paper/**`, `monitoring/execution.reconciler.js`, `monitoring/paper*.service.js`, `services/executionBus.js` | ✅ done — 8 commits `59d08b1`..`06d86d9`, suite **2849 / 0** |
| 2 | Trade tier (`idea`) | `api/trade-ideas/**`, `tradeCapture`, `tradeNotify`, `positionManage`, `protectionPlan`, `monitoring/positionMonitor.js`, `entry.monitor.js` | next |
| 3 | Mentor / setups + Talos | `api/setups/**`, `setup.schema.js`, `mentor.agent.service`, `talos.*`, `monitoring/evaluators/**`, `parsers/**` | |
| 4 | Atlas / portfolio | `api/portfolio/**`, `portfolio.agent.service`, `portfolioState`, `sleeveSource`, `adoptBook` | |
| 5 | Agent runtime | `agentIO`, `agentUtils`, `agentTools.registry`, `services/tools/**`, `pendingAction/**`, `entity/**`, `axl.agent.service`, `api/chat/**` | |
| 6 | Argus / Prometheus / Pythia | `api/scanner`, `api/analyst`, `api/strategy`, `scanner.agent.service`, `coverage.service`, `tilt.service`, `researchRun` | |
| 7 | Providers + market data | `providers/**`, `price.service`, `market.service`, `news.service` | |
| 8 | Aether + scheduling | `api/aether`, `aetherScheduler`, remaining `monitoring/**` | |
| 9 | Platform | `server.js`, `middleware/**`, `config.js`, `api/authentication`, `api/user`, `api/workspace`, `api/_shared`, `api/health` | |
| 10 | Tests + scripts | coverage gaps vs. §1–9, `scripts/**` hygiene | |

---

## §1 Broker + execution — done

**Verdict in one line:** the strongest-designed part of the codebase — the adapter contract, the
capability-flag rule, `executionBus` → reconciler, and the claim-based exactly-once guards are all
sound; the findings were drift, duplication, and four real bugs, one of which (the 401 collision)
only surfaced because a plaster was removed.

### Bugs (found under the lens, fixed in `59d08b1` and `06d86d9`)

| | Where | What | Sev |
|---|---|---|---|
| 1 | `ibkr.adapter.getCandles` | Only knew the legacy timeframe labels; every app timeframe (`5min`, `1hr`) missed the map and came back as **daily** bars — for an adapter whose `ohlcv:true` tells the monitor to prefer them. Now parses the one vocabulary via `parseTimeframe` (as cTrader does), null → app feed. | high (latent) |
| 2 | `paper.adapter.cancelOrder` / `amendOrder` | Unconditional `$set` — a cancel landing after the fill engine claimed the order flipped a **filled** ledger row to `cancelled`. Now `claimOrder` under `status:'working'`; refuses otherwise, as a venue would. | medium |
| 3 | `paper.adapter.listOrders` | Ignored `accountId`; returned every account's resting orders. | low |
| 4 | `ctrader.adapter.getPositions` | Swallowed a connection failure into `[]`, so a disconnected broker read as "no positions" and `tradingContext.unavailable` never learned. Now throws; per-account failure still degrades per account. | medium |
| 5 | `broker.interface._freshTokens` | Threw **401** for a missing/expired *broker* session. The client treats every 401 as app-session expiry (clears storage, leaves the page). #4's swallow had been masking this on the positions poll; `/trading-accounts` was already exposed. Now `BROKER_DISCONNECTED = 424`. | **high** — found in the post-fix bug hunt |

### The lens

**(a) Architecture** — `listConnections` special-cased paper/manual by name (the one place the
broker-agnostic layer knew a concrete venue) → asks each adapter's `isConnected`. `ManualAdapter
extends PaperAdapter` (reuse, not is-a; manual inherited paper's "there is an execution feed") →
`VirtualAdapter` base holding the shared reads, each venue keeping its trading half. Paper's
`getTradingAccounts` created an account on read → reads never create.
*Open by choice:* `broker.interface.js` still hosts `_freshTokens` (an OAuth concern three of four
adapters don't use); an `OAuthBrokerAdapter` intermediate is the clean shape but one adapter doesn't
justify it yet. `ctrader.adapter.closePosition` calls `session._loadSymbols` / `_symbolSpecs`
(provider privates) — §7 decides whether they go public.

**(b) Conventions** — `paper.controller` had 14 hand-rolled `try { … } catch { _fail() }` bodies
beside `broker.controller`'s `_handle`; the wrapper is now `api/_shared/handle.util.js` and both use
it (`aether.controller` still hand-rolls — §8). Stale "Phase N TODO" headers on paper, IBKR,
paperExecution, paperBroker rewritten to the current shape. `brokerService.getCandles` still takes
`userId` last, unlike every sibling — left, since three callers and the interface agree on it.

**(c) Duplications** — paper/manual `getAccount` + `getTradingAccounts` (~60 lines) → one
implementation. Twelve private `_round2`-style helpers in four edge flavours →
`services/number.util.js` (`roundTo/round2/round4/round8`, `roundOrNull`, `roundOrZero`). Two inline
`price + (Number(basisOffset) || 0)` → the existing, tested, unused `applyOffset`.
*Left:* `ibkr.adapter` parses account-summary rows twice; cTrader fetches `/tradingaccounts` from
three methods (a per-user TTL on the account list would also fix the per-op `listCTraderAccounts`
socket round-trip) — both §7.

**(d) Dead code** — removed: the `db` handle threaded through six reconciler functions (and out into
`ideaExecution`), `_findActiveByPosition`, the `getSpot` chain (service + interface + adapter + its
"safe to delete anytime" harness), `paperExecutionService` / `manualExecutionService` aggregates,
`paperBrokerService.getOrder`, three module-internal enum exports, four `/api/paper` single-account
routes with no frontend caller, `providers/ibkr.provider.js` (236 lines, imported by nothing) with
its three env keys, `config.ibkrGwConfigured`, `brokerConnectionService.listConnections`.
*Kept on purpose:* `IBKRAdapter.connectGateway` — no route yet, but the only entry point an IBKR
connection has. `GET /api/paper/accounts/:id/equity-curve` — defined in the FE client, not called.

**(e) MVC** — routes → controller → service → adapter is clean. `broker.controller.getPositions`
joins `ideaService.getAssetClassMap` / `getCallPositionMap` inside the controller — a cross-feature
enrichment that belongs in a service; **§2 decides where** (it is the trade tier's data).

**(f) Spaghetti** — none serious. `_onReduced` is the densest function (100 lines, four decisions)
and is not split: the sequence *is* the invariant, and every branch says why.

**(g) Plaster** — the `[]` swallow (#4), the two silent `catch { /* non-fatal */ }` in
`listConnections` (now one logged warning per venue), the "SAFE DESPITE" comment guarding a
side-effecting read (the side effect is gone), `brokerService.disconnect('paper')` deleting a doc
that never existed (left — harmless no-op, and the route is generic).

**(h) Shared helpers** — added `handle.util`, `number.util`. Noted for §5: `claimOrder`,
`entityRepo.claimIf`, `dueLoop._claim` are three spellings of one guarded-update idiom.

### Behaviour changes a reader should know

- Paper account reads return `[]` / 404 for a user with none; `/api/paper/mode` and `/state` still
  create the default account (the toggle surface).
- `IBKRAdapter.isConnected` no longer dials the gateway.
- Paper `cancelOrder` / `amendOrder` throw on a non-working order; every caller either catches or
  documents "throws → `execution_failed`", which is what cTrader already did.
- Broker-disconnected errors reach the client as 424.

### Frontend follow-ups (botmarket-frontend, untouched)

- `services/paper/paper.service.remote.js` still defines `updateSettings`, `reset`, `getTrades`,
  `getEquityCurve` — their routes are gone.
- A 424 from a broker route is a natural hook for a "reconnect cTrader" affordance.

### Tests added

`ibkrBarSize`, `paperOrderGuards`, `virtualAdapter`, `numberUtil`, `brokerDisconnectedStatus`
(+ harness updated). Suite 2815 → 2849.

### QA / CR cycle on §1 (2026-09-15)

QA: full suite + lint green; every backend module (271) imported once in a scratch script to catch
a deleted export or broken path — 0 failures. CR: an independent review pass over `55f5fbb..HEAD`
traced every removed/changed export to its callers (frontend included) and found **no medium/high
issues**; five lows, three fixed in the cycle commit:

| | Finding | Outcome |
|---|---|---|
| 1 | `GET /api/paper/state` still mints the default account, while the new docs said reads never create | Documented as the exception: the toggle surface (`/state`, `/mode`) resolves the default account by design; the *account routes* never create |
| 2 | Paper `cancelOrder`/`amendOrder` refusals were bare `Error`s → HTTP 500 on the user's ✕ landing a beat after the fill | `status: 409` — a conflict on a normal path |
| 3 | `VirtualAdapter.getTradingAccounts` applied paper's `cash × maxLeverage` to manual accounts too (the settings PATCH is mode-agnostic, so a manual account can carry a stray cap) | `_buyingPower(acct)` hook — base null, paper overrides; pinned by test |
| 4 | `ibkr.gateway.provider.js` header still named the deleted `ibkr.provider.js` as its companion | Header fixed |
| 5 | FE `paper.service.remote.js` still defines four client methods for deleted routes | Frontend follow-up (listed above) |
