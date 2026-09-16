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
| 2 | Trade tier (`idea`) | `api/trade-ideas/**`, `tradeCapture`, `tradeNotify`, `positionManage`, `protectionPlan`, `monitoring/positionMonitor.js`, `entry.monitor.js`, `exit.monitor.js` | ✅ done — 8 commits `e066101`..`e6c42d0` |
| 3 | Mentor / setups + Talos | `api/setups/**`, `setup.schema.js`, `mentor.agent.service`, `talos.*`, `monitoring/evaluators/**`, `parsers/**`, `guardSweep`, `readinessGates` | ✅ done — 6 commits `227d711`..`58e7f3d` |
| 4 | Atlas / portfolio | `api/portfolio/**`, `portfolio.agent.service`, `portfolioState`, `sleeveSource`, `adoptBook` | ✅ done — 10 commits `e3ef6e7`..`bc8bd50`, suite **2886 / 0**; FE follow-ups cleared in `a9532a8` |
| 5 | Agent runtime | `agentIO`, `agentUtils`, `agentTools.registry`, `services/tools/**`, `pendingAction/**`, `entity/**`, `axl.agent.service`, `api/chat/**` | ✅ done — 8 commits `13a323f`..`1b78b99` (+ `7c37bcd`, `7307e76` frontend), suite **2910 / 0** |
| 6 | Argus / Prometheus / Pythia | `api/scanner`, `api/analyst`, `api/strategy`, `scanner.agent.service`, `coverage.service`, `tilt.service`, `researchRun` | ✅ done — 7 commits `2a957e8`..`b3c36b9` (+ `researchQueue.service`, read in scope), suite **2932 / 0**; CR cycle → `98b8994`, **2936 / 0** |
| 7 | Providers + market data | `providers/**`, `price.service`, `market.service`, `news.service` | ✅ done — 8 commits `d8d7fab`..`15b562a` (+ `candleFetch`, `priceFeed`, `http.util`, the two adapters' carried items), suite **2965 / 0 in 63s**; CR cycle → `9798baa`, **2968 / 0** |
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
*Answered in §4:* `ideaService.enrichPositions` — the trade tier, beside the two maps it reads. It is
not the portfolio's; `computePortfolioState` does its own position join and wants neither field.

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

### Frontend follow-ups

- ~~`services/paper/paper.service.remote.js` still defines `updateSettings`, `reset`, `getTrades`,
  `getEquityCurve` — their routes are gone.~~ **Done** (`a9532a8`).
- A 424 from a broker route is a natural hook for a "reconnect cTrader" affordance. **Still open by
  choice** — this is a new affordance to design, not a fix; see the carried-forward table below.

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

---

## §2 Trade tier (`idea`) — done

**Verdict in one line:** the tier is well-guarded (claims, `ownsEntity`, the hours gate, kind-blind
loops), and the problems clustered in one place — the futures/CFD basis existed **twice**, one copy
switched off but wired everywhere, and the gap between them is where two live price bugs lived.

### Bugs

| | Where | What | Sev |
|---|---|---|---|
| 1 | `exitOrders.armExitsInPosition` | Editing a stop/target WHILE IN POSITION built the closing order inline with the **raw** authored level. The placement path shifts by `basisOffset`; this one did not — so on a cTrader index CFD the same stop rested ~227 pts apart depending on *when* it was set. | **high** |
| 2 | `positionManage.executeManage` | Talos's `move_stop` / `let_run` amended at the raw level, same basis, same consequence. | **high** |
| 3 | `protectionPlan._warnUnmonitored` | Logged `ERROR "nothing evaluates the software monitor"` on every placement with a residual tree. True after Minos was deleted, **false since `exit.monitor` landed** — its own header says so, and the guard said "DELETE WHEN THAT LOOP LANDS". Every structured stop raised a false error that would have buried a real one. | medium |
| 4 | `tradeIdeas.updateIdea` | The edit whitelist lived in the **controller**, so it governed the HTTP ticket and not Atlas's `update_item`, which hands an agent-authored patch straight to `updateIdea` — any field, `userId` and `brokerOrders` included. Moved to the service as `EDITABLE_FIELDS` / `pickEditable`. | **high** (security-shaped) |

### The lens

**(a) Architecture** — the neutralised basis mechanism removed end to end: `basisReferenceQuote` (a
documented no-op), the `referenceQuote` plumbing through eight files, a **persisted** `nativeExit`
field, the `BrokerOrder`/`BrokerProtection` typedefs, cTrader's `_priceOffset` / `_positionSymbol` /
`setProtection` branch and the session's spot-snapshot machinery (subscribe 2127 → first tick →
unsubscribe 2129). One mechanism now: the offset is measured once at fork and applied by
`applyOffset` at every price boundary; adapters round, never shift.

**(b) Conventions** — `tradeIdeas.controller`'s eight hand-rolled catches → `makeHandle`; the three
manual-confirm and two manual-portfolio handlers folded into two small factories (they differed only
in which service function they called). Two `tradeCapture` JSDoc blocks were attached to the wrong
functions.

**(c) Duplications** — `pendingOrderFields` (the "entry fired, park the plan" shape, written out at
four sites, each carrying the off-hours rule), `placedStamp` (the post-fill stamp, three writers),
`monitorSchedule.util` (entry/exit monitors each carried the whole cadence: constants, the ISO
next-check stamp with its one-minute floor, the sleep-until-open arithmetic). Last two `×10000`
roundings → `round4`.

**(d) Dead code** — the `db` handle threaded through six reconciler functions *and* out into
`ideaExecution`; `_findActiveByPosition`; `currentReferencePrice`; `routeExits().single` (always
null, no readers); `persistConditionStates`' two vestigial params; `STALE_HOURS`; `hasVwap`; three
aggregate objects; `ideaService.buildIdeaChildren`. The four Kairos card builders + their notify
wrappers moved to `archive/services/kairosNotify.service.js` with their tests — no production caller
since Hermes was archived, and `notificationCard.test`'s `allCards()` now enumerates the **live**
builders, four of which it had never covered.

**(e) MVC** — `positionManage` (a `services/` file) held Mongo `$set`/`arrayFilters`; now routed
through `entityRepo`, which gained `syncExitOrder` beside `markExitOrderFilled`.

**(f) Spaghetti** — `updateIdea` was 185 lines interleaving two jobs: shaping a patch from the body,
and applying transitions that need the stored status. Split into pure `normalizeIdeaPatch` + a
PHASE 2 block. **Deliberately not a `(from,to)` table** — several steps aren't keyed on a status pair
at all, and forcing them into one would invent an abstraction the code does not have.

**(g) Plaster** — bug 3's expired guard; `basisReferenceQuote` "kept as an exported no-op"; the
`brokerSymbol` re-derivation that overwrites the getTicker-resolved name.

---

## §3 Mentor / setups + Talos — done

**Verdict in one line:** the most carefully *reasoned* code in the repo — the guard design, the
scenario-as-rival-premise model, the two-step validity gate (tick filters, close decides) — with two
real holes, both in the **limit-order lifecycle**, and one large duplication block whose stated
expiry condition had passed.

### Bugs

| | Where | What | Sev |
|---|---|---|---|
| 1 | `setups.service.deleteSetup` | A `hit` setup is not delete-locked (only long/short are), and a confirmed limit entry rests at the broker while it waits at `hit`. Deleting the document left the order working with nothing tracking it — it fills later, and the reconciler finds no entity for the fill. The idea path has guarded this since it gained resting entries. | **high** |
| 2 | `talos.monitor` + `setups.routes` | **No user could cancel a resting limit order.** `disarm_requested` was read by the monitor and written by **nothing**; `POST /:id/disarm` has no client; the UI's disarm sends `PATCH {status:'waiting'}`, which dropped the setup to `waiting` and left the order live. Only expiry and a validity breach could actually disarm. | **high** |

### The lens

**(a) Architecture** — the boxed "DELETE WHEN HERMES SLEEPS" note had expired (Hermes archived
2026-08-18, imported by nothing) and was instructing readers to maintain parity with dead code.
`talos.monitor.service.js` at ~1500 lines held four jobs; its ~440 pure lines became
`monitoring/talos.gates.js` — a strict move, the same split this file has taken three times before.

**(b) Conventions** — `setups.controller`'s five hand-rolled catches → `makeHandle`;
`_checkPosition`'s JSDoc had drifted onto `_disarmLimit`.

