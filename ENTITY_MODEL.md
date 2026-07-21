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

## 8. Invariants (hold across all phases)

```
- services (loop, reconciler, ledger, notify, WS/SSE) touch envelope + capability flags ONLY
- per-kind logic lives in: evaluator + prompt + card renderer
- SUCCESS TEST: adding a 4th kind = new payload+evaluator+prompt+card, ZERO plumbing change
- portfolio_item is flat (own envelope); book is aggregate, not executed
- no execution shadow in `ideas` for call/portfolio_item — each carries own executionBinding
```
