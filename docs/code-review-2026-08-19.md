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

## Status — last worked 2026-08-19

Backend `e95edeb`..`b140dfb` (16 commits) · frontend `0cc4dfc`, `cce5f44` (2 commits).
Suites at hand-off: backend **2494 pass / 0 fail**, frontend **639 pass / 0 fail**.

| § | | |
|---|---|---|
| 1 | Broker interface sealing | ✅ done (§1.3 and §1.6 open by choice) |
| 2 | New agent is not plug-in | ✅ done, §2.1 partly withdrawn |
| 3 | New entity / kind — two vocabularies | ⚠️ **WITHDRAWN** — premise wrong; two real bugs under it, fixed |
| 4a | `candleFetch` calls FMP twice | ✅ done |
| 4b | The two candle stacks | ✅ done — found a live defect underneath |
| 4c | Hand-mirrored BE→FE logic | ✅ partly; the rest qualified and deliberately kept |
| 5 | Plasters to remove | ✅ **done** |
| 6 | Convention drift | ✅ §6.1 done; §6.2 and §6.3 both **withdrawn** |
| 7 | `mode` means two things | ✅ guarded (`0998a02`) — the rename is still the thorough fix |

**Read this before trusting anything below.** Four of this document's own claims did not survive
being acted on, and each is marked in place: §1.5 (a bug in a component nothing renders), §2.1
(asked for a factory the code argues against), §4b ("different vendors" — they share one router),
§6.2 (three different values, not one constant twice). The pattern is that findings written from
reading a file were weaker than findings found by trying to change it. Verify before building on any
remaining item.

**Where the value actually was**, for calibrating the rest: the two biggest defects fixed this pass
were **not** in the review. A `/stream` endpoint with no spend limit was §2.4's side-note; a request
for 300 candles silently returning 30 days' worth — which made every long-lookback indicator read
n/a forever — was found while fixing a §4b claim that was itself wrong.

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

**1.5 — Frontend `MonitorDashboard`** derived the supported-broker list from
`Object.keys(BROKER_LABELS)`, so a broker added to the factory without a label entry would be
invisible. ⚠️ **MOOT — the component was never mounted.** Nothing imported it, so the bug was not
reachable from the running app. Deleted rather than fixed (frontend `cce5f44`). The lesson is worth
keeping: the finding was written from reading the file, not from asking whether anything renders it.

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

**2.1 — Backend scaffold.** ⚠️ **PARTLY DONE, AND THE CLAIM WAS OVERSTATED** (2026-08-19,
`4fa3fcf`). Reading the six desks side by side does not support a `createDesk()` factory. Two
things were genuine copied MECHANISM and are now shared in `agentUtils`:

- `cachedBlock(text)` — the `cache_control: { type: 'ephemeral' }` literal, hand-copied at **seven**
  sites. The worst kind to copy: losing it is invisible, because the request still succeeds and
  merely re-sends the whole prompt uncached forever. Only the bill says so.
- `buildDeskMessages({messages, userPrompt, max})` — the "opening turn or trimmed history" branch,
  hand-copied at three. Each copy carried the same warning comment, which was the tell.

What is left after those is **not** scaffolding: the tag set, the parsing, the return shape, the
turn context and the per-desk cache strategy are each the desk's own judgment, and folding them
into one entry point is the cross-desk unifier the house rule forbids (the same reasoning
`suggestions.service.js` already records for itself). The remaining repetition — the
`_run = runAgentStream` / `_venueSection` seams and the `_run({...})` argument list — is a shared
CALL rather than shared logic, and wrapping it would buy indirection, not safety.

**2.2 — Frontend send lifecycle.** ✅ FIXED (frontend `0cc4dfc`). `useChatStream.run()` now owns
the turn — the re-entrancy guard, the abort wiring, and the `finally { endStream() }` whose absence
is invisible (Stop stays lit, the input dies, nothing logs). All six chats went through it;
`begin`/`beginContinue` remain for the four `_continue` resume paths, which start from a stopped
bubble rather than a fresh user turn. `MentorPanel.jsx` is converted in the working tree but left
uncommitted — it also carries in-progress worksheet-fold work.

`_saveThread` was NOT extracted and should not be: it is already one call into one shared service
(`threadsService.saveDraft`), and each panel's six-line wrapper names its own agent, subjectType and
state shape — that is the desk's judgment, not scaffolding. Original text follows.