**(c) Duplications** — the resting-order cancel loop existed in **three** copies (ideas, Talos's
`_disarmLimit`, the handoff's `disarmSetup`) → `services/restingOrders.cancelRestingEntryOrders`
(the pipe; *when* there is an order stays each caller's judgment). The eight-field disarm reset
existed in three copies → `setup.schema.disarmedSetupPatch` — one of them had been silently leaving
`armed_scenario_id` behind since rivals arrived.

**(d) Dead code** — `gradedGap`; `_reschedule`'s ignored third argument at four sites;
`PAST_ENTRY_LEGACY` and the no-op `includeLegacy` parameter it existed to feed;
`_MENTOR_AETHER_HANDLERS` (an empty `{}` spread into the handlers) and the orphaned Aether comment
block above it; `COVERAGE_DIMENSIONS`'s export.

**(e) MVC** — `talos.handoff` reached for `db.collection(ENTITIES)` in five places → `entityRepo`
built over the injected `getDb`, so a desk test's fake db still sees every write.

**(g) Plaster** — the expired Hermes note; the `disarm_requested` flag as a second mechanism for
something the synchronous path already does better.

### Judgment calls made against the plan

- **`hermesModel` / `hermesReasoning` were NOT renamed.** They are a *persisted* user-preference
  field — every user document carries it and the client writes it — so a rename means migrating live
  preferences for a cosmetic gain. That is the trade `setup.schema` refuses over `lower`/`upper`, and
  the category CLAUDE.md protects for the surviving Kairos names. Documented as a deliberate survivor.
- **`disarm_requested` was deleted rather than wired.** Two mechanisms for one user action, differing
  only by a poll's delay.

### CODE_MAP correction

Its Talos entry documented a **MOMENTUM PULSE** — `shouldPulse`, `monitor_state.pulse_anchor_px` /
`last_pulse_at`, `nearestZoneWidth` — that exists nowhere in the tree; guards replaced it. Rewritten
to the cascade that actually runs.

---

## §4 Atlas / portfolio — done

**Verdict in one line:** the review machinery is elaborate and carefully reasoned, and the damage was
done by things too small to notice — one missing projection field switched off the review's
highest-signal trigger, one missing status check let a user's correction vanish, and one duplicated
block described the same book to the model twice with two different names for the same holding.

### Bugs

| | Where | What | Sev |
|---|---|---|---|
| 1 | `portfolioState.STATE_PROJECTION` | Omitted **`conviction_history`**, so `_lastConviction` read `undefined` and **`convictionPrev` was null on every holding of every book**. The `conviction` trigger in `portfolioReview.util` — the one its own comment calls *the highest-signal early warning* — could never fire, and the `(was medium)` trend never rendered. `snapshotConvictions` had been writing the array on every review close the whole time. | **high** |
| 2 | `adoptBook.refreshDraft` | Checked `COMMITTED` but not `COMMITTING`. `patchDraft` only matches an unspent draft, so a refresh landing mid-commit wrote nothing — and returned the merged table anyway. Adopt mode calls it **every turn**, so a user correcting a row while the commit held its 2-minute lease saw the correction folded into the staged book the model reads, and lost it. Now `in_progress` (already a 409 in `_adoptErr`), with the stored draft riding the refusal so the model is not left blind. | medium |
| 3 | `portfolio.agent` — two books in one prompt | `_buildPortfolioContext` rendered the book from `portfolioIdeas`, the list the **client** sent, while `_buildPortfolioStateSection` rendered the same holdings from Mongo. Both shipped together, spelling the holding's id `ideaId: <id>` and `[<id>]` — contradicting the state block's own instruction that the bracketed value is the **only** source of an itemId. That instruction exists because an *empty* client list once let Atlas invent ids and every accepted change came back `not_found`; a second client-supplied copy left that door open. Deleted; what it carried (authored size, condition trees) is projected and rendered from the database. | medium |

### The lens

**(a) Architecture** — `portfolioRebalance` reached for `db.collection(ENTITIES)` at eighteen sites,
the last service in the review path doing its own Mongo. By-id reads/writes now go through
`entityRepo` built over the **injected** db (the queue replays these functions with one); book-scoped
reads go through `listPortfolioItems`, which was already "the one query that reads a book's holdings".
`_addItem`'s sibling read had been a second inline idea of what `{portfolioId, userId}` means — and an
add is exactly where getting that wrong inherits another user's execution binding onto a new holding.
`adoptBook._deleteAdoptedEntity` → `entityRepo.deleteGuarded`, whose guard is required and has no
default. `portfolioMode.util` moved to `services/`: two of its three consumers were already there.

**(b) Conventions** — the cadence default had **three** answers in one file, and two of them were the
display and the clock disagreeing: `getPortfolioLifecycle` fell back to `monthly` while the seed and
every clock said `weekly`, so a book with no stated cadence was *told* monthly and *booked* in a week.
One `DEFAULT_CADENCE` + `cadenceMs()`. Adoption's `monthly` stays as `ADOPTED_CADENCE` — it is
**stated** on the document, and a stated cadence is not a fallback. `const LIVE = new Set(PAST_ENTRY)`
was not live (`PAST_ENTRY` includes `hit`), and the misnomer had a consequence: `remove_item` refused a
`hit` holding with `live_use_exit_item`, and `exit_item` refuses that same holding with `no_position` —
a verb that also refuses. Seven adoption handlers → `makeAdoptHandler`.

**(c) Duplications** — the two due-book readers shared ~45 lines (`_metaStage` / `_bookMeta` /
`_bookRow`); the three position-moving verbs shared a five-line guard preamble (`_positionedItem`); the
leg-quantity `arrayFilters` write existed beside `entityRepo.setLegQuantity`, which was written for it.
That last one is the CLAUDE.md nuance exactly — **share the pipe, not the judgment**: the reconciler
writes the broker's own volume and overwrites, a review's trim writes arithmetic and must lose to
whoever wrote in between, so the guard became an optional `ifQuantity` and the yielding stayed each
caller's. `_portfolioName` read twice per request.

**(d) Dead code** — `addReviewHistoryEntry` (no caller; the per-book narrative was superseded by the
fingerprint, so the FIELD stays for books that already carry entries); adoption's `benchmark` (a second
copy of the mandate's) and `spine_state` (whose comment promised a nag and a Themis behaviour that were
never built — a field described only by behaviour that does not exist reads as a mechanism nobody may
break); `AETHER_TOOL_HANDLERS = {}` with its orphaned comment block, two of whose lines begin
mid-sentence — **the identical §3 finding, in a second agent**; `_parseScreenRequest` (singular);
`portfolioChat`'s re-export shim, whose only importer was a test.

### The Aether block was in four desks, not two (`bc8bd50`)

Finding it twice was worth a sweep of the other five agents, and it turned up twice more: **analyst**
carried five lines describing three Aether tools, **scanner** two describing a shock feed. None of the
four tools exists — checked against each desk's declared `TOOLS`, not by reading.

What makes it worth more than four deletions is where the prose ENDS UP. A comment block sits above
the entry it describes, so removing the entry and keeping the block attaches it to whatever comes
next — and in analyst and portfolio the survivor was `consult`, the one tool whose description is a
per-desk judgment about when to spend a stronger model. Four stray Aether sentences read as part of
that judgment.

`tests/unit/agentToolComments.test.js` now covers the two MECHANICAL halves: a comment naming a tool
the desk does not declare, and an empty handler map still spread into the live handlers. It does
**not** catch the Aether comments themselves — they named no tool, they described one in prose, and no
pattern separates that from any other paragraph. The test says so at length rather than implying
coverage it does not have. Those four were found by reading, which remains the only way to find the
next one.

Writing the check surfaced a distinction worth keeping: `screen_request` is an **emit tag** (the model
writes `<screen_request>` into its answer) and `screen_candidates` is a **tool**. They look alike and
are not alike, so the check tells them apart by what actually differs — an emit tag appears in angle
brackets — rather than by a list of names someone must remember to update.

**(e) MVC** — see (a). `_specAsset`, `_deferred` and the refusal vocabulary were already right.

**(f) Spaghetti** — none. `applyRebalance` is long but linear, and its three-outcome bucketing
(applied / deferred / failed, with a lost queue write counted as failed) is the invariant.
**`sleeveSource.service.js` produced no findings at all** — the cleanest file in the section.

**(g) Plaster** — `spine_state`'s comment; the `?? 'monthly'` that contradicted the clock; the
`refreshDraft` success answer over a write that did not happen.

**(h) Shared helpers** — added `earningsWindow.util`, `entityRepo.listByIds` / `deleteGuarded`,
`setLegQuantity`'s `ifQuantity`, `makeAdoptHandler`, `_bookRow`, `_positionedItem`.

### §1's open question, answered

`broker.controller.getPositions` joined `getAssetClassMap` + `getCallPositionMap` inside a controller.
**It is not the portfolio's** — `computePortfolioState` does its own position→holding join off
`brokerOrders` and wants neither field. It is the **trade tier's**, because both maps are reads of that
tier's own documents, so the join belongs beside them: `ideaService.enrichPositions`. The two map
getters come off the service object (they were public only to be joined by that controller), and the
join is testable without a controller for the first time — seven cases, including the three easy ones
to get wrong: a null class is the client's fallback signal and must not be invented, a class the
*broker* stated is not overwritten, and the call key includes the broker.

### Behaviour changes a reader should know

- A book with no stated `reviewCadence` now *reads* as weekly everywhere, matching the clock that was
  already scheduling it.
- `remove_item` on a `hit` holding answers `order_pending_cancel_first` instead of pointing at a verb
  that also refuses.
- `PATCH /api/portfolio/adopt/draft/:id` can answer **409** while a commit is in flight.
- Atlas sees the book once, from the database, with its ids in **every** mode rather than review only.

### Frontend follow-ups — all closed in `a9532a8` (botmarket-frontend)

| From | What | Outcome |
|---|---|---|
| §4 | The client SENT `portfolioIdeas` on every portfolio stream — dead payload carrying a whole book | Not sent |
| §4 | `adopt.service.remote.refresh` will now reject on a 409; the grid should name it | **No change needed** — `sendReason`'s body is `{ error, reason }` and the grid's `_message` reads `.error`, so it already says "This book is already being adopted". Checked rather than assumed |
| §4 | `reviewApply.REASON_COPY` had no entry for `live_use_exit_item` or `order_pending_cancel_first` | Both worded, and deliberately differently: "still held — exit it instead" vs "an order is still working — cancel it first". Saying *still held* for both would send the user to Exit, which refuses a `hit` holding in its turn |

### Tests added

`portfolioStateProjection` (the projection must cover every field the mapper reads — the check that
would also have caught `research_basis`), `portfolioAuthoredLine`, `enrichPositions`, plus cases on
the adopt commit-lease, the compare-and-set's losing half, and `_addItem`'s ownership scoping. Suite
2864 → **2884**. Three fake dbs were brought up to the driver's shape (`find().project().toArray()`,
`updateOne` returning a result) — which is what they should have been.

