# Code review — backend + frontend — 2026-08-19

Scope: duplications · shared mechanisms · plasters · spaghetti · dead code · conventions ·
plug-in-ability of new agents and new entities · whether the broker interface is sealed.

Reviewed at backend commit `7b1cafc` (branch `main`). Test health at review time:
backend **2446 pass / 0 fail** (`npm test`), frontend **639 pass / 58 files** (`vitest run`).
One cold-first-run failure was seen once and could not be reproduced across three subsequent
runs — worth a second look if it recurs, not treated as a finding here.

**Verdict in one line:** the mechanism-vs-judgment discipline is real and consistently applied
(`vocabulary.js`, `reason.util.js`, `agentTools.registry.js`, `dueLoop.js`,
`venue.resolve.service.js` are all genuinely one-place-only, and the guard-test habit is
unusual and valuable). The gap is that the **desks** and the **venues** — the two things asked
to be plug-in — are the two layers that never got the same treatment.

**Top three if only three get done:**

1. `selfExecuted` capability + capability gates in `positionManage.service.js` (§1)
2. `createDesk()` + `useDeskChat()` + a guard test on `server.js:168` (§2)
3. The double-FMP call in `candleFetch.service.js` (§4a)

---

## 1. Broker interface — sealed on access, leaky on dispatch

### What IS sealed (verified, no action needed)

- `getBrokerAdapter` is reached **only** from `api/broker/broker.service.js` — 20 call sites,
  zero bypass anywhere in `services/`, `monitoring/`, or other `api/` folders.
- `executionBus` is a clean single channel; only adapters and `paperExecution` publish, only
  `execution.reconciler` consumes.
- `broker.interface.js` is the best-documented file in the repo. The `increasePositionId`
  contract ("callers must branch on the id they get back, not on the broker's name") is
  exactly the right shape.
- `broker.factory.js` registration is genuinely one line per broker.

### What is NOT sealed

The **contract** is capability-based; the **code** is name-based.
**42** `broker === 'manual'` / `'paper'` / `'ctrader'` branches across 8 modules, against only
**5** reads of `capabilities()`.

> **DONE 2026-08-19** — §1.1, §1.2 and §1.4 are fixed (commits `e95edeb`, `93aa8b6`, `4f9b252`).
> `selfExecuted` is now a capability, `isSelfExecuted` / `isBindableVenue` live in
> `venue.resolve.service.js`, the eleven sites ask the venue, and `applyManage` owns the
> in-position decision. **§1.3, §1.5 and §1.6 remain open**, as do the deliberately declined items
> (a general capability-parity guard test, deleting `protectionPlan.unmonitoredExitLegs`).
> Live verification is queued as section H of `live-verify-checklist.md`.

**1.1 — `manual` has no capability flag.** ✅ FIXED. Its defining behaviour (the human is the
execution engine) was spelled as a name check in:

- `monitoring/entry.monitor.js:264`
- `monitoring/positionMonitor.js:174`
- `monitoring/talos.monitor.service.js:800`
- `services/protectionPlan.service.js:210`
- `api/portfolio/portfolioRebalance.service.js:223, 263, 359, 558`
- `api/trade-ideas/manualIdea.service.js:250, 284`
- `services/talos.handoff.service.js:138`

Fixed as `selfExecuted` on `BrokerCapabilities`, asked through `venue.resolve.isSelfExecuted`.
The literal now appears once, in `manual.adapter.js`.

**1.2 — `positionManage.service.js:147-165` had no capability gate.** ✅ FIXED — **this was the
sealing hole with real teeth.** "THE HANDS of in-position management, shared by every desk" called
`cancelOrder` / `amendOrder` / `closePosition` on whatever broker it was handed; the only guard was
a name check one caller up (`talos.handoff.service.js:138`), so a second desk wiring in inherited
the hole silently and its users would be told `execution_failed` for a broker failure that never
happened.

