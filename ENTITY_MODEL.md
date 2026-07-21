# Entity Model — Split & Blindness

Master plan ref: split overloaded `ideas` into 3 execution-tier kinds sharing one
envelope; services blind to kind. Waterfall step 1. Branch `feat/entity-model-split`.

## 1. Envelope (services see ONLY this)

```
Envelope {
  id
  kind          : idea | call | portfolio_item        // + future kinds
  userId
  parentId      : portfolio_item → book id; else null
  status        : common lifecycle enum + per-kind extensions
  owner         : minos | hermes | themis             // derived from kind
  monitor_state : { next_check_at, check_count, memo, timeline[] }
  executionBinding : { broker, accounts[], mainAccountId,
                       brokerSymbol, basisOffset, orderState, brokerOrders[] }
  cards
  payload       : <opaque, per-kind>
  sizing        : per-kind → common seam { unit, requested, resolvedQty }
}
```

## 2. Per-kind payload (only its evaluator/prompt/card touch it)

```
idea            → entry/stop/tp/additional trees, invalidation, conviction, rr, type
call            → entry_zones, reference_levels, patterns, thesis, timeframe_ladder,
                  cadence, market_sensitivity, event_risk, position_state
portfolio_item  → allocationRatio, targetWeight, thesis, sector, conviction, conviction_history
```

## 3. Storage

```
entities (single coll, kind discriminator):
  { kind: idea }
  { kind: call }
  { kind: portfolio_item, parentId: bookId }   // N flat sibling docs — NEVER an embedded array
                                               // holdings = entities.find({kind:'portfolio_item', parentId})
portfolios (separate — the ONLY non-envelope, non-executed thing):
  { id: bookId, mandate, thesis, benchmark, fingerprint, reviewCadence, nextReviewAt }
```

## 4. Ownership

```
idea            → Minos   (condition-tree eval)
call            → Hermes  (zone gate → LLM assess)
portfolio_item  → Themis  (item drift gate)  ⟶  book → Themis (book assess)
```

## 5. Execution — blind (keys off envelope, never off kind)

```
orderPlan(envelope)  → executionBinding + sizing seam
placement            → broker adapter keyed by executionBinding.broker
reconciler           → match broker pos → envelope by {id, kind}; write status + executionBinding
trades ledger        → frozen-at-fill, keyed by {id, kind}, authoritative pnl
```

## 6. Phased plan (strangler — execution stays live every phase)

```
P0  Envelope contract + entityStore repo (NEW code, zero consumers)
      - envelope type + owner-from-kind map
      - entityStore: CRUD by id / query {kind,parentId,userId,status}
      - toEnvelope(ideaDoc) adapter  ← strangler bridge (legacy idea → envelope view)

P1  Execution blind  [RISKY — money path]  still backed by `ideas`
      - task 1: AUDIT exact idea-field reads across execution
      - orderPlan / placement / reconciler / trades-ledger → consume Envelope
      - reconciler match by {id,kind}; ledger key {id,kind}
      - REGRESSION gate: existing idea trades place/reconcile/close identically

P2  `idea` kind → entities
      - saveIdea writes entities{kind:idea}; Minos reads envelopes; dual-read during cutover
      - migrate standalone ideas

P3  split `call` (drop idea-shadow)
      - call → entities{kind:call} w/ own executionBinding
      - remove buildIdeaFromCall shadow; Hermes reads envelope; reconciler already blind
      - migrate live calls

P4  split `portfolio_item`
      - holdings → entities{kind:portfolio_item, parentId}; book → portfolios coll
      - computePortfolioState + Themis read envelopes
      - migrate holdings

P5  cleanup
      - remove ownedBy / portfolioId special-cases + legacy idea-overload branches
```

## 7. Open decisions (recommendation in caps)

```
1. STORAGE     ONE `entities` coll + discriminator            [DECIDED]
2. SIZING      common seam {unit,requested,resolvedQty}; per-kind resolver
               (idea qty / call max_size / item ratio→qty)
3. STATUS      common lifecycle enum + per-kind extension set
4. MONITOR_ST  SINGLE shape all kinds; gate anchors live in payload
5. OWNER       DERIVED from kind (no stored field)
6. MIGRATION   per-phase backfill; existing ideas fork → {standalone / call-shadow / holding}
```

