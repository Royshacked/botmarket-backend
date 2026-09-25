# Entity Model — Split & Blindness

The execution tier's one shape: every kind that can place an order — `idea`, `call`, `setup`,
`portfolio_item` — shares one envelope, and every service that moves money reads only that. §1–§5
and §8 are the contract; **History** at the end is how it got here (the plan this doc started as,
2026-07, and what each phase settled). Adding a kind = payload + evaluator + prompt + card, and no
plumbing change — that is the test the whole model exists to pass.

## 1. Envelope (services see ONLY this)

```
Envelope {
  id
  kind          : idea | call | setup | portfolio_item   // services/entity/envelope.js KINDS
  userId
  parentId      : portfolio_item → book id; else null
  status        : common lifecycle enum + per-kind extensions
  owner         : talos | themis | null               // derived (ownerForKind); null ≠ unwatched — see §4
  monitor_state : { next_check_at, check_count, memo, ... }   // per-owner extras; NO timeline —
                                                              // the journal is its own collection (2026-09-17)
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
                  (ARCHIVED, and the last kind carrying `{lower, upper}` bands: the documents
                   are frozen, so they keep the shape `setup` left on 2026-09-24)
setup           → scenarios[{ entry_legs, stop_legs, target_legs, conditions, validity }],
                  conditions (root), pace_rungs, entry_mode, validity, position_state,
                  monitor_state.{ guards[], timeframe, last_assessment, dormant, cost }
portfolio_item  → allocationRatio, targetWeight, thesis, sector, conviction, conviction_history
```

## 3. Storage

```
entities (single coll, kind discriminator):
  { kind: idea }
  { kind: call }
  { kind: portfolio_item, parentId: bookId }   // N flat sibling docs — NEVER an embedded array
                                               // holdings = entities.find({kind:'portfolio_item', parentId})
portfolio_chats (one per book — the ONLY non-envelope, non-executed thing; a book is the SET of
  items carrying its portfolioId, never a document of its own):
  { portfolioId, mandate, thesis, fingerprint, reviewCadence, nextReviewAt, messages }
journal (the monitor's record, one row per READ — `services/journal.service.js`):
  { entityId, at, reason, price, rung, verdict, note, conditions[], tools[], fired?, armed[] }
  index { entityId: 1, at: -1 }; uncapped; paged newest-first through the kind's own route.
  It used to ride the envelope as `monitor_state.timeline[]` capped at 50 — one row per candle
  cannot live on a document every list fetch carries (`scripts/migrate-journal.mjs` moved it).
```

## 4. Ownership

```
idea            → null    (its condition-tree loop was DELETED 2026-08-18; nothing replaced it)
call            → null    (Hermes archived 2026-08-18)
setup           → Talos   (guard sweep on price, a read on every candle close where a condition was written)
portfolio_item  → Themis  (item drift gate)  ⟶  book → Themis (book assess)

`null` means "no kind-specific owner", NOT "unwatched" — the difference grew teeth on 2026-08-18,
when the entry and exit loops became kind-blind (`{ kind: { $ne: 'setup' } }`): an `idea` and a
`portfolio_item` are watched by loops this map cannot name. Reading null as "nothing is looking"
is wrong in the dangerous direction; a caller asking who to blame for a stale entity has to look at
the kind-blind loops too (`ownerForKind`'s own note). A holding rides the `idea` kind for execution
and is reviewed at the book tier by Themis ([desks/atlas-themis.md](../desks/atlas-themis.md)).
```

## 5. Execution — blind (keys off envelope, never off kind)

```
orderPlan(envelope)  → executionBinding + sizing seam
placement            → broker adapter keyed by executionBinding.broker
reconciler           → match broker pos → envelope by {id, kind}; write status + executionBinding
trades ledger        → frozen-at-fill, keyed by {id, kind}, authoritative pnl
```

## 5b. `entityStore` — REJECTED and DELETED (2026-08-07)

P0 below built THREE seams. Two are load-bearing today; the third never was, and the file is gone.

```
entityCrud   LIVE  owner-SCOPED CRUD per kind. _scope(userId) is the guarantee that a list is
                   only ever the caller's own. Its HTTP twin is _shared/makeEntityController.
entityRepo   LIVE  the execution facade. KIND-BLIND — matches on broker linkage, never on kind.
entityStore  GONE  generic getById/query/insert/patch/remove over `entities`.
```

WHY IT WENT. It was written as the storage seam P2–P4 would migrate each kind onto, and the
migration went a different way: `entityCrud` and `entityRepo` were built and adopted, and BOTH call
`getDb()` directly. Nothing ever imported entityStore except its own test. Its own header still
said "NO consumers yet (P0)" two phases after P0 closed.