`applyManage` now answers `{ ok:true, selfExecuted:true }` from the **entity's** own venue — not the
links', since a venue that places nothing may have recorded no linkage at all. Three orderings are
load-bearing and commented in place: above the links guard, above the hours gate, and writing
nothing (the desk's sequence is notify-then-write). `tests/unit/positionManage.test.js` is the first
direct coverage this module has ever had.

**1.3 — `services/venue.resolve.service.js:35`** — `if (broker !== 'ctrader') return
{ broker_symbol: asset, basis_offset: 0 }` — a hard broker name inside the shared venue
binder every kind goes through at Generate. Needs editing the day IBKR trading lands. The
general path already works: `resolveSymbol` answers `found:null` for adapters that can't
resolve, and `computeBasisOffset` answers 0 for non-index instruments.

**1.4 — `api/setups/setups.service.js:31`** ✅ FIXED. It held
`new Set(['ctrader','paper','manual'])` — a second, narrower broker registry that silently omitted
`ibkr`. Now `isBindableVenue(broker)` (`trading || selfExecuted`), which yields the same three today
and admits IBKR the day its trading flips on. The test pinning IBKR's refusal is written to fail at
that moment.

**1.5 — Frontend `cmps/MonitorDashboard/MonitorDashboard.jsx:99`** derives the supported-broker
list from `Object.keys(BROKER_LABELS)`. A broker added to the factory with no label entry is
invisible in the UI.

**1.6 — Capability set is missing flags the app actually needs:** `selfExecuted` (§1.1),
hedging-vs-netting (currently inferred from the returned positionId — documented and correct,
but nothing exposes it to the UI), and aliased-price-space / `basisShift` (§1.3).

**1.7 — Note, not a defect:** `manual` has no execution feed, so nothing reconciles a manual
fill. That is by design (the user confirms), but it means `manual` is the one venue where
entity state and reality can drift with no reconciler. Already tracked under the
broker-reality reconciliation design memo.

---

## 2. A new agent is NOT plug-in — the biggest structural gap

`services/agentTools.registry.js` states the goal in its own header: *"adding an agent should
cost a prompt, a schema, its judgment and its card copy — never new plumbing."* The tool
registry honours it. The desks do not.

**2.1 — Backend: ~150 lines of identical scaffold in all 6 agent services.** Repeated in
`analyst` / `axl` / `mentor` / `portfolio` / `scanner` / `strategy`:

- the `_run = runAgentStream` and `_venueSection = buildVenueSection` test seams
- `attachTurnContext(..., await _venueSection(userId))`
- the system-prompt block `{ type:'text', text: prompt + LANGUAGE_RULE + VENUE_RULE, cache_control }`
- `buildTagCaptures({...})` / `stripEmitTags(text, [...])` / `normalizeMessages(messages, MAX)`

There is no `createDesk({ prompt, tools, tags, buildTurnContext })` factory.

**2.2 — Frontend: `_saveThread`, `_send`, `_continue` and the `onLoadingChange` effect are
near-identical across five panels.** Compare `StrategyPanel.jsx:100-140` with
`AnalystPanel.jsx:107-140` — the only per-desk parts are the agent name, the `subjectType`,
the `chatState` builder and the draft setter. A `useDeskChat({ agent, subjectType, service,
buildChatState, onDraft })` hook collapses ~120 lines × 5.

**2.3 — Six parallel desk registries kept in step by hand:**

| Registry | Location |
|---|---|
| `BOT_IDS` | `api/chat/chat.service.js:26` |
| `VALID_PIPELINES` | `api/axl/axl.controller.js:10` |
| `EDIT_KIND_DESKS` | `services/agents/axl.agent.service.js:101` |
| `HANDOFF_DESKS` | `services/agents/scanner.agent.service.js:194` |
| agent rate-limiter desk list | `server.js:168` |
| `isSubstantive` agent branch | `services/thread.util.js:37` |

Frontend adds `AGENTS` + `DESKS` (`cmps/AxlHub/agentMeta.jsx`), `services/pipeline/contracts.js`,
`services/pipeline/doors.js`, `services/aiPrefKeys.js:29`.

**2.4 — `server.js:168` is the dangerous one.** Forget that line for a new desk and its
`/stream` endpoint gets no `agentLimiter` — only the general API limiter. Silent, unbounded
token spend. `loopContract.test.js` and `botRegistry.test.js` prove the guard-test pattern
already exists here; this one is a one-liner to add.

**2.5 — `pages/MainPage.jsx`: 3064 lines, 50 `useState`, ~25 `useEffect`.** Per-desk state
comes as a quadruplet (`<desk>Seed` / `<desk>Inbox` / `<desk>ChatRestore` / `<desk>ResetKey`) —
see lines 259-309. Adding a desk means 44 edits in this one file. `openForEdit` (line 1857) is
a per-kind registry embedded in a page component; it belongs beside
`services/entityResolve.js`'s `GETTERS` as a module-level `OPENERS` table.

---

## 3. New entity / kind — two competing vocabularies

`KINDS` in `services/entity/envelope.js:9` holds only `idea` / `call` / `portfolio_item`.
But `watchlist.DEFAULT_KINDS` (`services/watchlist.service.js:40`),
`axl.controller.EDIT_KINDS` (`api/axl/axl.controller.js:33`) and `EDIT_KIND_DESKS` speak
`setup` / `coverage` / `scan` / **`portfolio`** — and `api/chat/chat.service.js:49` hand-maps
`portfolio_item` to `portfolio` between the two.

So: `setup`, `coverage` and `scan` are real kinds that are absent from the kind enum, and the
same concept has two spellings across registries.

Fix direction: ONE registry with a per-kind row (collection · statuses · owner bot · watch
projector · edit desk · origin handlers) replaces six lists. CODE_MAP's "Where to add things"
table already documents the six touch points — that documentation is the evidence the
registry is missing.

---

## 4. Duplications worth money

**4.a — `candleFetch` calls FMP twice on every fallback.**
`services/candleFetch.service.js:130-136` calls `getFmpCandles` directly, then on empty falls
back to `getTickerAggregates` — which, with `USE_FMP_CANDLES` on
(`providers/candles.provider.js:33`), calls `getFmpCandles` **again** before reaching Massive.
The fallback path is exactly futures / index CFDs / broker symbols / week+month — the
instruments this app trades most. Given the FMP-429 history (own-polling quota bug), this is
a real cost. The doc comment at `candleFetch.service.js:8-10` is also wrong: it calls the
router "Massive → Yahoo"; it is "FMP → Massive → Yahoo".
Fix: call `getTickerAggregates` only, or call the Massive provider directly on fallback.

**4.b — Two candle stacks, different caches, different vendors.**

- Stack A: `services/price.service.js` → `services/ohlcv.service.js` → monitors,
  paper fills, `protectionPlan`. Backed by a **JSON file cache on local disk**
  (`services/util.service.js` `saveCandlesToFile` / `loadCandlesFromFile`, writing
  `data/candles/<SYMBOL>/`, 1h TTL, `CANDLE_SCHEMA = 'ohlcv6'`). No locking —
  concurrent loops on the same symbol+timeframe can interleave read-modify-write and lose
  bars. It is a second persistence tier alongside Mongo.
- Stack B: `services/candleFetch.service.js` (FMP-first + forming bar, in-memory) →
  `/api/market/candles`, the chart renderer, and the agent tools' `_fetchCandleRows`.

CODE_MAP justifies the *forming-bar* difference between them (a `structured` leaf must resolve
on a CLOSED candle) — that reasoning is sound. It does **not** justify the vendor and cache
difference. As it stands, the monitor and the agent can evaluate the same setup against
different vendors' bars.

**4.c — Nine hand-mirrored backend→frontend modules, none guarded across repos:**

| Backend | Frontend |
|---|---|
| `setup.schema.computeRR` | `cmps/TradeIdeas/orderRisk.util.js` |
| `chart.evaluator._buildStudies` + `studyTranslate` | `cmps/TradeIdeas/chartOverlay.js` |
| `chartRender/klineRender.provider.js` | `cmps/PriceChart/PriceChart.jsx` |
| `market.service` sessions | `cmps/MarketClocks.jsx` |
| `workspace.model.resolveWorkspace` | `customHooks/useWorkspaceMode.js` |
| `venue.resolve.resolveMode` | `cmps/TradeIdeas/tradeIdea.utils.ideaWorkspaceMode` |
| `BALANCE_TOLERANCE_BP` | `cmps/StrategyPanel/StrategyPanel.jsx:43` |
| adopt commit gate | `cmps/AdoptBook/adopt.utils.js:86` |
| `portfolioMode.util.BROKER_LABELS` | `cmps/MonitorDashboard/MonitorDashboard.jsx:99` |

The render ports are unavoidable. The pure constants (tolerance, broker list, session
calendars, workspace precedence) could be served from one `/api/meta` read instead.

---

## 5. Plasters to remove

**5.1 — `api/chat/chat.service.js:491`** — the transitional dual-write of
`dismissed` / `dismissOutcome`, commented "drop once FE ships". **The FE has shipped:**
`cmps/SocialChat/cardResolution.js:10` reads top-level `status` first and only falls back to
`dismissed` for pre-refactor history. The dual-write on *new* writes is dead weight.
Drop the two fields from the `$set`; keep the FE fallback for old documents.

**5.2 — Empty directories:** `api/kairos/` (backend), `src/cmps/KairosPanel/` and
`src/services/kairos/` (frontend).

**5.3 — Dead frontend files** (nothing imports them, extension-agnostic check):

- `src/cmps/HeaderBackground.jsx` (391 lines)
- `src/cmps/PreferencesModal.jsx` (249 lines)
- `src/customHooks/useEffectUpdate.js`
- `src/services/upload.service.js`

**5.4 — `cmps/TradeIdeas/tradeIdea.utils.js`: four exports that reduce to one.**
`ideaWorkspace` / `entityWorkspace` / `isPaperIdea` / `isManualIdea` all reduce to
`ideaWorkspaceMode`. `ideaWorkspace(x)` calls it three times (via the two predicates) to
return exactly what one call returns — `ideaWorkspace(x) === ideaWorkspaceMode(x)` for all
inputs.

**5.5 — `_idea` legacy rebalance verbs** accepted in
`api/portfolio/portfolioRebalance.service.js:178` **and** `pages/MainPage.jsx:1654-1662` and
`MainPage.jsx:3031-3032`. But `prompts/portfolio_system_prompt.md` teaches only `_item`
(14 uses, zero `_idea`). No current model emits them — only queued/stored docs written before
the rename could. Check Mongo for pending rebalance docs, then delete both sides.

**5.6 — `api/_shared/sse.util.js:2`** header comment still lists `kairos` among the streaming
endpoints (archived 2026-08-18).

---

## 6. Convention drift

**6.1 — `api/strategy/strategy.controller.js:46-56` hand-rolls a reason ladder.**
`PUBLISH_REASONS` + `_fail` instead of `sendReason` from `api/_shared/reason.util.js`. It
redefines the SHARED reason `not_found` (same status today, so no live bug) and its response
body omits the `reason` slug every other route sends, so a client must parse prose to tell
one refusal from another here.

**`tests/unit/reasonStatus.test.js` cannot catch it.** The guard matches
`reason === 'x'` branches only — not the *table* form, which is precisely the shape the three
earlier offenders were converted to. Widening the regex to also flag a shared reason appearing
as a key in a controller-local `[status, message]` table is a two-line fix.
`api/paper/paper.controller.js:69` `_fail` is the same shape.

**6.2 — `MAX_RECENT_MESSAGES` vs `MAX_MESSAGES`** — the same constant under two names across
the agent services (`mentor`/`analyst`/`strategy` use the first, `axl`/`portfolio`/`scanner`
the second).

**6.3 — Mentor / Analyst / Scanner panels each `import '../PortfolioPanel/PortfolioPanel.scss'`.**
The shared desk styling lives inside one desk's stylesheet. Should be a `_desk-panel.scss`
partial.

---

## 7. Latent bug worth pinning

`mode` means the **workspace** on an `idea` / `setup` but the build **lens** on a `call` —
documented at `cmps/TradeIdeas/tradeIdea.utils.js:770`. It works today only because the lens
values (`discretionary` / `smc` / `institutional`) happen not to collide with the workspace
values (`live` / `paper` / `manual`). Name a future lens `live` and every call on it silently
changes workspace.

Cheapest fix: a test asserting the two value sets never intersect.

---

## What is genuinely good (do not "fix")

Recorded so a later pass does not mistake these for drift:

- `services/entity/vocabulary.js` — one lifecycle ladder, subsets declared per kind, with the
  reasoning for why synonyms were removed.
- `api/_shared/reason.util.js` + its guard test — the right split of shared table vs
  route-owned overrides.
- `services/agentTools.registry.js` — schema is mechanism (shared), description is judgment
  (per-desk). 87 declarations deduped correctly.
- `monitoring/dueLoop.js` — the lease-and-timeout chore, shared by Talos / exits / coverage /
  tilt, with the abandon-vs-cancel subtlety documented.
- `services/venue.resolve.service.js` — five divergent mode-resolvers correctly collapsed into
  one (the FE copy is a documented, tested fallback for un-backfilled docs, not drift).
- `services/lifecycle.service.startLoop` refusing a loop without `stop()`, guarded by
  `loopContract.test.js`.
- Guard-test discipline generally: `statusLiterals`, `reasonStatus`, `botRegistry`,
  `promptPaths`, `loopContract`, `turnRegistry`, `agentToolsRegistry`, `collectionNames`.