---

## §5 Agent runtime — done

**Verdict in one line:** the runtime is well-argued at its core — the pending-action state machine and
the tool registry produced no findings — and the damage was again in things built and never wired: a
history written for a review that could not see it, a spend accumulator that inverted the rule its own
comment states, and a helper written to stop a drift that had zero callers while five sites still read
the literal.

*Scope note:* `services/tools/**` (14 files), `toEnvelope`, `toWatchRow`, `vocabulary`, `chatWs` and
`chat.controller` were read in full in a second pass after the core; the first report went out before
they were finished and said so. Two of the frontend's files were read as callers (`agentMeta.jsx`,
`chat.service.remote.js`), and the two changes they needed landed there (`7c37bcd`, `7307e76`).

### Bugs

| | Where | What | Sev |
|---|---|---|---|
| 1 | `originRegistry._cancelPortfolioItem` | Appended to **`rebalance_history`** on every cancelled queue item, and its comment said why: *"a cancelled trim is invisible to it and comes back next week identically — the user says no, and the desk asks again, which reads as not listening."* **Nothing read it** — not `STATE_PROJECTION`, not the prompt, not the triggers — while `APP_SPEC.md` and `docs/architecture/off-hours-queue.md` both described the mechanism as working. The identical shape to §4's `conviction_history`: a history written on a user action, for a review that cannot see it. Now projected, mapped (`_declinedChanges`) and rendered as a DECLINED line beside the holding in review AND edit context. Filtered to `cancelled` — `queued` ("the market never opened in time") is not a refusal, and reading it as one would state an opinion the user never held. Deliberately **not** a prohibition: a desk forbidden from ever re-raising a trim would be worse than one that repeats itself. | **high** |
| 2 | `agentUtils.resolveAgentStream` vs `tokenUsage.recordUsage` | The comment states the rule — *"a cost control must never turn into an unmanaged position"* — and that the ceiling counts CHAT only, which held because *"monitor spend is not recorded at all today"*. It is recorded: `talos.assess` → `bookAssessUsage` → `recordUsage`, into the one `totalCost` the ceiling reads. So a trader with several armed setups reached the cheap chat model faster than one with none, for spending nothing extra on chat. Monitors were never *blocked* (they bypass this seam) — the other half broke. `recordUsage` takes `{ monitor: true }` and accumulates `monitorCost`; `chatSpend` subtracts it, floored at zero; the ceiling compares that. Monitor spend stays in `totalCost` and its own `byAgent` row — it IS the user's money. **No migration, by design**: a separate `chatCost` would read 0 on every existing document and un-degrade every user for the rest of the month; subtracting an ABSENT `monitorCost` reads as 0 and historical months compare exactly as before. | medium |
| 3 | `chat.service.BOT_IDS` vs frontend `agentMeta.jsx` | The client carried `aether`; the server did not, and both files say they must stay in step. Latent (nothing posts under it) but the backend comment names the exact failure — *"a missing entry doesn't error, it misattributes"* — and `aether` was in neither `ADMIN_BOT_IDS` while being admin-only everywhere else (`requireAdmin` routes, Axl's `ADMIN_DESKS`, the trader prompt's "does not exist"). The first Aether card would have put an admin desk's feed in a trader's sidebar, branded as Axl. **Removed from the client rather than added to the server** — building the server half for a feed with no producer is the shape this review keeps deleting. The comment now says what a real Aether notifier would need: four entries, not one. | medium |

On 3 — checked whether `ADMIN_DESKS` and `ADMIN_BOT_IDS` disagreeing is itself a bug. It is not:
`analyst` is legitimately an admin *feed* (its cards ask for revisions only admins can make) and a
trader-routable *desk* (coverage is readable). Two lists, two questions; `aether` was the only drift.

### The lens

**(a) Architecture** — `chat.controller` was the last controller here writing `try { … } catch (err)
{ next(err) }` by hand after §1–§4 moved five onto `makeHandle`. Unlike those it was NOT losing
information to the global handler — it already forwarded — so the error shape is unchanged and this
**stays clear of the open §9 decision**; what it gained is the LOG line a failed chat read never left.
`toEnvelope` re-derived `kindForDoc`'s rule (`portfolioId != null ? PORTFOLIO_ITEM : IDEA`) while that
helper's own doc names "the toEnvelope adapter" as one of the three places that must agree — the one
of the three keeping a private copy, which is how a list of places to keep in sync becomes a list of
places to fix.

**(b) Conventions** — `isArmed` had **zero callers**. Its doc: *"shared code must still ask THIS rather
than the literal… what stopped `setups.filter(s => s.status === 'looking')` from silently counting
zero."* Five live sites read the literal; the four READS now ask the helper (`setups.service`,
`ideaExecution`, `tradeIdeas` ×2) and the fifth is a WRITE (`{ status: 'looking' }`), correctly a
literal — you set a status, you do not ask it. Not cosmetic: three of the four test an incoming PATCH's
status word, so if ARMED ever gains a second spelling a literal comparison skips the readiness gate for
it. `sectorProxy` the same at the two sites indexing `SECTOR_ETF` directly — neither a bug (tilt
normalises on the way in) but the lookup should not depend on every caller having done that first.
`trading.tools.js` still logged as `[kairosTools]` from before its rename; safe to change because
spend attribution reads the agent's tag, never a tool module's.

**(c) Duplications** — `tradingContext._availabilityCache` was a hand-rolled Map with its own TTL
arithmetic and **no eviction**, on the `get_quote` path every desk hits constantly: one entry per user ×
ticker for the life of the process. Now `createTtlCache({ ttlMs, max })`, the util ~35 other caches
use (`price.service` documents a deliberate non-use of it, which is what a justified exception looks
like; this had no such note). Two behaviours pinned while it changed: the bound evicts, and an **empty
venue list is cached as the real answer it is** — a miss detected by falsiness (`?? null`) would have
re-asked the broker on every quote for precisely the users with no live venue to check.

**(d) Dead code** — the `/dismiss` chain was dead **end to end across two repos**: route → controller
handler → service alias on the backend, and the client's own `dismissMessage` was an unused alias that
posted to `/resolve`. Four layers, no caller at either end; each looked reasonable next to the one
below it and the emptiness was only visible whole. `pendingActionRepo` and `pendingWorkService` were
service-object aggregates referenced nowhere outside their own files (§1 deleted two for the same
reason). Of eight "unreferenced" exports the scan proposed, **two are imported by the archive** —
`STRUCTURE_VISIONS` and `TRADING_TOOLS_FOR_MODE` — which the scan skips; deleting them is precisely
the failure that bit §2 and §3 three times. Both now carry the note. `INVALIDATION_EDGES` stays: nothing
validates against it, but it documents a persisted field's allowed values beside the enum it belongs
to. Four internal-only exports (`formatEventCandidates`, `readStructure`, `SMC_TOOL_NAMES`, `smcBars`)
left as they are — dropping a keyword is churn on working code.

