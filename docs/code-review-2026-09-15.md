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
| 4 | Atlas / portfolio | `api/portfolio/**`, `portfolio.agent.service`, `portfolioState`, `sleeveSource`, `adoptBook` | ✅ done — 8 commits `e3ef6e7`..`26dfe17`, suite **2884 / 0** |
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

### Frontend follow-ups (botmarket-frontend, untouched)

| From | What |
|---|---|
| §4 | The client still SENDS `portfolioIdeas` on every portfolio stream. The controller documents that it is deliberately unread — but it is dead payload carrying a whole book |
| §4 | `adopt.service.remote.refresh` does `res.draft ?? null` and will now reject on a 409; the confirm grid should say "This book is already being adopted" |
| §4 | `reviewApply.REASON_COPY` has no entry for `live_use_exit_item` (pre-existing) or the new `order_pending_cancel_first`, so both fall through to the generic line |

### Tests added

`portfolioStateProjection` (the projection must cover every field the mapper reads — the check that
would also have caught `research_basis`), `portfolioAuthoredLine`, `enrichPositions`, plus cases on
the adopt commit-lease, the compare-and-set's losing half, and `_addItem`'s ownership scoping. Suite
2864 → **2884**. Three fake dbs were brought up to the driver's shape (`find().project().toArray()`,
`updateOne` returning a result) — which is what they should have been.

---

## QA / CR cycle on §2–§3 (2026-09-15)

QA: lint + full suite green (**2864 / 0**); all 275 backend modules import cleanly.

A repo-wide scan for the misattached-JSDoc pattern §2 and §3 had each turned up (a doc-block opener
on the line directly after a doc-block closer — the first block then documents nothing) found five
more, in `paperExecution`, `entityController.util`, `tilt.service`, `originRegistry` and
`setups.service`. All moved onto their real functions; the scan is now clean repo-wide.

### Frontend follow-ups (botmarket-frontend — not this repo, carried forward)

| From | What |
|---|---|
| §1 | `paper.service.remote.js` still defines `updateSettings` / `reset` / `getTrades` / `getEquityCurve` for deleted routes |
| §1 | A broker-disconnected error now arrives as **424**, a natural hook for a "reconnect cTrader" affordance |
| §3 | `isSetupArmed` is `looking`-only, so a `hit` limit setup offers the user no disarm button — the backend is correct whichever call it receives, but the affordance is missing |

### Known flake (for §10)

Mid-§2 the full suite failed four tests with 33s/85s durations; the same file passed alone and the
suite passed on re-run. The run's logs show `FMP 429` / `finnhub 429` — those "unit" tests make
**live network calls** (the LLM condition parser, FMP). Load-dependent, pre-existing, and the right
fix belongs with the tests section.

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
