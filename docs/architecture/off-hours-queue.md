# The off-hours queue

**The rule (decided 2026-08-07): nothing executes off-hours, paper included.**

A real market order cannot fill into a shut market, and a simulated venue that fills anyway — at
yesterday's close — is not simulating anything. So a decision the user confirms while the venue is
closed is not executed and not thrown away: it is **queued**, they are told so at the moment they
act, and they execute it from a list at the open.

## Why it exists

The app had a coherent rule for *opening* a position off-hours and no rule at all for *changing*
one. Five call sites each decided hours policy for themselves and disagreed:

| Path | Off-hours behaviour before |
|---|---|
| `ideaExecution.placeOrdersForIdea` | refuses, `reason: 'market_closed'` |
| `tradeIdeas._attachImmediatePlan` | defers — `orderState: 'awaiting_market'` |
| `portfolioRebalance._addToItem` | 🔴 fires a market order |
| `portfolioRebalance._trimItem` | 🔴 fires a closing order |
| `portfolioRebalance._exitItem` | 🔴 fires a closing order |

The paper venue did not stop the last three either. `exitMarkPrice` degrades to the day close on
purpose (a decided exit must not be stranded by a blinking quote), and `entryMarkPrice` guards
against a **missing** price — which is not the same as a shut market, because FMP answers `200`
with the last close at 2am. So an accepted review at 02:00 could scale into a holding at the
previous close, stamp that price as the position's basis for life, and report "Changes applied".

## The pieces

**`services/pendingAction/executionGate.js` — the gate.** One question, asked in one place, by
every path about to send an order: `deferIfClosed({ userId, asset, assetClass, origin, action })`
→ `{ deferred: false }` (proceed) or `{ deferred: true, id, nextOpenMs }` (queued; do not touch the
broker). It enqueues rather than merely refusing, because refusing alone loses the decision.

**`services/pendingAction/pendingAction.repo.js` — the record.** Collection `pending_actions`.
Deliberately not a flag on the entity: `orderState: 'awaiting_market'` means one specific thing
("this entity carries a pending *entry* plan"), and a queued trim, exit or scale-in is not an entry,
owns no entity of its own, and can outlive the review that produced it. `enqueue` is idempotent per
`(user, entity, verb)` while the item is open, so a double-accepted review cannot queue two trims of
the same holding. `origin.label` is stamped at enqueue because by the open the review is closed and
that context is gone.

**`services/pendingAction/originRegistry.js` — cancel propagation.** A queued item is a decision
taken somewhere else, so cancelling it is never just a delete: the desk that decided still believes
it is happening, and Atlas would re-propose the identical trim next week having no idea it was
turned down. One entry per origin kind, keyed lookup rather than a switch — the queue stays blind to
origin, and adding a kind is one entry. `executionGate` **refuses to queue an unregistered origin**,
so a producer cannot ship a queued item whose desk can never be told it was cancelled.

## Phases

- **1 — done.** Record, registry, gate; wired into the review's exit / trim / scale-in. Rounded-to-
  zero changes refuse with a reason instead of skipping silently. `applyRebalance` reports three
  buckets (applied / queued / failed) and returns `ok: false` when nothing landed, which makes the
  FE keep the proposal for a retry and stops the review clock advancing over work that never
  happened.
- **2 — done.** The market-open sweep drains BOTH stores (parked entities + queued actions) and
  posts ONE `queue_ready` card per user, from Axl, pointing at the list. The per-desk
  `orders_ready` batch card is retired (kept on the client only to render history). `listWaiting`
  is the shared read behind both the card's count and the list; `GET /api/pending-actions` exposes
  it.
- **3 — done.** The Floor's **Queued** desk (first, because it is the only desk that is a to-do
  list). Execute routes by type: an ENTRY goes to the OrderConfirmDialog it always used; a queued
  trim/exit/scale-in gets the queue's own confirm and `POST /:id/execute`, which replays it through
  the SAME `_trimItem`/`_exitItem`/`_addToItem` that first tried it. Cancel (`POST /:id/cancel`)
  drops the row and tells the desk — an Atlas holding records the refusal in `rebalance_history` so
  the next review does not re-propose what you turned down. Lifecycle:
  `RELEASED --claim--> EXECUTING --> DONE`, unwinding to RELEASED on failure, every hop guarded.