**(e) MVC** — see (a). `pendingAction.repo` + `executionGate` are the best-argued pair in the section:
`transitionFilter` is pure, and the `from` parameter's refusal to default to "any open state" is right.

**(f) Spaghetti** — none. `agentTools.registry` has **no dead schemas** — all 42 checked against every
desk's declared `TOOLS`.

**(g) Plaster** — five headers described archived desks as live collaborators, and none is a
CLAUDE.md-protected name (not branding, not `kairos_pick`, not `KINDS.CALL`): `smc.tools` "shared by
the Kairos build handlers AND Hermes's assessor" (live consumers: Talos, Mentor, Argus);
`marketData.tools` ×2 "Shared by Idea and Kairos" (both archived); `tradingContext.tools` "the same
shape kairos/idea already use"; `agentUtils` listing **Hermes** among the monitors that bypass the
ceiling. The same class as §3's expired "DELETE WHEN HERMES SLEEPS": a reader sent to dead code for the
reason live code is shaped this way. The "Kairos calls" *data* references in `userData.tools` stayed —
a `call` document still exists in Mongo. Also `CLAUDE.md`'s shared-mechanism example named
`sendBotMessage` as the one transport; the real one is `postCard` (29 sites) → `postBotCard` (14), and
`sendBotMessage` is a back-compat alias with no caller outside `chat.service`. The principle was sound;
the example was stale. Corrected in the file.

**(h) Shared helpers** — `isArmed` and `sectorProxy` adopted; `createTtlCache` adopted; `kindForDoc`
adopted in `toEnvelope`; `chatSpend` added beside `overCeiling`.

### The stranded-JSDoc sweep was a memory, not a check (`6f35c99`)

The §2–§3 QA cycle scanned the repo for a JSDoc block sitting above the wrong function, moved five,
and reported it *"clean repo-wide"*. Three survived: `runAgentStream`'s block above `agentKeyFromLog`,
**two** stacked above `lensLine` in `assess.shared` (`assessRouting`'s and `bookAssessUsage`'s, in
inverted order), `computeRR`'s above `_edge`. The sweep commit landed AFTER the commits that created
two of them — it ran and missed them. A one-off grep is correct on the day it runs and silent the day
after: the same lesson as the archive loader and `STATE_PROJECTION`'s coverage test, learned a third
time.

So it is `tests/unit/jsdocAttachment.test.js` now, and writing it turned up three shapes that are NOT
findings, each understood rather than excluded by name: the **module header** (a file-describing block
with the first declaration's own block directly beneath — five files open this way, discriminated by
"has any code appeared above it", not "is it line 1", so a header under an eslint pragma still
reads as one); **stacked `@typedef`s** (`price.service`'s four document TYPES, not the code beneath);
and `/* c8 ignore */` pragmas. Two of the detector's own first fixtures were wrong in a way that proves
the point — they put the stranded block at the top of the file, the one position where it is a module
header and correct.

### Judgment calls made against the plan

- **§1's carried "three spellings of one guarded update" are five** — `claimOrder`, `claimIf`,
  `dueLoop._claim`, `pendingAction.transition`, `adoptDraftStore.claimDraft`. **Verdict: do not
  collapse them.** The idiom is three lines, each targets a different collection with a different
  natural key, and the guard IS the load-bearing part — a shared wrapper would hide it. The narrower
  defect: `entityRepo.claimIf` is the only one returning a **document** (the pre-image) where the
  other four return a boolean, and its name reads like a boolean. No caller is wrong today (all three
  use it as a truthiness test). Left; noted here so the next reader does not "fix" the five into one.
- `entityCrud.patchOwned` / `remove` read-then-write with the owner absent from the write filter,
  while §4's `deleteGuarded` puts the guard IN the query. Documented as deliberate ("every caller is a
  user-initiated edit, not a monitor race") and practically safe; the two postures differ and that is
  recorded, not changed.
- `resolveMessage`'s terminal branch writes with no status guard, while the `pending` branch guards
  `status: 'pending'` ("never re-open a settled card"). A stale client can flip a `done` card to
  `dismissed`. **Low, left** — both are settled states and the card is closed either way; worth a
  guard if the two ever diverge in what they show.
- `toEnvelope` / `callToEnvelope` have **no production caller** — only `ideaToEnvelope` is used
  (`orderPlan.service`). Expected with Kairos archived; the envelope model is documented architecture
  with a stated P4 plan. Flagged, not deleted.
- `chat.service` exports 19 symbols, 4 used only inside the file (`sendBotMessage`, `triggerAxlReply`,
  `isAdminBot`, `RESOLVES_ON`). Internal helpers with a public keyword; left.

### Behaviour changes a reader should know

- Atlas now sees, beside each holding, the changes the user declined in earlier reviews — and is told
  not to re-propose them as though new.
- A user's chat model is degraded by their **chat** spend only. Monitor spend still shows in every
  usage report and in `totalCost`.
- `POST /api/chat/.../dismiss` is gone; `/resolve` with `status: 'dismissed'` was always the call.
- Failed chat reads now leave a log line naming the route.

### Frontend follow-ups — closed in botmarket-frontend

| From | What | Outcome |
|---|---|---|
| §5 | `BOT_IDS` carried `aether`, which the server never posts and does not admin-gate | Removed (`7c37bcd`); the client pins its list by value against the server file — a PIN, not a live cross-check, and the test says so |
| §5 | `chatService.dismissMessage` — unused alias for a route the backend deleted | Removed (`7307e76`) |

### Tests added

`jsdocAttachment` (the sweep as a check, with the three non-finding shapes as fixtures),
`portfolioStateProjection` extended to `rebalance_history` + the `cancelled`-only filter,
`tokenUsageByAgent` on `{ monitor: true }` / `chatSpend` (including the absent-field and floor cases),
`tradingContextSymbol` on the cache bound evicting and the empty-venue answer being cached, the
`BOT_IDS` ↔ `ADMIN_BOT_IDS` pin. Suite 2886 → **2910**, eslint clean, 16/16 archived modules load.

---

## §6 Argus / Prometheus / Pythia — done

**Verdict in one line:** the pure tiers — the grounding ledger, the gap classifier, the forecast
clock, the tilt arithmetic — are the best-written code in the repo so far, and two whole mechanisms
around them had been dead since the coverage pivot (`5c12b8c`, 2026-08-26): the scheduled re-model
never ran, and the tilt-change card reached nobody. Both were left running against a `userId` the
data no longer has, and both were masked by fixtures shaped like the data used to be.

*Scope note:* the section table's file list omitted `services/researchQueue.service.js`, which both
desks depend on; it was read in full and is in scope. `services/aetherQuickRead.service.js` was read
as the one caller of Prometheus's quick-read mode and left to §8.

### Bugs

| | Where | What | Sev |
|---|---|---|---|
| 1 | `coverage.monitor._deps.remodel` → `coverageRefresh.refreshCoverage` | **Every scheduled re-model was a no-op.** The monitor passed `userId: null` (coverage is house-owned) and the hop's first line was `if (!userId \|\| !sym) return { ok: false, reason: 'bad_args' }`. `_runRemodels` did not read the answer. Worse, `claimRemodel` had already stamped `last_remodel_at` and started the 14-day cooldown, so the name was not retried either — and the Aether trigger cleared its `pending_aether_remodel` on the same tick. The whole expensive tier: catalyst, edge change, quarterly floor, early hit, Aether. The comment beside it said *"Admin notifications for re-model events are wired in Step 2"*; Step 2 never came. Now a null user IS the house run — no venue, no audience level — and the "refreshed" card fans out to every admin (`notifyCoverageRefreshed` reads the roster when there is no user, the same fan-out its verdict card uses). `_runRemodels` logs a `{ ok: false }`, because the claim above it means there is no retry coming and that line is the only place the failure can be seen. | **high** |
| 2 | `tiltNotify.audienceBySector` vs `coverage.listActiveBySector` | **The tilt-change card was posted to nobody for three weeks.** The audience was "whoever RESEARCHES the moved sector", a join on coverage's `userId`; the pivot changed the sweep's projection to `{ symbol, sector }` and the join matched nobody. **Confirmed in `logs/backend.log`** (12.9, a publish that moved two sectors: `{"sectors":2,"users":0,"posted":0}`). The 60-line header defending the join described a world that no longer existed, and `tiltNotify.test.js` still gave its coverage rows a `userId`. There is no per-user sector audience left in the data; the card goes to the admin roster, the same fan-out the review offer two functions below already used, and `audienceBySector` is gone. | **high** |
| 3 | `researchRun._loop` / `startRun` | `await deps.startResearch(item.id)` — a guarded claim (queued → in_research) whose result was discarded, so a row someone else had already claimed was researched anyway: a four-minute turn whose save could only answer `already_covered`. And the "one run at a time" check ran before two awaits, so two Starts pressed together both became `state.run` and both loops walked the same queue. The claim is read (a refusal is a `skipped / not_queued`, the row untouched) and a `starting` flag set synchronously closes the race, cleared on every way out. | medium |
| 4 | `coverage.updateCoverage` / `tilt.updateTilt` | Read-merge-write with a full-document `$set` built from the stale read: `revisions` rewritten as a whole array, and every plan field written back from `cur`. Two writers in one window — the monitor's verdict against an admin's edit, a refresh against either — and the second landed a stale copy: a revision lost, or a price target the other had just moved written back. Now `houseArtifact.repo.revise`: `$push` at position 0 for the trail and `$set` of ONLY the patched keys (`_updateSet`, pure, in each service), in one update. | medium-low |

### The lens

**(a) Architecture** — `analyst.controller` answered errors three ways in one file: the coverage
handlers hand-roll `try/catch` with fixed slugs (kept — that is the §9 question); the research-queue
and run handlers, and every handler in `strategy.controller`, had **no `try/catch` at all** and leaned
on every service catching — true today, one thrown read from a hung request (Express 4 does not see an
async rejection). Those ride `makeHandle` now: like §5's `chat.controller` they never caught, so
nothing the client sees changes, and it stays clear of §9. The three queue transitions were one
handler written three times. **Left:** `coverage.service` and `tilt.service` both dynamic-import
`monitoring/monitorUtils.fetchLastPrice` — a service reaching into the monitor tier, hidden by the
import being lazy. For §7/§8, where the price read's home is decided.

**(b) Conventions** — `SCANNER_TOOLS_FOR_PROFILE` was a function in SCREAMING_CASE →
`scannerToolsForProfile`. `_sanitizeAnalystSeed = sanitizeScanSeed` was an alias export for one test.
`res.send` vs `res.json` in `analyst.controller` is split along the same line as the error postures
and goes with §9.

**(c) Duplications** — `coverage.service` and `tilt.service` are the two publication logs of house
artifacts and had written the same mechanics twice: `recordMonitorState` byte-for-byte, a private
`_strip` beside `mongodb.provider.stripId` (a third in `researchQueue`; the tilt spelled it
`delete doc._id` inline three times), and the revise-write above. `houseArtifact.repo` is the pipe —
`revise` and `recordMonitorState`, over an injectable `getDb` so the update's shape is testable — and
each service keeps its schema, its gates and what counts as a revision. Share the pipe, not the
judgment: `remodelDecision` and `reviewDecision` have the same cooldown → triggers → floor shape with
different constants, and are deliberately NOT collapsed; the constants are the judgment.
`houseScan._io.screenSector` caught what its caller already catches, making the loop's "skip this
sector, scan continues" branch unreachable for the real IO.

**(d) Dead code** — `POST /coverage/deduplicate` + `deduplicateCoverage` + a test that checked it
returned an object: the one-off cleanup for the day the unique symbol index went in. No client calls
it, the index exists, and `_ensureIndexes`'s comment sent a reader to it. **Noted, not proposed:**
`HANDOFF_DESKS.kairos`, the controller's `'kairos'` whitelist and `_normalizeKairosPick` are reachable
only if the client sends `handoffTo: 'kairos'`, which `findReceiver` cannot produce with the desk
archived — but they are tested, cheap, and are the hand-off a premium build mode needs. The
`destination: 'kairos'` wire value stays too, now with a note: the client reads only `=== 'analyst'`
and the pipeline picks the receiver itself, so it names the tier, not the desk.

**(e) MVC** — see (a). `researchQueue.service` is the cleanest write layer in the section: every
transition guarded, every reason on the row.

**(f) Spaghetti** — none. `tilt.monitor._checkTilt`'s `if (matured) … else … ; if (matured) …` is two
branches written as three and was left: it reads, and the tests pin it.

**(g) Plaster** — three more orphaned Aether comments that `bc8bd50`'s sweep missed, in TOOL_HANDLERS
rather than TOOLS: `// Unbound — X is a house-layer broadcast, no userId.` under `makeMarketHoursHandlers`
in analyst (×2) and scanner (×1), each describing a spread that no longer exists — the class the §4
write-up said the test cannot catch. **Two files described coverage as owner-scoped** in the reasoning a
reader uses: `tilt.service`'s header (*"one doc per (user, symbol) — bottom-up, owner-scoped"*) and
`strategy.controller`'s (*"NOT owner-scoped the way coverage's are … `requireAuth` still gates them"*;
the router is `requireAdmin`). `coverageRefresh` said the language rule rode the existing thesis, two
paragraphs after the comment explaining why it was removed. Archived desks as live templates (§5's
class): `analyst.agent`'s header ("Mirrors the Kairos agent shape"), "the Hermes/Themis pattern", "the
same one Hermes … gate[s] on" in both monitors, and Argus's hand-off comments naming Kairos as the
RECEIVER of the pick ("recommends back to Kairos", "seeds Kairos's Phase 2") — the receiver is Mentor.
A `no-unused-vars` pragma on a function that is used.

