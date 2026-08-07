# The single-instance constraint

**This backend runs as exactly ONE process. Running two breaks things — some of them silently, one
of them on the money path.**

That is a real constraint, not a preference, and until 2026-08-07 it was written down nowhere. It
is easy to violate by accident: bumping a Render instance count or a `replicas:` field is a
one-line change in a file that has nothing to do with this repo, and nothing here fails loudly
when it happens.

This document says what is safe, what is not, and what it would take to lift the constraint.

## Why it exists

Two different things are per-process:

1. **The loops.** `server.js` starts eleven background loops unconditionally. There is no leader
   election, so a second instance runs a second copy of all eleven.
2. **In-memory state that is load-bearing.** ~40 module-level `Map`s and TTL caches. Most are pure
   caches (a second copy costs money, not correctness). A few are not caches at all — they are the
   only thing making an operation exactly-once.

The distinction that matters is whether the exactly-once guarantee lives in **the data** (a
conditional Mongo write that only one caller can win) or in **the process** (a lock or a
single-flight flag). Only the first survives a second instance.

## What is already safe

These claim through Mongo, so a second instance loses the race rather than duplicating the work:

| Loop | Mechanism |
|---|---|
| Hermes (`call`), Talos (`setup`) | `dueLoop._claim` — conditional `updateOne` on the due-window, gated on `modifiedCount === 1`. Also carries a lease ≥ the check timeout, so an abandoned slow check cannot be re-selected while still running |
| `marketOpen.monitor` | `entityRepo.claimIf` — guarded `findOneAndUpdate`, pre-image truthy iff this caller made the transition |
| `marketBrief.notify` | dedupes against the posted cards themselves (`listCardRecipientsSince`), so it is idempotent by construction — this is also why a mid-fan-out restart resumes instead of double-posting |
| `paperFill` | `paperBrokerService.claimOrder(userId, orderId, { status: 'working' }, …)` — added 2026-08-07 |

`paperFill` is worth a note. It previously called `updateOrder(…, { status: 'filled' })` under a
comment saying that *claimed* the order. An unconditional `$set` that discards its result claims
nothing: two readers both see `working`, both write `filled`, and both call `openPosition`, which
is not idempotent — the user ends up in double size with one position carrying no idea linkage.
What actually prevented it was `createPollLoop`'s single-flight guard, i.e. item 2 above. It now
claims for real.

## What breaks, worst first

### 1. `execution.reconciler._locks` — corrupts exit orders

```js
const _locks = new Map()   // `${accountId}:${positionId}` → promise chain
```

A promise chain **in one process**, so a second instance does not contend for it — it cannot see
it. Four call sites (`execution.reconciler` ~99, ~133, ~216, ~243).

**What it guards is larger than the obvious reading**, and getting this wrong sends you down a
blind alley. The `exitOrders` array write is no longer the issue: that race is now closed in the
data by `entityRepo.markExitOrderFilled`, which patches ONE leg via `arrayFilters` guarded on
`status: 'working'` (2026-08-07). What the lock still owns is the **decision window**, which spans
network IO:

```
read the idea → ask the broker whether the position survived → place / cancel / re-size exits
```

Two reconciliations running that concurrently can both observe a surviving position and both act —
cancelling an order the other just placed, or placing a duplicate. **No atomic write fixes this**,
because the thing needing to be atomic is a sequence of calls to someone else's system.

Still the one to fix first: the failure is silent and lands on real orders.

**To lift it:** a Mongo lease over the whole window, keyed `${accountId}:${positionId}` — the
`dueLoop._claim` pattern, with the lease horizon ≥ the slowest broker round trip, and released on
both the success and the error path. Two things make this more than a code change, so it should not
ship blind:

- A lease that expires mid-window re-admits the exact interleaving it exists to prevent, so the
  horizon has to be sized against real broker latency, not a guess.
- A lease that fails to release wedges every future exit for that position until it times out.

That means **live broker verification**, not unit tests — the property under test is concurrent
behaviour against a real venue. See `docs/live-verify-checklist.md`.

### 2. `chatWs.socketMap` — social chat silently half-works

`userId → Set<socket>`, per process. A user connected to instance A never receives a bot card or
DM emitted on instance B. No error anywhere; the message simply doesn't arrive, and the unread
badge is wrong. **To lift it:** a pub/sub fan-out (Redis channel, Mongo change stream) between
instances.

### 3. Duplicated LLM work — cost, and duplicate history

- `coverage.monitor` and `tilt.monitor` write their bookkeeping with unconditional `updateOne`, so
  both instances run the same assessment. That is two model runs, and two appended revisions on a
  document whose whole point is an append-only trail.
- `themis.monitor` is a doorbell — two instances ring it twice.
- `marketBrief.service` caches the brief in-process (`_cache`, `max: 1`) behind an in-process
  single-flight (`_inflight`). "The morning fan-out costs one run" is true per process.

**To lift it:** the same `claimIf` these monitors' siblings already use.

### 4. `paperEquity` — duplicate points on the equity curve

Inserts a snapshot per active account per tick with no guard, so the curve gets two points per
interval. Cosmetic until someone computes a return from it.

### 5. Wasted money, no corruption

- `priceFeed._marks` — the publisher/subscriber feed. "ONE loop fetches on ONE cadence and
  publishes; everyone else reads what it published" is true **per process**: instance B's
  `readMark` misses what A published and pays for its own quote. The design still works, it just
  stops saving anything.
- `ctrader.session._sessions`, `_wiredFeeds`, `ibkr.gateway._clients` — duplicate broker sessions
  and duplicate feed subscriptions. The reconciler is broker-authoritative, so duplicate fill
  events re-derive to the same state rather than corrupting it; this is the design absorbing a
  fault it was not written for, which is luck worth noticing rather than relying on.

## If you ever need to scale out

Cheapest correct order:

1. **Fix `_locks`** (item 1) — it is the only one that corrupts money-path data.
2. **Leader-elect the loops.** Every loop except the paper mark/equity pair is idempotent-or-claimed
   once item 1 and item 3 are done; a simple Mongo lease (`{ _id: 'leader', expiresAt }`, renewed)
   is enough, and is strictly less work than making eleven loops individually safe.
3. **Fan out the WebSocket** (item 2) — needed the moment two instances serve browsers.

Steps 1 and 2 are independent; do 1 regardless, because it is a latent bug even at one instance if
a future refactor ever moves those four call sites off the shared lock.

## Verifying the constraint still holds

There is no automated check, and adding one is awkward (the failure only appears with two
processes). What is cheap is to keep this file honest: if you add a module-level `Map`/cache that
is not purely a cache, add it to the table above.