**Original finding:** `_saveThread`, `_send`, `_continue` and the `onLoadingChange` effect are
near-identical across five panels. Compare `StrategyPanel.jsx:100-140` with
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

**2.4 — `server.js:168` is the dangerous one.** ✅ FIXED (`ae9feaf`) —
`tests/unit/agentLimiterCoverage.test.js` walks every mounted `/stream` route, resolves it through
server.js's own `app.use` mounts, and fails when one is not behind `agentLimiter`. It also checks
the reverse (a limited path nothing serves) and the mount ORDER. Verified by simulating a seventh
desk and watching it fail. The original text follows.

 Forget that line for a new desk and its
`/stream` endpoint gets no `agentLimiter` — only the general API limiter. Silent, unbounded
token spend. `loopContract.test.js` and `botRegistry.test.js` prove the guard-test pattern
already exists here; this one is a one-liner to add.

**2.5 — `pages/MainPage.jsx`: 3064 lines, 50 `useState`, ~25 `useEffect`.** Per-desk state
comes as a quadruplet (`<desk>Seed` / `<desk>Inbox` / `<desk>ChatRestore` / `<desk>ResetKey`) —
see lines 259-309. Adding a desk means 44 edits in this one file. `openForEdit` (line 1857) is
a per-kind registry embedded in a page component; it belongs beside
`services/entityResolve.js`'s `GETTERS` as a module-level `OPENERS` table.

---

## 3. New entity / kind — ⚠️ THE PREMISE WAS WRONG

**Claimed:** `KINDS` holds only `idea`/`call`/`portfolio_item` while the watchlist, Axl and chat
speak `setup`/`coverage`/`scan`/`portfolio`, with a hand-written map between them — so build one
registry with a per-kind row.

**On inspection there is no vocabulary to unify** (fixed differently in `f6fd787`):

- `portfolio` and `portfolio_item` are **not two spellings of one thing.** A book is the SET of
  items carrying its portfolioId and is never a document; `portfolio_item` is one holding.
  `chat.service`'s `portfolio_item → portfolio` map routes an item's notification to the book's
  bot — a real mapping between two real concepts, not drift.
- `coverage` and `scan` are research artifacts in their own collections with no execution tier.
  `KINDS` is the ENVELOPE's enum, scoped to the execution tier on purpose.
- The registry would have been speculative work built on a misread.

**Two real bugs were underneath it, and they were the whole finding:**

1. **`setup` was missing from `KINDS`** despite living in `entities`, carrying brokerOrders and
   going through positionManage like the other three. `isKind('setup')` answered false about a kind
   that plainly exists, and `ownerForKind('setup')` answered null — "no monitor" — about the one
   kind with a single named owner that actually runs (Talos).
2. **`null` had drifted from "unwatched" to "no SINGLE owner"** with nothing saying so. When the map
   was written a kind had one monitor or none; since 2026-08-18 the entry and exit loops are
   kind-blind (`{ kind: { $ne: 'setup' } }`), so an idea IS watched, by loops the map cannot name.
   Its comment still read "no monitor watches either kind" — wrong in the dangerous direction for
   anyone asking who to blame for a stale entity.

**Cost of adding a kind, actually measured:** the touch points CODE_MAP's "Where to add things"
table already lists are per-kind DECISIONS (which statuses, which bot, which desk reopens it), not
mechanism. That is the judgment-stays-with-the-kind rule working, not duplication.

---

## 4. Duplications worth money

**4.a — `candleFetch` called FMP twice on every fallback.** ✅ FIXED (`c2006b5`).
`fetchMarketCandles` now goes through `getTickerAggregates` only, so the FMP-vs-Massive decision is
made once, in `candles.provider`. Two further things came out of it:

- **`USE_FMP_CANDLES` never reached the chart.** The direct call did not consult it, so turning the
  flag off left this path going to FMP first anyway. It also sat in a module-level `const` captured
  at import, freezing it against config.js's live-getter design. Read per call now.
- **`candles.provider` had no test of its own.** Its policy was asserted in `candleFetch`'s tests,
  against `candleFetch`'s copy of it — which is how testing the copy made the copy look tested.
  `tests/unit/candlesProvider.test.js` covers it directly, including the flag-off branch.