## P1 execution contract (from audit — what the refactor MUST preserve)

```
Execution obtains entity via db.collection('ideas').findOne({id})  (string id, NOT _id)
Broker/adapter via singleton brokerService + brokerService.capabilities(broker); the ONLY
idea field that selects a broker is `idea.broker`.

EXECUTION-BINDING reads (→ envelope.execution): broker, accounts[], mainAccountId,
  brokerSymbol, basisOffset, orderState, brokerOrders[], quantity, direction, asset,
  asset_class, entryOrderType, entryTriggerPrice, pendingOrder.plan
LIFECYCLE write-backs: status, ordersPlacedAt, restingPlacedAt, activatedAt, entryTriggeredAt,
  triggeredWhileWaiting, triggerEventAt, closedReason, closedAt, realizedPnl, exitPlacedAccounts,
  exitOrders[], nativeExit, monitorStop/Tp, stopMonitorTree/tpMonitorTree, firedExits[],
  pendingCloseReason, conditionStates.*, additional_entries.*.triggeredAt
PAYLOAD boundary = protectionPlan.routeExits + positionMonitor ONLY read raw condition trees;
  everything downstream (reconciler, ledger, notify) sees only routed {nativeExit, monitorTree}
IDENTITY/ORIGIN: id, userId, callId, portfolioId, portfolioName, groupId, allocationRatio
```

Already envelope-shaped (P1a — low risk):
```
- orderPlan.buildOrderPlanForIdea → reads ONLY {accounts, mainAccountId, quantity, userId}
- exitOrders.util (buildExitOrder/orderSymbol/closeSide) → reads ONLY {brokerSymbol, asset, direction, basisOffset}
- tradeCapture.buildOrigin → ALREADY kind-aware: origin.type∈{call,portfolio,idea}, origin.ideaId=id
                             → {id,kind} maps 1:1; single seam to make explicit
```

Hard coupling (P1b / P2–P4 — the real work):
```
- ~30 write-back sites hard-code db.collection('ideas') (ideaExecution, reconciler, positionMonitor,
  manualIdea, tradeIdeas) → the seams P2–P4 redirect
- reconciler matches by (accountId, positionId), assumes ONE position per entity
  → likely holds per-entity (each idea/holding/call = one position/acct); CONFIRM, not assume
- status-value coupling (ACTIVE=[long,short], resting/hit/looking/waiting) is idea-lifecycle vocab
- direction:'both' (calls) NOT handled by closeSide — latent gap, resolve at P3
- casing: idea camelCase vs call snake_case — absorbed ONLY if read via toEnvelope
```

## P1b design — `entityRepo` persistence facade (behavior-preserving indirection)

```
GOAL: funnel EVERY execution-path db.collection('ideas') access through one kind-blind
module, so P2 = flip one collection name (+ run migration) and every exec site follows.
P1b changes NO behavior and does NOT flip the target — collection stays 'ideas'.

WHY separate from entityStore: entityStore.COLLECTION='entities' (the FUTURE store).
entityRepo.EXEC_COLLECTION='ideas' (the CURRENT backing store, strangler window: calls
execute via an idea shadow, holdings ARE ideas). They are different collections DURING
the transition; P2 points entityRepo at 'entities' after migrating data. ACTIVE stays
idea-vocab ['long','short'] because everything physically in 'ideas' uses it (P3 generalizes).
Lookups return RAW docs (no stripId) — the reconciler operates on raw docs today; match it.
```

Surface (each method = the EXACT audited inline op; String() coercion moves inside):
```
broker-linkage lookups (kind-blind — match on brokerOrders/exitOrders shape):
  findActiveByPosition(acct, pos)      findOne {status:$in ACTIVE, brokerOrders elemMatch{acct,pos}}
  findLinkedByPosition(acct, pos)      findOne {brokerOrders elemMatch{acct,pos}}
  claimRestingFill(acct, orderId, set) findOneAndUpdate resting→live (+ $[slot] arrayFilter, after)
  backfillPositionId(acct, pos, sym)   findOneAndUpdate unlinked-slot → stamp positionId
  activeWithBrokerLinks()              find active+resting w/ links, projection{userId,brokerOrders}
by-id lifecycle writes:
  getById(id) · patch(id,fields)       updateOne {id} $set
  finalizeClose(id, patch)             findOneAndUpdate {id, status:$in ACTIVE} $set → doc (guard)
  claimExitAccount(id, acct)→bool      updateOne {id, exitPlacedAccounts:$ne acct} $addToSet (atomic)
  pushExitOrders(id, orders)           updateOne {id} $push{exitOrders:$each}
  setExitOrders(id, orders)            updateOne {id} $set{exitOrders}
```