- **5 — done.** The gate reaches the **manage-accept path**, the last route to a broker that never
  asked. A card posted before the close could be tapped at 02:00 and go straight out; on paper it
  "filled" at the day close. The gate sits in `positionManage.applyManage` — the shared executor —
  so Hermes and Talos are both covered by one call and neither desk can add a verb that forgets it.
  **The verb IS the action type** (`move_stop` │ `take_partial` │ `exit_now` │ `let_run`), because
  `enqueue` dedupes on `(user, entity, action.type)` and a single `manage` type would let a queued
  stop-move swallow the `exit_now` that came after it. `action.holderId` rides along: a call's
  position hangs off its idea, and by the open the row is all the replay has.
  - `call`/`setup`/`idea` now dispatch by **verb** (`_byWork`), not by decider like `portfolio_item`.
    The two kinds of work never share a spelling here — a monitor exit is `exit` — and rows written
    before `queuedBy` existed read back as `user`, so dispatching those by decider would hand every
    legacy overnight stop to the manage executor.
  - Cancelling one clears `position_state.pending_action`: nothing executed, so what has to be undone
    is the proposal still sitting on the position offering a decision the user has now taken twice.
  - A defer LEAVES `pending_action` standing. It is cleared when the action actually happens
    (`manageAppliedUpdate`); clearing it at accept time would take the proposal off the card while
    nothing had been done to the position.
- **4 — done.** The gate reaches `positionMonitor`: a stop or target that trips while the venue is
  shut parks the entity at `orderState: 'awaiting_market_close'` and queues the close, replayed at
  the open through the same `_closeAtBroker` the live path uses. `call`, `setup` and `idea` are
  registered (their only queued work is a monitor exit). Rows now carry `queuedBy` +
  `cancellable`.

## Who decided, and what that changes

Every row carries `queuedBy`, and it is the dispatch — not the verb.

- **`user`** — a discretionary decision (a review's trim). Cancellable: they may reasonably change
  their mind, and cancelling reaches back into the desk that decided it.
- **`monitor`** — the mechanical consequence of a plan already made (a stop that tripped overnight).
  **Not** cancellable from the list: the stop is still breached, so dropping the row would re-queue
  it on the next tick. You change a stop by moving it, not by dismissing its consequence.

This matters beyond the button. A holding carries **both** kinds, and both spell `exit` — but a
review's exit closes the whole position while a monitor's can be a SLICE (a scaled target) carrying
a leg and a fired-exit tag. `_exitItem` understands none of that and closes everything, so running a
scaled target through it would liquidate a position that was only meant to be trimmed. `_byDecider`
in the registry is what keeps them apart.

## Notes

- **Manual books are never gated.** They place no orders; their Fill card is an instruction, not an
  execution, so market hours have nothing to gate.
- **Crypto never defers** — `getMarketStatus` reports its session always open.
- **A failed queue write still blocks the order.** Losing the row is a bookkeeping failure; sending
  the order anyway is a trading one.
- Two deferral mechanisms coexist by design: `awaiting_market` on an entity (an entry whose plan is
  built) and `pending_actions` (an intent with no entity). They are merged by a READ (`listWaiting`)
  and by one drain, never by copying one into the other — that would give the same order two owners
  and two states to drift apart.
- **Exactly-once, twice over.** The sweep only speaks for what it actually woke: an entity via
  `claimIf` off `awaiting_market`, a queued action via `transition(..., { from: QUEUED })`. That
  `from` is load-bearing — the default is "any open state", and RELEASED *is* open, so without it
  two overlapping ticks would each move the same row and each post a card.
- **No expiry yet.** A queued action whose venue never opens (a delisted symbol, a bad asset class)
  sits queued forever. `STATES.EXPIRED` exists and nothing sets it.
- **A queued close freezes its position's exit checks.** `checkPosition` returns early on
  `awaiting_market_close`, the same rule `awaiting_manual_close` already had — otherwise the
  condition (still true) re-fires every poll, and a stop and a target can both look true on the same
  stale candle and queue two closes for one position.
- **A monitor exit re-reads its entity at execute time.** Hours passed; the position may have been
  closed, partly filled or reconciled since. No open legs is reported as success, not failure — the
  thing the row asked for has already happened.
- **`awaiting_market_close` is not a variant of `awaiting_market`.** The sweep's entity drain
  matches the latter exactly, so a deferred CLOSE is never mistaken for a deferred ENTRY: the queue
  owns it, and nothing promotes it to `awaiting_confirm`.