**(h) Efficiency** — `_resolveCoverageContext` loaded every coverage document — thesis, evidence, the
whole revision trail — on every Prometheus turn to read `symbol`; the research run and the sleeve
orchestrator did the same for their skip lists. `coverageService.listSymbols` projects the one field
and the three use it. `existing_coverage` and `current_tilt` were JSON-dumped whole into the prompt,
`monitor.*` included — bookkeeping on every turn for a reader with no use for it; both strip it now.

### Judgment calls made against the plan

- **A house run books no token spend.** `resolveAgentStream` records usage per user only, so the
  scheduled re-model — real money — lands on nobody's row. Stated in the commit as a known gap rather
  than hidden; it wants a house row, which does not exist. Not invented here.
- **One word changed and put back.** The (g) sweep touched `get_chart`'s tool DESCRIPTION ("the Kairos
  single-pick"). That is prompt content the model reads, and `agentToolsRegistry` pins every description
  verbatim so a refactor never rewrites judgment. The snapshot said no; reverted; left for the prompt
  review, where a change to what the model is told belongs.
- **The revision trail still rides every prompt turn, uncapped.** `revisions[]` grows forever and is
  shown whole in update mode. Whether to cap it is a prompt-content question (the prompt says
  "reference what's changed since the prior view", and the trail's `changed` diffs are exactly that).
  Left for the prompt review.
- The `parseChatMessages` gate: five controllers validate and TRIM the messages, then pass the RAW body
  array to the agent. Repo-wide, not this section's — `_shared` is §9's — and possibly deliberate
  (extra fields the agent's own normaliser reads). Carried.

### Behaviour changes a reader should know

- The coverage monitor's re-models RUN. Catalyst, edge-change, floor, early-hit and Aether-triggered
  re-models rewrite the thesis and post a `coverage_refreshed` card to every admin (copy: "Scheduled
  re-model of X is in — …"). Expect Prometheus spend from the monitor tier for the first time since
  2026-08-26; `MAX_REMODELS_PER_TICK = 3` bounds it.
- Publishing a tilt that moved a sector posts a `tilt_event` card to every admin, with the whole change.
- The research run reports a new outcome: `skipped / not_queued`. A second Start during the first's
  reads answers `already_running`.
- `POST /api/analyst/coverage/deduplicate` is gone.
- A coverage or tilt revision is appended in the database; concurrent writers can no longer lose one.

### Frontend follow-ups (botmarket-frontend)

None required. The client renders `coverage_refreshed` through the same bubble (the added
`payload.house` flag is ignored); it never called `/coverage/deduplicate`; it does not map run-result
reasons to copy, so `not_queued` renders as the others do.

### Tests added

`houseArtifactRepo` (the update's shape against a fake collection; each service's `_updateSet` on the
patches that actually happen — a rating change does not write the target, the monitor's verdict writes
gap and status and nothing else, a re-model draft writes every plan field), `deskControllersHandle` (a
throw reaches `next`, induced with a malformed request rather than a stub), the house-run contract in
the monitor's exact shape (`coverageRefresh`), the refresh card's two audiences (`coverageNotify`), the
tilt fan-out rebuilt over the seams that exist (`tiltNotify` — 4 dead-join tests out, 6 in), the
read claim and the single-flight Start (`researchRun`), the bookkeeping-free prompt dumps
(`coverageObjections`, `strategyAgent`). Suite 2910 → **2932**.

---

## §7 Providers + market data — done

**Verdict in one line:** the price stack is the most carefully argued code in the repo — `fmp.price`,
`candles.provider`, `candleFetch`, `priceFeed`, `http.util` each state a hard-won rule and hold to it —
and the shared pipes they built were bypassed by half the other providers: eleven HTTP calls went
around the metered, timed-out `getJson` (five with no timeout at all), the news cache lived on the
disk tier the candle cache had been moved off for being unsafe, and the Yahoo provider carried 450
lines of analytics that were never Yahoo's, with a third private copy of the FMP-first router. The
biggest find was incidental: four providers' stray `dotenv.config()` calls had been loading the real
API keys into the test runner, and the "unit" suite had been making live LLM calls for months.

*Scope note:* `candleFetch`, `priceFeed`, `util.service`, `http.util` and `candleInterval.util` are
the pipes the stack runs through and were read in full; the two adapters' carried items
(`ctrader.adapter`, `ibkr.adapter`) were read for those items. `usaspending.provider` (274 lines,
18 tests, no production importer — scaffolding for `docs/design/opportunist-money-flow.md`) is
**kept, by decision**.

### Bugs

| | Where | What | Sev |
|---|---|---|---|
| 1 | `ibkr.adapter._normaliseAccount` | Folded EVERY account's summary rows into one object — `account` overwritten per row, the tags merged — so a login with two accounts answered `getAccount` with B's id and a mix of A's and B's balances, while `getTradingAccounts` two functions up grouped the same rows correctly. The two also disagreed on what `balance` was (cash vs net liquidation). `accountsFromSummary` parses once, per account, in the cTrader shape; `getAccount` answers the first and logs the rest. | medium |
| 2 | `fmp.provider._macroParts` | Every leg swallows its failure into `[]`, and the all-empty result was cached for an hour — one 429 and `get_macro_snapshot`, `get_sector_snapshot` and Pythia's macro read answered "unavailable" for sixty minutes. §5's "cache the miss as the answer" in the other direction; a result with nothing in it is served once and asked again. | medium-low |
| 3 | `anthropic.provider.streamAnthropicWithTools` | `stop_reason` `max_tokens` and `refusal` returned through the same line as `end_turn`, and the provider had **no logger** — a truncated or refused desk reply left no trace anywhere. `_noteStop` logs the model, the stop, the `stop_details` category and how much text reached the user. Checked against the API reference: the thinking config (`adaptive` + `output_config.effort`) and the `THINKS_BY_DEFAULT` set are right. | medium-low |
| 4 | `price.service.syncCandles` / `getCandles` | A failed fetch left `lastFetchedAt` untouched, so every subsequent read re-asked a provider answering 429 for as long as it was down — the self-inflicted quota burn `fmp.price`'s own comments describe. And a `candles.length === 0` clause re-fetched an empty series on every read regardless of TTL, so a symbol the provider does not carry was asked forever. The attempt is stamped, the bars held are served, freshness alone decides. | low-medium |

### The suite was never offline (`c1227c4`)

`config.js`'s header says it OWNS dotenv, and it deliberately refuses to load `.env` under the test
runner — the safety gate that keeps the unit suite off the production cluster and the shared FMP
quota. `finnhub`, `fred`, `gnews` and `massive` each called `dotenv.config()` themselves, in every
test process that imported them. So the tests around the condition parser were reaching the **real
Anthropic API with the real key on every run**: the flake §1 carried to §10, and the reason
`npm test` took ten minutes. Removing the four calls made eleven tests in `ticketOrderPath` fail
honestly for the first time.

The fix was not a stub. Those tests parse `price touches 21500` — a sentence
`protectionPlan.touchLeaf` wrote one line earlier — and `routeExits` sent it to a model to get the
number back out: in the **order path**, and in the monitor on every tick until its cache warmed. A
parse the app can do by reading its own sentence must not cost an LLM call, a network round-trip or
an API key; with the key absent it "failed", the leaf read as `unknown`, and a stop that should have
rested at the broker fell to the monitor. `condition.parser.parseTouchLiteral` reads the one shape
the app authors deterministically; a user-worded condition still goes to the model. Two outage tests
that had used that exact sentence now use a user-worded one, plus a contrast case: same blank key,
the self-authored leaf routes.

**`npm test`: 10 minutes → 63 seconds**, 2965 tests, every one of them offline.

### The lens

**(a) Architecture** — `yahoofinance.provider` was 794 lines, ~450 of them analytics
(`getRiskMetrics`, `getPriceAction`, correlations, `getCycleAnalysis`) — arithmetic over candles from
ANY source, living in a provider by history. They fetched through a private `_candles` (FMP → Yahoo),
the **third copy of the source decision** `candleFetch`'s header says is made once in
`candles.provider`: it skipped Massive and ignored `USE_FMP_CANDLES`, and it could not be fixed in
place because a provider cannot import the router without a cycle (`candles → massive → yahoo`) —
which is the tell that the analytics were in the wrong tier. `services/priceAnalytics.service.js` is
that tier; the functions moved as they were, `_candles` is the router through a `_deps` seam, six
importers rewired (one in the archive — its import line changed so the archive keeps loading), and
the analytics are unit-tested offline for the first time. The provider keeps what is Yahoo's: the
quote fallback, the chart feed, short interest, options context (257 lines).

**(c) Duplications** —
- **The HTTP pipe.** `getJson` is the one metered, timed-out, retry-with-jitter pipe and its header
  says requests are "counted where they all pass through". Eleven did not: `finnhub` (5× bare
  `axios.get`, **no timeout**), `fred` (2×, no timeout), `usaspending` (POST + GET), `gnews` (bare
  `fetch` with its own one-retry-after-1.4s), `ctrader.provider` (two ~30-line hand-rolled
  `https.request` promises). All ride `getJson`, which learned a JSON body with its method and the
  provider's error body (`err.body` — cTrader's `description`, GNews's `errors`). `axios` is gone
  from `package.json`. `chartImg` (a POST for a PNG) is the one exception.
- **The two-layer Mongo-backed cache** — `fmp._readCache/_writeCache` and
  `finnhub._readProfileCache/_writeProfileCache`, identical but for names → `mongoCache.util`, with
  `getDb` injectable so both layers are asserted against a fake collection; the document shape
  spreads the value so the existing collections keep reading.
- `fmp.price.aggregateOhlc` was "a mirror of marketData.tools.aggregateCandles (inlined … cycle-proof)"
  and had already drifted on `groupSize 1` and empty input → `candleInterval.util.aggregateCandles`.
  Two FMP files carried `BASE`/`API_KEY`/the key check → `fmp.price.fmpGet`. `_etOffsetMs` and
  `market.service._tzOffsetMs` → one. `DEFAULT_MODEL` in the provider AND `llmModels` → the
  provider refuses a missing model rather than quietly picking one.
- **cTrader (carried from §1):** `/tradingaccounts` at four sites and a ProtoOA socket round-trip in
  `_session` before EVERY operation → a per-user 60s cache and a 10-minute ctid cache, both dropped on
  a reconnect (the one moment they are known wrong).

**(d) Dead code** — Yahoo: `getCompanyName`, `getNumericQuoteFast` (the paper loops moved to FMP;
its comment described callers that no longer existed) with its config knob, `getAnnualizedVolRaw`,
`getCorrelationsRaw`, and Yahoo's `getEarnings` (FMP's superseded it; the same surprise-% block
twice). `anthropic.provider.callAnthropic` + `callAnthropicWithTools` — no callers, the second
self-declared so and "kept in step" by hand, a promise that decays. `util.service`: five of eight
exports dead; then the file, once the news shelf stopped reading its store.

**(h) Efficiency / (e)** — the news cache was on disk (`data/news/*.json`) — exactly the tier
`price.service`'s header argued out of: no lock on read-modify-write, no temp-and-rename, machine-local
and ephemeral on Render, and the tests wrote real files into the repo. A bounded in-process map now,
the same shape as the candle envelopes, with three test seams instead of `fs`.

**(g) Plaster / (b)** — four providers' `dotenv.config()` (above); `massive`'s 2-space `try` block,
untagged `logger.error` and "the Hermes monitor's candle read"; `finnhub`/`fred`/`util.service`
logging without a `LOG` tag; `getQuote`'s doc block stranded above `getCompanyName`; the streaming
loop's header describing itself as "like callAnthropicWithTools".

### Judgment calls made against the plan

- **`getJson` gained `method`/`body` and `err.body`** rather than a second `postJson`: one pipe with
  two more options is one place to keep the meter, the timeout and the retry right.
- **The parser fast path is a behaviour change on the order path**, deliberately: a self-authored
  touch leaf now routes with no model and no key. It was always what the code claimed to do.
- **The `candles.length === 0` re-fetch clause is gone** — an empty series has a TTL now, as an FMP
  null quote does. An uncovered symbol answers `[]` for an hour instead of being re-asked per read.
- **Yahoo's `getNumericQuoteFast` config knob** (`PAPER_FAST_QUOTE_TTL_MS`) went with its one
  consumer — one line in `config.js`, §9's file, touched for that alone.
- **Not changed, recorded for the model/prompt review:** the tool registry declares
  `web_search_20250305`; the `_20260209` variant is supported on every model in `llmModels` except
  Haiku 4.5, so it is a per-model choice. `DEFAULT_MODEL` is Sonnet 4.6 — a product/cost decision.
- **The cTrader ctid cache has no test seam** (the session provider is named imports; ESM namespaces
  are frozen). The REST half is asserted through a method seam; the test says which half it covers.

### Behaviour changes a reader should know

- Every third-party JSON call now has a 10s timeout, a metered line, and a retry on 429/5xx —
  including Finnhub and FRED, which had neither.
- A self-authored stop/target/ladder rung routes to the broker without a model call.
- A truncated or refused model reply is logged with the model and the reason.
- A down or uncovered symbol is asked for candles once per hour.
- The news shelf and the candle envelopes reset on restart (one fetch each to warm).
- IBKR `getAccount` reports `balance` as cash and `equity` as net liquidation, like cTrader.

### Frontend follow-ups (botmarket-frontend)

None. No wire shape changed.

### Tests added

`ibkrAccounts`, `priceAnalytics` (the lifted functions, offline through the router seam),
`mongoCache.util`, `conditionParserLiteral`, `ctraderAccountsCache`, `httpRetry` (POST body,
error body), `candleWindow` (three reads of a failing or empty provider cost one fetch),
`anthropicToolBlocks` (the stop lines), `fmpProviderTools` (the usable-parts gate); the two outage
tests re-aimed at user-worded leaves; the two news tests off `fs`. Suite 2936 → **2965**, and
10 minutes → 63 seconds.

---

## QA / CR cycle on §7 (2026-09-16)

QA: lint clean repo-wide; full suite **2965 / 0 in 65 seconds** at the §7 write-up, **2968 / 0** with
this cycle's fixes; all **278** backend modules import cleanly; 16/16 archived modules load.

Docs: §7 written up; the §2 "known flake" note points at its resolution. CODE_MAP's
`anthropic.provider` line said "LLM chat/streaming" and now says what the one call path does; the
Testing section says the suite is a minute and offline, and why it was not; `price.service` and
`news.service` have entries; `priceAnalytics.service` and `mongoCache.util` are new entries. The
monitoring doc's parser diagram gains the deterministic first step; the OHLCV doc stops drawing a
file cache.

### CR findings on the §7 range, and what was done

A high-effort review over `48a0422..HEAD` (9 commits) confirmed the Anthropic loop consolidation,
`parseTouchLiteral`'s shape against both readers, the Mongo-cache document compatibility, the
`aggregateCandles` unification, the IBKR parse and the analytics move (diffed line-for-line) — and
found five things, **every one of them in this section's own commits**. The two caches I added to
the cTrader adapter were both wrong in a way that matters, and the failure hold I added to the
candle cache overshot.

| | Where | What | Done |
|---|---|---|---|
| 1 | `ctrader.adapter` accounts cache | The 60s `/tradingaccounts` cache was reasoned as "the account set almost never changes" — true of the IDENTITY, false of the same rows' balance/equity/margin/freeMargin, which move on every fill. The next sizing read after a fill saw pre-fill free margin for up to a minute. | 5 seconds — a burst collapser, not a cache. Medium |
| 2 | `ctrader.adapter._session` | A cached ctid bypassed `_freshTokens`, the read that throws `BROKER_DISCONNECTED` once a connection is deleted. A just-disconnected broker would keep placing and closing over the still-authenticated socket for up to ten minutes. | `_freshTokens` first, on every call, ahead of the cache. Medium |
| 3 | `price.service` failure hold | Stamping a failed fetch like a success met the quota goal and overshot: one transient failure on a first read left every chart, indicator and daily condition on that symbol reading `[]` as `cached: true` with no reason for the hour. | `lastFailure { at, error }` on its own field; a two-minute hold; `reason: 'fetch_failed'` on every read inside it; cleared by the next success. An empty SUCCESS still holds the hour. Medium |
| 4 | `http.util.getJson` | `clearTimeout` ran before the body was read — a 5xx status with a stalled body held the caller forever, the one case "timeoutMs bounds each attempt" exists for. | Body reads inside the timer. Low |
| 5 | `gnews.provider` | GNews limits per SECOND; the old fixed 1.4s retry was the right number and the pipe's 0–300ms jitter is not. | `retryMinMs` — a floor in the one pipe, GNews passes 1.1s. Low |

The lesson the three medium ones share: a cache is a claim about what does not change, and the
claim has to be made about the FIELDS, not the endpoint. `/tradingaccounts` is two facts in one
row; the ctid cache saved a socket round-trip and, unasked, a Mongo read that was doing a different
job.

### Carried forward

- **§9 decision:** what an error may tell the client — now across seven controllers converted
  only where they never caught.
- **§8 (Aether):** `aether.controller` still hand-rolls try/catch; the house run's token spend is
  unbooked (two paths: the scheduled re-model, `sleeveSource`'s run); `aetherQuickRead` reads
  Prometheus's quick-read mode.
- **§9 (`_shared`):** five controllers validate and TRIM messages with `parseChatMessages`, then
  pass the RAW body to the agent.
- **Model / prompt review, not code:** `web_search_20250305` where the `_20260209` variant serves
  every model in `llmModels` except Haiku 4.5 (a per-model choice); `DEFAULT_MODEL` is Sonnet 4.6;
  `get_chart`'s description names "the Kairos single-pick"; the revision trail rides every
  Prometheus update-mode turn uncapped.
- **§10:** the suite is offline and a minute long — the flake list §1 opened is closed. What remains
  for the tests section is coverage vs §1–§9, and `scripts/**` hygiene (three scripts still name
  `data/news/lanes`).
- **`usaspending.provider`** is kept by decision; it has no production importer and rides the pipe.
- **The cTrader ctid cache has no test seam** for its socket half (named imports); the REST half is
  asserted. A method seam on the session provider would close it.

---

## QA / CR cycle on §5–§6 (2026-09-16)

QA: lint clean repo-wide; full suite green (**2932 / 0** at the last §6 code commit, then **2936 / 0**
with this cycle's fixes); all **277** backend modules import cleanly; 16/16 archived modules load.

Docs: §5 and §6 written up. CODE_MAP gained entries it never had — `api/strategy` (a whole desk), the
coverage monitor and its two pure modules, `tilt.assess`, `houseArtifact.repo`, `tiltNotify` — and
corrected the coverage entry ("one doc per user+symbol" → house-owned), the chat entry's transport
(`sendBotMessage` → `postCard → postBotCard`), `tokenUsage`'s bare filename, and `sleeveSource`'s
"house spend" (unbooked). APP_SPEC's card table gained the four cards it was missing (`tilt_event`,
`coverage_event`, `coverage_refreshed`, `sleeve_sourced`), the review offer's roster
(`listAllUserIds` → `listAdminUserIds`, true since 2026-09-14), and the rule the two §6 HIGH bugs
broke: a house card's audience is the admin roster, every time. `roles-and-sourcing` says the
scheduled re-model runs with no user and books nothing.

### CR findings on the §5–§6 range, and what was done

A high-effort review over `dc7f8a1..HEAD` (26 commits, 83 files) confirmed the mechanics — the
entity-repo migration's filter shapes, `houseArtifact.revise`'s atomicity, `startRun`'s single-flight
window, the null-user degrade path, every removed export's callers in both repos — and surfaced two
findings. **Both are in §4's range, and both are consequences of §4's own fixes**, which is what a CR
pass after a section is for.

| | Where | What | Done |
|---|---|---|---|
| 1 | `portfolio.controller` / `portfolioState.getPortfolioStateCached` | **§4 made the 5-minute snapshot the ONLY description of the book Atlas edits** (`4aa9b61` stopped the client sending `portfolioIdeas`), and only the review paths invalidated it. A holding deleted or resized from the ideas list, or corrected/removed in adopt, stood in Atlas's next turn as it was — itemId and all — so the change Atlas proposed against it came back `not_found`: the very failure §4 closed, reachable through freshness instead of an empty list. The client list had been masking the gap by being fresh every turn. | `invalidatePortfolioStateFor(doc)` — keyed off the document, a no-op without a `portfolioId` — called from `tradeIdeas.updateIdea` and `deleteIdea` and from adopt's `correctHolding` / `removeHolding` (as an injected dep, so the tests assert it). Medium |
| 2 | `rebalanceNotify.REASON_COPY` | §4's new `remove_item` refusal (`order_pending_cancel_first`) got copy on the CLIENT (`reviewApply`) and not on the receipt card, which printed the raw slug. | Worded, and deliberately apart from `live_use_exit_item` for the reason the §4 write-up gave. Low |

One more came out of re-reading the range myself: `houseArtifact.repo.revise` sent `$set: {}` when a
caller had nothing to set — a no-op on MongoDB 5+, a rejected update on anything older. Every caller
sends `updated_at`, so it never fired; the pipe no longer depends on that.

Two things the CR checked and deliberately did not file, kept here so they are not re-found:
`coverage._updateSet` skips a `flags` key that arrives without any of `FLAG_INPUTS` (no caller patches
flags directly), and `adoptBook.commitDraft` now books an unrecognised cadence word on the weekly clock
rather than monthly — consistent with `completeReview`, so a pre-existing inconsistency got smaller.

### Carried forward

- **§9 decision** still open: what an error may tell the client (`makeHandle` → `{ error: err.message }`
  vs fixed slugs). §5 and §6 each converted only handlers that never caught, so the question is
  undecided rather than answered piecemeal — now across seven controllers.
- **§7/§8:** `coverage.service` and `tilt.service` dynamic-import `monitoring/monitorUtils.fetchLastPrice`
  (a service into the monitor tier); `cTrader` `/tradingaccounts` ×3 and the uncached `_session`;
  `ibkr.adapter` parses account-summary rows twice; `aether.controller` still hand-rolls try/catch.
- **§8 (Aether):** the house run's token spend is unbooked (`resolveAgentStream` records per user).
  A house row is the fix; `sleeveSource`'s run has the same gap.
- **Prompt review, not code review:** `get_chart`'s description names "the Kairos single-pick"; the
  revision trail rides every Prometheus update-mode turn uncapped.
- **§9 (`_shared`):** five controllers validate and TRIM the messages with `parseChatMessages`, then
  pass the RAW body array to the agent.
- **§10:** `tests/unit/agentToolsRegistry` pins tool descriptions verbatim — good, and it means a
  prompt-review change to a description is a snapshot update, not a drift.

---

## QA / CR cycle on §2–§3 (2026-09-15)

QA: lint + full suite green (**2864 / 0**); all 275 backend modules import cleanly.

A repo-wide scan for the misattached-JSDoc pattern §2 and §3 had each turned up (a doc-block opener
on the line directly after a doc-block closer — the first block then documents nothing) found five
more, in `paperExecution`, `entityController.util`, `tilt.service`, `originRegistry` and
`setups.service`. All moved onto their real functions; the scan is now clean repo-wide.

### Frontend follow-ups (botmarket-frontend) — cleared 2026-09-15 in `a9532a8`

| From | What | Outcome |
|---|---|---|
| §1 | `paper.service.remote.js` defined `updateSettings` / `reset` / `getTrades` / `getEquityCurve` for deleted routes | Removed. Each has an account-scoped replacement in the same file; nothing called them, so they sat there as four methods that would 404 on first use |
| §3 | `isSetupArmed` is `looking`-only, so a `hit` limit setup offered no disarm button | **This was why §3's `POST /:id/disarm` had no caller.** `canToggle` was false on the rung where a real order rests at a broker, so the page offered nothing and the user's only exits were expiry and a validity breach. The toggle now carries three acts — arm / stop watching / **cancel the order** — the third on its own route, since a status patch would leave the order working with nothing tracking it |
| §1 | A broker-disconnected error arrives as **424**, a natural hook for a "reconnect cTrader" affordance | **Open, by choice.** Unlike the rest of this table it is a new affordance to design, not a client half of a backend change. Left for whoever owns that surface |

### Known flake (for §10)

Mid-§2 the full suite failed four tests with 33s/85s durations; the same file passed alone and the
suite passed on re-run. The run's logs show `FMP 429` / `finnhub 429` — those "unit" tests make
**live network calls** (the LLM condition parser, FMP). Load-dependent, pre-existing, and the right
fix belongs with the tests section.

**Resolved in §7 (`c1227c4`), and the cause was not in the tests.** Four providers called
`dotenv.config()` themselves, past `config.js`'s test-runner gate, so every test process that
imported them had the real keys — the parser tests were live Anthropic calls, the FMP/Finnhub ones
live quota. With the calls gone the suite is offline and runs in about a minute. See §7.

### CR findings on the §2–§3 range, and what was done (2026-09-15)

A code-review pass over `06d86d9..HEAD` confirmed the three risky deletions as correct — the
`referenceQuote` removal, the `unmonitoredExitLegs` deletion, the `EDITABLE_FIELDS` move — and
raised five things. Four are fixed in `ef538c2` and `bc72fc7`; the fifth is a decision, below.

**1. The archive stopped loading — and this review is why, twice over.** Four of the five
Kairos/Hermes modules failed at module load. `npm test` skips `archive/**` and so does eslint, by
design, so a dead-code sweep that removes an export no *live* caller reaches breaks it in total
silence. Three breaks were this review's (`PAST_ENTRY_LEGACY`, `gradedGap`, `notifyCall*`); one
(`zonesLabel`) predated it, which is the more useful fact: the promise in `archive/README.md` that
"nothing here is half-broken" had already been false for weeks.

The lesson generalises past the archive — **an invariant no check enforces is a comment**. So
`npm run check:archive` now imports every file under `archive/` and fails on the first that cannot
resolve. It is a script, not a test, because running the archive under `npm test` would undo the
reason its tests were moved out of `tests/unit/`.

One drift is deliberately *left*: `journalEntry` lost its `'scheduled'` branch when Talos guards
split that wake into `guard_time` / `backstop`, so a revived Hermes writes a fallback note on its
heartbeat. `reason` is persisted on every journal entry, making the rename a data decision for
whoever revives the desk. Written into `archive/README.md` rather than fixed here.

Three Aether tests stranded under `archive/tests/unit/` by `c6e6fa8` were **deleted**: every symbol
they import was retired on purpose and the engine they cover was rebuilt in the Python repo. They
were not a revival path, only a permanently red suite living in the archive's test folder.

**2. `positionManage._deps.syncExit` bypassed the injected db.** It closed over the module-level
`entityRepo` two lines above a comment promising every write is built over the caller's `getDb`. A
caller with an injected db and no `syncExit` override would have the two halves of one `move_stop` —
the broker amend and the exit-order record — land in different databases. Latent today (both live
callers inject neither or both). It stays injectable, since two desks and their harnesses observe
the sync by name, but the default is now resolved from the deps in hand. eslint then proved the
module-level repo unreachable from the file, which is the check that the fix is complete.

**3. `tests/test.ctrader-phase6.js` imported `currentReferencePrice`**, deleted in `c80c9ef`. Not in
the `npm test` glob, so it stayed green while being unrunnable — the same blind spot as the archive,
in a second place. Repointed at `fetchLastPrice`.

**4. Two JSDoc blocks said the wrong thing.** `captureClose`'s lost two sentences to §2's sed-based
doc reshuffle; restored from `c80c9ef^`. `broker.interface.js` had `BrokerExecution`'s description
sitting inside `BrokerProtection` (pre-existing, since `3bec8ae`). A repo-wide scan for that shape —
prose resuming after an `@tag` — found four more, all deliberate and legible; left alone.

### Open decision: `_handle` widens what errors tell the client

`makeHandle` (§1) forwards a thrown error to the one global handler at `server.js:310`, which answers
`{ error: err.message }`. The routes it replaced in `tradeIdeas` and `setups` answered fixed slugs
(`'generate_failed'`, `'hydrate_failed'`). So a Mongo or provider message now reaches the client
where a slug used to. Pre-existing for `broker.controller` / `paper.controller`, which already used
the wrapper; §2 and §3 widened it to two more surfaces.

Left as a **decision, not a silent inheritance**. The global handler is §9's file, and the choice is
between leaking internals and losing the diagnostic; either answer should be made once, for every
route, rather than per-controller. **Carried to §9.**