Migration order (each step behavior-preserving, tested before the next):
```
1. entityRepo module + faithfulness tests (spy coll: each method issues the identical
   filter/update/options it replaces)                                          ← THIS STEP
2. Regression HARNESS: replay a canonical exec-event sequence (open → partial reduce →
   resync → full close, multi-account) through the reconciler against an in-memory Mongo
   double; snapshot entity docs + captured trades + broker calls; assert deep-equal
   BEFORE vs AFTER the entityRepo swap.                                        ← safety net, BEFORE any reconciler edit
3. Migrate execution.reconciler.js → entityRepo (highest risk, most self-contained). Run
   reconciler tests + harness.
4. Migrate ideaExecution / manualIdea / positionMonitor collection writes → entityRepo.
5. Fold exitOrders.util → envelope.execution while those call sites are open.
```

## P2 plan — cutover to the `entities` collection (DECIDED: flat + kind)

```
STORED SHAPE = FLAT (today's idea layout) + `kind` + `parentId`. The envelope stays a
LOGICAL adapter view (ideaToEnvelope), NOT a storage format. So NO flat-read rewrites —
reconciler/positionMonitor/ideaExecution/tradeCapture keep reading idea.brokerOrders etc.
kind is derived: portfolioId != null ? 'portfolio_item' : 'idea'; parentId = portfolioId ?? null.
At P2 `entities` holds only idea + portfolio_item (migrated from `ideas`); calls join at P3.
NO kind-filtering needed at P2 (entities set == old ideas set) — kind filters land at P3.
```

Flip surface (every physical `ideas` reference — from audit):
```
services/entity/entityRepo.service.js   EXEC_COLLECTION       (execution facade)
api/trade-ideas/tradeIdeas.service.js   COLLECTION            (idea CRUD)
api/portfolio/portfolioRebalance.service.js  COLLECTION
api/portfolio/portfolioChat.service.js  db.collection('ideas')  (meta rows)
services/portfolioState.service.js      db.collection('ideas')  (computePortfolioState)
monitoring/invalidation.monitor.js      db.collection('ideas') ×3
monitoring/hermes.monitor.service.js    getIdea dep  (reads linked idea shadow)
services/kairos.handoff.service.js      ×3  (markIdeaOwned / getIdea / update shadow)
```

Phases:
```
P2a (safe, additive — commit alone):
  - services/entity/entityCollection.js: ENTITIES='entities' (single source of truth) + kindForDoc()
  - scripts/migrate-ideas-to-entities.mjs: idempotent — updateMany add kind/parentId to all `ideas`,
    then rename `ideas`→`entities` (skip if `entities` exists), create indexes
    (id unique, userId, status, kind, parentId, orderState)
  - stamp kind/parentId on NEW inserts (saveIdea, kairos buildIdeaFromCall shadow) — harmless now
P2b (the cutover — separate commit; run migration FIRST):
  - repoint all 8 flip-surface references 'ideas'→ENTITIES
  - verify (unit tests use injected fakes → unaffected; smoke-test execution + CRUD on entities)
  - keep `ideas` renamed (reversible) until verified, then it's gone
```

## 8. Invariants (hold across all phases)

```
- services (loop, reconciler, ledger, notify, WS/SSE) touch envelope + capability flags ONLY
- per-kind logic lives in: evaluator + prompt + card renderer
- SUCCESS TEST: adding a 4th kind = new payload+evaluator+prompt+card, ZERO plumbing change
- portfolio_item is flat (own envelope); book is aggregate, not executed
- no execution shadow in `ideas` for call/portfolio_item — each carries own executionBinding
```
