import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _tick, _ageHours, _groupKey } from '../../monitoring/marketOpen.monitor.js'

// The market-open sweep — the drain for `awaiting_market`.
//
// It exists because the previous one didn't: `_marketSweep` lived inside Minos, the monitor for the
// `idea` kind, and when Minos was archived every deferred order in the app stopped waking up. The
// tests that matter most here are therefore the KIND-BLINDNESS ones — the state is written by three
// kinds, so a sweep that only understands one is the bug all over again.

const HOUR = 3_600_000
const NOW  = Date.parse('2026-07-15T13:30:00Z')

function entity(over = {}) {
    return {
        id: 'e1', userId: 'u1', kind: 'idea', asset: 'AAPL', asset_class: 'stock',
        orderState: 'awaiting_market', pendingOrder: { plan: [{ quantity: 1 }], builtAt: NOW - HOUR },
        ...over,
    }
}

/** A rig that records what the sweep claimed and what it posted, with nothing real behind it. */
function rig({ entities = [], open = () => true, claim = null } = {}) {
    const claimed = []
    const singles = []
    const batches = []
    const deps = {
        list:       async () => entities,
        claim:      claim ?? (async (id) => { claimed.push(id); return true }),
        isAssetOpen: (asset, cls) => open(asset, cls),
        onSingle:   async (e) => { singles.push(e) },
        onBatch:    async (b) => { batches.push(b) },
        now:        () => NOW,
    }
    return { deps, claimed, singles, batches }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

test('plan age is measured from builtAt, and is absent when there is no stamp', () => {
    assert.equal(_ageHours(entity({ pendingOrder: { builtAt: NOW - 3 * HOUR } }), NOW), 3)
    assert.equal(_ageHours(entity({ pendingOrder: {} }), NOW), null, 'no builtAt → no age')
    assert.equal(_ageHours(entity({ pendingOrder: null }), NOW), null)
    assert.equal(_ageHours({}, NOW), null, 'legacy doc with no pendingOrder at all')
})

test('a clock skew cannot produce a negative age', () => {
    assert.equal(_ageHours(entity({ pendingOrder: { builtAt: NOW + HOUR } }), NOW), 0)
})

test('grouping is per user AND per kind — never one card across desks', () => {
    assert.equal(_groupKey(entity()), _groupKey(entity({ id: 'e2' })))
    assert.notEqual(_groupKey(entity()), _groupKey(entity({ userId: 'u2' })))
    assert.notEqual(_groupKey(entity()), _groupKey(entity({ kind: 'setup' })))
    // Legacy documents predate the kind field and must group with ideas, not into their own bucket.
    assert.equal(_groupKey({ userId: 'u1' }), _groupKey(entity()))
})

// ─── The sweep ────────────────────────────────────────────────────────────────

test('a still-closed market is left alone — nothing claimed, nothing posted', async () => {
    const { deps, claimed, singles, batches } = rig({ entities: [entity()], open: () => false })
    await _tick(deps)
    assert.deepEqual(claimed, [])
    assert.equal(singles.length, 0)
    assert.equal(batches.length, 0)
})

test('one open order is unparked and gets the desk\'s own single card', async () => {
    const { deps, claimed, singles, batches } = rig({ entities: [entity()] })
    await _tick(deps)
    assert.deepEqual(claimed, ['e1'])
    assert.equal(singles.length, 1, 'one order → the existing entry-confirm card, not the batch card')
    assert.equal(batches.length, 0)
})

test('only the open assets in a mixed batch are surfaced', async () => {
    const entities = [
        entity({ id: 'stock', asset: 'AAPL', asset_class: 'stock' }),
        entity({ id: 'coin',  asset: 'BTCUSD', asset_class: 'crypto' }),
    ]
    const { deps, claimed } = rig({ entities, open: (_a, cls) => cls === 'crypto' })
    await _tick(deps)
    assert.deepEqual(claimed, ['coin'], 'the shut equity stays parked for a later tick')
})

test('several orders for one user collapse into ONE batch card', async () => {
    const entities = [
        entity({ id: 'a', asset: 'AAPL' }),
        entity({ id: 'b', asset: 'MSFT' }),
        entity({ id: 'c', asset: 'NVDA' }),
    ]
    const { deps, singles, batches } = rig({ entities })
    await _tick(deps)
    assert.equal(singles.length, 0, 'a batch must not also fire the per-order cards')
    assert.equal(batches.length, 1, 'nine holdings must not become nine notifications')
    assert.equal(batches[0].count ?? batches[0].entities.length, 3)
    assert.equal(batches[0].firstId ?? batches[0].entities[0].id, 'a', 'routes to the first order')
    assert.equal(batches[0].botId, 'idea')
})

test('the batch reports the age of its OLDEST plan', async () => {
    const entities = [
        entity({ id: 'a', pendingOrder: { builtAt: NOW - 2 * HOUR } }),
        entity({ id: 'b', pendingOrder: { builtAt: NOW - 62 * HOUR } }),
    ]
    const { deps, batches } = rig({ entities })
    await _tick(deps)
    assert.equal(Math.round(batches[0].staleHours), 62, 'the plan most likely to have drifted')
})

test('KIND-BLIND: setups sweep too, and card from their own desk', async () => {
    // The whole reason this monitor exists. `awaiting_market` is written by ideas, portfolio items
    // AND setups; the old sweep lived in a single-kind monitor and only ever understood ideas.
    const entities = [
        entity({ id: 's1', kind: 'setup' }),
        entity({ id: 's2', kind: 'setup' }),
    ]
    const { deps, claimed, batches } = rig({ entities })
    await _tick(deps)
    assert.deepEqual(claimed, ['s1', 's2'])
    assert.equal(batches[0].kind, 'setup')
    assert.equal(batches[0].botId, 'mentor', 'the card belongs to the desk that authored the order')
})

test('two kinds for one user stay two cards — never a cross-desk router', async () => {
    const entities = [
        entity({ id: 'i1', kind: 'idea' }),
        entity({ id: 'i2', kind: 'idea' }),
        entity({ id: 's1', kind: 'setup' }),
        entity({ id: 's2', kind: 'setup' }),
    ]
    const { deps, batches } = rig({ entities })
    await _tick(deps)
    assert.equal(batches.length, 2)
    assert.deepEqual(batches.map(b => b.botId).sort(), ['idea', 'mentor'])
})

test('portfolio items ride the idea desk, not a bucket of their own', async () => {
    const entities = [
        entity({ id: 'p1', kind: 'portfolio_item' }),
        entity({ id: 'p2', kind: 'portfolio_item' }),
    ]
    const { deps, batches } = rig({ entities })
    await _tick(deps)
    assert.equal(batches.length, 1)
    assert.equal(batches[0].botId, 'idea')
})

test('different users never share a card', async () => {
    const entities = [
        entity({ id: 'a', userId: 'u1' }), entity({ id: 'b', userId: 'u1' }),
        entity({ id: 'c', userId: 'u2' }), entity({ id: 'd', userId: 'u2' }),
    ]
    const { deps, batches } = rig({ entities })
    await _tick(deps)
    assert.equal(batches.length, 2)
    assert.deepEqual(batches.map(b => b.userId).sort(), ['u1', 'u2'])
})

// ─── Failure paths ────────────────────────────────────────────────────────────

test('a LOST claim posts nothing — the card is exactly-once, not best-effort', async () => {
    // An overlapping tick (or a second process) already moved it off 'awaiting_market'.
    const { deps, singles, batches } = rig({ entities: [entity()], claim: async () => null })
    await _tick(deps)
    assert.equal(singles.length, 0, 'whoever won the claim owns the notification')
    assert.equal(batches.length, 0)
})

test('one failed claim does not abandon the rest of the sweep', async () => {
    const entities = [entity({ id: 'bad' }), entity({ id: 'good' })]
    const claim = async (id) => { if (id === 'bad') throw new Error('mongo blew up'); return true }
    const { deps, singles } = rig({ entities, claim })
    await _tick(deps)
    assert.equal(singles.length, 1, 'the healthy order still surfaces')
})

test('a failed card leaves the order unparked rather than rolling it back', async () => {
    // The entity is already confirmable in the UI; a delivery failure must not undo that.
    const { deps, claimed } = rig({ entities: [entity()] })
    deps.onSingle = async () => { throw new Error('chat server down') }
    await assert.doesNotReject(() => _tick(deps))
    assert.deepEqual(claimed, ['e1'])
})

test('a card failure in one group does not stop the next group', async () => {
    const entities = [
        entity({ id: 'i1', kind: 'idea' }), entity({ id: 'i2', kind: 'idea' }),
        entity({ id: 's1', kind: 'setup' }), entity({ id: 's2', kind: 'setup' }),
    ]
    const { deps, batches } = rig({ entities })
    const realBatch = deps.onBatch
    let first = true
    deps.onBatch = async (b) => {
        if (first) { first = false; throw new Error('boom') }
        return realBatch(b)
    }
    await _tick(deps)
    assert.equal(batches.length, 1, 'the second group still got its card')
})

test('an unknown kind is still UNPARKED, just uncarded', async () => {
    // Leaving it parked would recreate the original bug for any future kind. A missing card is
    // recoverable — the order is visible in the UI; a parked order is invisible forever.
    const { deps, claimed, singles, batches } = rig({ entities: [entity({ kind: 'martian' })] })
    await _tick(deps)
    assert.deepEqual(claimed, ['e1'])
    assert.equal(singles.length + batches.length, 0)
})

test('an empty or broken read is a no-op, not a crash', async () => {
    for (const list of [async () => [], async () => null, async () => { throw new Error('db down') }]) {
        const { deps, claimed } = rig({})
        deps.list = list
        await assert.doesNotReject(() => _tick(deps))
        assert.deepEqual(claimed, [])
    }
})
