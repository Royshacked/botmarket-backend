import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferIfClosed } from '../../services/pendingAction/executionGate.js'
import { hasOriginHandler, ORIGIN_KINDS, deskForOrigin } from '../../services/pendingAction/originRegistry.js'

// THE market-hours gate. The rule it enforces (2026-08-07): nothing executes off-hours, paper
// included — a real market order can't fill into a shut market, and a simulation that fills anyway
// at the previous close isn't simulating anything.
//
// It replaces five call sites that each decided hours policy for themselves and disagreed: two
// refused, one deferred, and three (the review's add/trim/exit) fired blind. That last group is why
// an accepted review at 02:00 could scale into a holding at yesterday's close and report success.

const ORIGIN = { kind: 'portfolio_item', entityId: 'e1', ref: 'pf1', label: 'Growth review' }
const ACTION = { type: 'add_to', addFraction: 0.25 }

const rig = ({ open, enqueueResult = { ok: true, id: 'q1' } } = {}) => {
    const calls = []
    return {
        calls,
        deps: {
            status: () => ({ open, nextOpenMs: open ? null : 1_800_000_000_000 }),
            queue:  async (rec) => { calls.push(rec); return enqueueResult },
        },
    }
}

test('an OPEN market is a straight pass — nothing is queued and the caller proceeds', async () => {
    const { deps, calls } = rig({ open: true })
    const res = await deferIfClosed({ userId: 'u1', asset: 'MU', origin: ORIGIN, action: ACTION }, deps)

    assert.equal(res.deferred, false)
    assert.equal(calls.length, 0, 'an open market must not touch the queue at all')
})

test('a CLOSED market queues instead of refusing — the decision must not be lost', async () => {
    const { deps, calls } = rig({ open: false })
    const res = await deferIfClosed({
        userId: 'u1', asset: 'MU', assetClass: 'stock', direction: 'long', origin: ORIGIN, action: ACTION,
    }, deps)

    assert.equal(res.deferred, true)
    assert.equal(res.ok, true)
    assert.equal(res.id, 'q1')
    assert.equal(res.nextOpenMs, 1_800_000_000_000, 'the row can say when it will run')

    assert.equal(calls.length, 1)
    assert.equal(calls[0].asset, 'MU')
    assert.equal(calls[0].queuedReason, 'market_closed')
    assert.deepEqual(calls[0].action, ACTION, 'the verb + its params ride along so the open can replay it')
    assert.equal(calls[0].origin.label, 'Growth review', 'stamped now — the review is gone by the open')
    assert.equal(calls[0].origin.desk, 'portfolio', 'desk filled in from the registry when unset')
})

test('crypto never defers — its session is always open', async () => {
    // Not a mock of the gate's own logic: this pins that the gate asks getMarketStatus rather than
    // assuming equity hours, which is what makes a 24h asset behave correctly through it.
    const { deps, calls } = rig({ open: true })
    const res = await deferIfClosed({ userId: 'u1', asset: 'BTCUSD', assetClass: 'crypto', origin: ORIGIN, action: ACTION }, deps)
    assert.equal(res.deferred, false)
    assert.equal(calls.length, 0)
})

test('an UNREGISTERED origin is refused, not queued', async () => {
    // A queued item whose desk can't be told about a cancellation would strand that desk believing
    // the action is still coming. Better to fail the change loudly than half-honour it.
    const { deps, calls } = rig({ open: false })
    const res = await deferIfClosed({
        userId: 'u1', asset: 'MU', origin: { kind: 'weather_desk', entityId: 'x' }, action: ACTION,
    }, deps)

    assert.equal(res.deferred, true, 'still must not execute — the market is shut either way')
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'unregistered_origin')
    assert.equal(calls.length, 0)
})

test('a failed enqueue still blocks execution', async () => {
    // Losing the row is a bookkeeping failure. Sending the order anyway is a trading one.
    const { deps } = rig({ open: false, enqueueResult: { ok: false, reason: 'error' } })
    const res = await deferIfClosed({ userId: 'u1', asset: 'MU', origin: ORIGIN, action: ACTION }, deps)

    assert.equal(res.deferred, true)
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'error')
})

// ── The registry guard ──────────────────────────────────────────────────────
test('every queueable origin has a cancel handler', () => {
    assert.ok(ORIGIN_KINDS.length > 0)
    for (const kind of ORIGIN_KINDS) {
        assert.ok(hasOriginHandler(kind), `origin '${kind}' is listed but has no handler`)
        assert.ok(deskForOrigin(kind), `origin '${kind}' has no desk — its row would have no tag`)
    }
})

test('all four execution-bearing origins are wired', () => {
    // Phase 4 added call / setup / idea, whose queued work is the monitor's own exits. Until an
    // origin can be both run and cancelled the gate refuses to queue it — that guard is what stops
    // a producer half-shipping, and it is why these arrived together with their handlers.
    for (const kind of ['portfolio_item', 'call', 'setup', 'idea']) {
        assert.equal(hasOriginHandler(kind), true, `'${kind}' produces queued work and must be registered`)
    }
    for (const kind of ['weather_desk', '', undefined, null]) {
        assert.equal(hasOriginHandler(kind), false)
    }
})

// ── the buckets applyRebalance sorts results into ────────────────────────────
// Not a call into the service (it needs a db); this pins the CLASSIFICATION, which is where the
// original bug lived: everything was "ok" and a review of pure no-ops read as "Changes applied".
const bucket = (results) => ({
    deferred: results.filter(r => r?.deferred && r?.ok !== false),
    failed:   results.filter(r => !r?.ok),
    applied:  results.filter(r => r?.ok && !r?.deferred),
})

test('a queued change is neither applied nor failed', () => {
    const b = bucket([{ ok: true, deferred: true, queuedId: 'q1' }])
    assert.equal(b.deferred.length, 1)
    assert.equal(b.applied.length, 0)
    assert.equal(b.failed.length, 0)
})

test('a change whose QUEUE WRITE failed counts as failed only — never as queued', () => {
    // Both flags are set on that result, and counting it twice would let a review complete on
    // nothing but lost rows: "queued for the open" over decisions that no longer exist anywhere.
    const b = bucket([{ ok: false, deferred: true, reason: 'error' }])
    assert.equal(b.deferred.length, 0, 'a lost row is not a queued item')
    assert.equal(b.failed.length, 1)
})

test('a rounded-to-zero change is a failure, which is what makes the whole review refuse', () => {
    const b = bucket([{ ok: false, reason: 'add_too_small' }])
    assert.equal(b.applied.length + b.deferred.length, 0, 'nothing applied AND nothing queued → refuse')
    assert.equal(b.failed.length, 1)
})