It could not simply be adopted late, either: it has NO OWNERSHIP GUARD. `query({kind:'call'})`
returns every user's calls. That is precisely the guarantee `entityCrud._scope` exists to provide,
so wiring it up would have meant rebuilding that guard on top of it — i.e. rebuilding entityCrud.

The cost of leaving it was not zero. A reader met three persistence abstractions and had to work
out which was canonical, and it carried a second hardcoded `'entities'` literal alongside
`entityCollection.ENTITIES`, which the collection-name guard had to exempt by name.

If a kind-blind store is ever wanted again, start from `entityRepo` (already kind-blind, already
the execution path) rather than resurrecting this — and give it a scope argument on day one.

## History — the plan, and what each phase settled

This doc began (2026-07) as the strangler plan to split the overloaded `ideas` collection into
execution-tier kinds behind one envelope, with execution live at every phase. The audits and slice
lists it carried are in git (`git log -- docs/architecture/entity-model.md`, before 2026-09-19);
what follows is the outcome per phase.

| phase | plan | outcome |
|---|---|---|
| P0 | envelope contract + a generic `entityStore` | envelope + `toEnvelope` adapter built; **`entityStore` rejected and deleted** (§5b) |
| P1 | execution blind — every money-path read off the envelope | the field audit became `tests/unit/reconcilerHarness.test.js` (2026-07-21): the real reconciler over a Mongo double, the ordered op log as the executable spec |
| P1b | `entityRepo` — one kind-blind persistence facade for every execution write | **built**; matches on broker linkage, never on kind; `entityCrud` beside it is the owner-scoped CRUD (`_scope(userId)` is the guarantee a list is only ever the caller's own) |
| P2 | cutover `ideas` → `entities`, flat + `kind` + `parentId` | **done** (`scripts/migrate-ideas-to-entities.mjs`); `kind` is DERIVED (`kindForDoc`: a `portfolioId` makes a `portfolio_item`, else `idea`) and stamped at insert; the envelope stayed a logical view, not a storage format |
| P3a | calls into `entities` as `kind:'call'`, keeping the idea shadow | **done** (`scripts/migrate-calls-to-entities.mjs`); `kairos_calls` retired |
| P3b | drop the call's idea shadow; converge status vocab in position | **moot** — Kairos and Hermes were archived 2026-08-18 (`archive/README.md`); a `call` document still exists and `KINDS.CALL` names it |
| P4 | `portfolio_item` flat, book in a `portfolios` collection | **half**: holdings are flat sibling docs (never an embedded array) and Themis reads them; the book's own record stayed `portfolio_chats` — a separate `portfolios` collection was never needed |
| P5 | remove `ownedBy` / `portfolioId` special-cases | `ownedBy` is gone; `portfolioId` is the join key a holding legitimately carries |
| — | `setup` (Mentor + Talos, 2026-08-08) | the fourth kind, and the one that proved the model: payload + evaluator + prompt + card, no plumbing ([desks/mentor-talos.md](../desks/mentor-talos.md)) |

The plan's §7 open decisions, numbered as the code still cites them, as settled:

1. **Storage** — one `entities` collection with a `kind` discriminator.
2. **Sizing** — the common seam `{ unit, requested, resolvedQty }` was never built as such; each kind
   sizes in its own service (`legQuantity`, `_sizePlan`).
3. **Status** — "a common lifecycle enum + per-kind extension set": `services/entity/vocabulary.js`
   is the one home for statuses, horizons and asset classes; a kind's extras are registered there.
4. **Monitor state** — ONE `monitor_state` shape for every kind, gate anchors in the payload
   (`blankMonitorState`); the journal left it for its own collection on 2026-09-17.
5. **Owner** — derived from kind (`ownerForKind`), never stored.
6. **Migration** — per-phase backfill scripts, idempotent, each leaving the old collection as backup.

And one rule that outranks them: **envelope fields carry ONE name across every kind.** `userId` was
the violator (calls stored `user_id`, which silently broke the kind-blind owner filters; converged by
`scripts/migrate-call-userid.mjs` and, for coverage, `migrate-coverage-userid.mjs`). Payload casing
may differ per kind (a call is snake_case) and is absorbed only through `toEnvelope`.


## 8. Invariants (hold across all phases)

```
- services (loop, reconciler, ledger, notify, WS/SSE) touch envelope + capability flags ONLY
- per-kind logic lives in: evaluator + prompt + card renderer
- SUCCESS TEST: adding a 4th kind = new payload+evaluator+prompt+card, ZERO plumbing change
- portfolio_item is flat (own envelope); book is aggregate, not executed
- no execution shadow in `ideas` for call/portfolio_item — each carries own executionBinding
```