**Residual, deliberately left:** `yahoofinance.provider._candles` is a *third* FMP-first
implementation, serving the analytics functions (risk / correlation / cycle). It cannot simply route
through `candles.provider` — that would close a cycle (`candles.provider → massive → yahoo →
candles.provider`). It is off the chart path, so it costs no duplicate request there; if it is ever
unified, the import direction is the problem to solve first.

**4.b — The two candle stacks.** ✅ FIXED (`5e7a386`, `602c16e`) — **and the finding as written
was wrong.** They do NOT use different vendors: both go through `candles.provider.getTickerAggregates`.
What actually differed was the cache, and underneath it something worse than either:

- **A request for 300 bars returned thirty days' worth.** `_resolveFetchWindow` accepted `from`/`to`
  in ms; `_resolveSecRange`, which decides what a read RETURNS, accepted only `fromSec`/`toSec`. So
  the monitor's `CANDLE_COUNT = 300` daily ask got the ~22 trading days that fit in a month, and
  **every indicator with a longer lookback read n/a permanently** — a condition written on SMA-200
  could never come true, with no error anywhere. `indicator.evaluator`'s SMA-200 warmup warning is
  that same bug seen from the far end. Both windows normalise through one resolver now, and `ohlcv`
  sizes its request from the count with per-span calendar slack (floored at the old 30 days).
- **The disk cache is gone.** It sat on the monitor's hot path (blocking `existsSync` + read + parse
  before every evaluation, pretty-printed write after) and bought nothing for intraday, which passes
  `refresh` and fetches regardless. Unlocked read-modify-write could drop a concurrent loop's bars;
  the non-atomic write could leave truncated JSON. In memory now — `data/` was gitignored and
  machine-local, and the app is deliberately one process.
- **Caught while making it:** naming a window would have defeated `syncCandles`' incremental fetch,
  so every intraday tick would have re-pulled the whole window — the §4a quota burn re-entering
  through the back door. `fetchStartMs` keeps tail-only fetches and backfills once.

Neither module had a single test, which is how a flat 30-day window survived in the path the
monitors evaluate on. `tests/unit/candleWindow.test.js` covers all three decisions.

**4.c — Hand-mirrored backend→frontend logic.** ⚠️ **PARTLY DONE, and the inventory needs
qualifying.** Two of the nine are now gone, and the rest divide into kinds that want different
answers — "serve the constants" was too glib for most of them.

| Backend | Frontend | Verdict |
|---|---|---|
| `BALANCE_TOLERANCE_BP` | `StrategyPanel` | ✅ **FIXED** — the server sends `balanceOf()` on the draft; the panel reads the verdict |
| `portfolioMode.BROKER_LABELS` | `MonitorDashboard` | ✅ **GONE** — the component was dead (§1.5) |
| `chart.evaluator._buildStudies` | `chartOverlay.js` | **Unavoidable.** A render port; the FE must draw without a round trip |
| `klineRender.provider` | `PriceChart.jsx` | **Unavoidable**, same reason |
| `market.service` sessions | `MarketClocks.jsx` | Display-only, ticks every 30s — a round trip would be worse |
| `setup.schema.computeRR` | `orderRisk.util.js` | **Do NOT "fix" by serving it.** The server's `rr` is per SCENARIO at authoring time; the dialog's is for the PLAN about to be placed, over levels the chart overlay derived, at the quantity actually chosen. Different inputs by design — only the *pessimistic convention* is shared |
| `workspace.model.resolveWorkspace` | `useWorkspaceMode` | A 3-line precedence rule |
| `venue.resolve.resolveMode` | `ideaWorkspaceMode` | Already guarded by a shared case table asserted in both repos; collapses to `idea?.mode ?? 'live'` once a backfill lands |
| adopt commit gate | `adopt.utils.js` | Previews a server gate so the button does not lie |

**The honest constraint:** there is no sound cross-repo guard without shared packaging (a published
package or a submodule). The duplicated case table used for `resolveMode` is the best available
pattern and only helps if both copies are updated. Where a value is a pure server VERDICT, serving
it — as the tilt balance now is — removes the mirror outright, and that is the move to reach for
first. Where the two sides compute different things from different inputs, the mirror is real and
should stay.

## 5. Plasters to remove

**5.1 — the `dismissed` / `dismissOutcome` dual-write.** ✅ DONE (`047a6bc`). Old documents keep
their field and the FE fallback keeps reading them; what stopped is stamping a dead field onto new
writes.

**5.2 — Empty directories.** ✅ Frontend done (`cce5f44`). ⬜ **`api/kairos/` on the backend is
still there.**

**5.3 — Dead frontend files.** ✅ DONE (`cce5f44`) — those four plus `MonitorDashboard/`
(three files), ~1,700 lines in total.

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

**5.6 — `sse.util.js` header.** ✅ DONE (`047a6bc`), along with the empty `api/kairos/` directory
(§5.2's backend half). The header named the desks by hand and still listed `kairos` and an
`orchestrator` that predates them; it now says why it does not need a roster — `agentLimiterCoverage`
guards the real set.

---

## 6. Convention drift

**6.1 — the hand-rolled reason ladder.** ✅ FIXED (`0998a02`). Original text follows.

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

**6.2 — `MAX_RECENT_MESSAGES` vs `MAX_MESSAGES`** — ❌ **WRONG, WITHDRAWN.** They are not the same
constant under two names: the values differ on purpose — 8 (analyst/mentor/strategy), 10
(portfolio/scanner), 12 (axl). How much history a desk needs is judgment, and the desks legitimately
disagree. Only the NAME is inconsistent, which is cosmetic and not worth the churn of touching six
files. `buildDeskMessages` now takes `max` from the caller precisely so this stays per-desk.

**6.3 — the shared desk stylesheet.** ⚠️ **WITHDRAWN — already a decision, not drift.** The file's
own header names the honest fix (`_chatShell.scss`) and defers it with a better reason than this
review had for doing it: a visually-unverifiable change that belongs in a pass where the panels can
be eyeballed side by side, not smuggled into a refactor. Nothing here can verify it visually, so it
stays. What WAS wrong was the header's roster — it claimed nine importers including Kairos
(archived) and AxlHub (which only mentions the file) — corrected to the real five importers and
twelve class-name consumers (frontend `3cc955c`). The second figure is the true size of the rename
and the note had never carried it.

---

## 7. Latent bug worth pinning

`mode` means the **workspace** on an `idea` / `setup` but the build **lens** on a `call` —
documented at `cmps/TradeIdeas/tradeIdea.utils.js:770`. It works today only because the lens
values (`discretionary` / `smc` / `institutional`) happen not to collide with the workspace
values (`live` / `paper` / `manual`). Name a future lens `live` and every call on it silently
changes workspace.

Cheapest fix: a test asserting the two value sets never intersect.

---

## Open work, in the order I would take it

1. ~~§5~~ ✅ **DONE in full** (backend `047a6bc` `df84511`, frontend `1df27bd` `74016e8`). §5.5's
   `_idea` aliases went last, on evidence: a raw scan of all **508 stored documents** across seven
   collections found zero carrying a legacy verb or field. 28 review cards exist, 16 still pending,
   and none carries `update.changes` at all.
2. ~~§7, the `mode` collision~~ ✅ GUARDED (`0998a02`). The word lists are asserted disjoint and
   resolveMode's handling of a lens is pinned. The thorough fix — renaming the call's field so the
   overload is gone rather than watched — touches stored documents and is still open.
3. ~~§6.1, the reason ladder~~ ✅ DONE (`0998a02`). `strategy.controller` answers through
   `sendReason`; the guard now catches the TABLE shape it was blind to. `paper.controller` was named
   alongside it and is **not** an offender — its `_fail` reads `err.status` from a thrown typed
   error, the other style CODE_MAP blesses. §6.3 (three panels importing PortfolioPanel.scss) is
   what remains of §6.
4. **§3, the two kind vocabularies** — the largest remaining, and the one to scope carefully.
   `KINDS` holds `idea`/`call`/`portfolio_item` while the watchlist, Axl and chat speak
   `setup`/`coverage`/`scan`/`portfolio`, with a hand-written map between them. Worth confirming the
   cost is real before building a registry: this document has been wrong about "obvious" duplication
   three times.

Two live-verification queues stand open and neither is unit-testable: section H of
`live-verify-checklist.md` (the self-executed venue — that the card ARRIVES, that notify-then-write
survives a chat failure, that an off-hours manual manage still posts immediately), and the candle
window change, which alters what long-lookback conditions can see. **A daily SMA-200 condition on an
armed entity that has never fired may start evaluating properly now** — the intended repair, but a
behaviour change on live entities rather than a refactor.

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
