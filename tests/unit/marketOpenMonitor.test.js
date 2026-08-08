import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _tick, _ageHours, _groupKey } from '../../monitoring/marketOpen.monitor.js'

// The market-open sweep — the ONE drain for everything that parked while a venue was shut.
//
// It exists because the previous one didn't: `_marketSweep` lived inside Minos, the monitor for the
// `idea` kind, and when Minos was archived every deferred order in the app stopped waking up. So
// the KIND-BLINDNESS tests matter most — the state is written by three kinds, and a sweep that only
// understands one is that bug all over again.
//
// Since 2026-08-07 it drains TWO sources (parked entities + queued actions) and posts ONE card per
// USER, from Axl, pointing at the list. It used to fan out a card per desk per kind, which meant two
// notifications in the same second for a single market open.

const HOUR = 3_600_000
const NOW  = Date.parse('2026-07-15T13:30:00Z')

/** A parked ENTITY: an entry whose plan was built but not placed. */
function entity(over = {}) {
    return {
        id: 'e1', userId: 'u1', kind: 'idea', asset: 'AAPL', asset_class: 'stock',
        orderState: 'awaiting_market', pendingOrder: { plan: [{ quantity: 1 }], builtAt: NOW - HOUR },
        ...over,
    }
}

/** A QUEUED ACTION: a trim/exit/scale-in confirmed off-hours. Owns no entity. */
function queued(over = {}) {
    return {
        id: 'q1', userId: 'u1', state: 'queued', asset: 'MU', assetClass: 'stock',
        action: { type: 'trim', reduceFraction: 0.3 },
        origin: { kind: 'portfolio_item', entityId: 'h1', label: 'Growth review' },
        decidedAt: NOW - HOUR,
        ...over,
    }
}

/** Records what the sweep claimed, released and posted, with nothing real behind it. */
function rig({ entities = [], queue = [], open = () => true, claim = null, release = null } = {}) {
    const claimed  = []
    const released = []
    const cards    = []
    const deps = {
        list:        async () => entities,
        claim:       claim ?? (async (id) => { claimed.push(id); return true }),
        listQueued:  async () => queue,
        release:     release ?? (async (rec) => { released.push(rec.id); return true }),
        isAssetOpen: (asset, cls) => open(asset, cls),
        onReady:     async (c) => { cards.push(c) },
        // Default to "the count IS this tick's wake-ups" so the card assertions stay about the
        // sweep. The real read (everything still waiting) has its own test below.
        countReady:  async () => 0,
        now:         () => NOW,
    }
    return { deps, claimed, released, cards }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

test('age is read from whichever stamp the source carries', () => {
    assert.equal(_ageHours(entity({ pendingOrder: { builtAt: NOW - 3 * HOUR } }), NOW), 3)
    assert.equal(_ageHours(queued({ decidedAt: NOW - 5 * HOUR }), NOW), 5, 'a queued action stamps decidedAt, not builtAt')
    assert.equal(_ageHours(entity({ pendingOrder: {} }), NOW), null, 'no stamp → no age')
    assert.equal(_ageHours(entity({ pendingOrder: null }), NOW), null)
    assert.equal(_ageHours({}, NOW), null, 'legacy doc with no pendingOrder at all')
})

test('a clock skew cannot produce a negative age', () => {
    assert.equal(_ageHours(entity({ pendingOrder: { builtAt: NOW + HOUR } }), NOW), 0)
})

test('grouping is per USER — no longer per kind', () => {
    // The regression this replaces: keying on kind as well meant one market open produced a card
    // from Atlas AND a card from Mentor, seconds apart, for the same user.
    assert.equal(_groupKey(entity()), _groupKey(entity({ id: 'e2', kind: 'setup' })))
    assert.equal(_groupKey(entity()), _groupKey(queued()), 'both sources land in the same card')
    assert.notEqual(_groupKey(entity()), _groupKey(entity({ userId: 'u2' })))
})

// ─── The sweep ────────────────────────────────────────────────────────────────

test('a still-closed market is left alone — nothing claimed, released or posted', async () => {
    const { deps, claimed, released, cards } = rig({ entities: [entity()], queue: [queued()], open: () => false })
    await _tick(deps)
    assert.deepEqual(claimed, [])
    assert.deepEqual(released, [])
    assert.equal(cards.length, 0)
})

test('one parked order is unparked and nudged', async () => {
    const { deps, claimed, cards } = rig({ entities: [entity()] })
    await _tick(deps)
    assert.deepEqual(claimed, ['e1'])
    assert.equal(cards.length, 1)
    assert.equal(cards[0].userId, 'u1')
    assert.equal(cards[0].count, 1)
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

test('a queued action is released on its own session, not the equity clock', async () => {
    const queue = [
        queued({ id: 'q_stock', asset: 'MU',     assetClass: 'stock' }),
        queued({ id: 'q_coin',  asset: 'BTCUSD', assetClass: 'crypto' }),
    ]
    const { deps, released } = rig({ queue, open: (_a, cls) => cls === 'crypto' })
    await _tick(deps)
    assert.deepEqual(released, ['q_coin'], 'one queue can hold three venues opening at three times')
})

test('ONE card per user, however many items and whatever their kind', async () => {
    // The whole point of the rework. Four items, two kinds, two sources → one notification.
    const entities = [
        entity({ id: 'i1', kind: 'idea' }),
        entity({ id: 's1', kind: 'setup' }),
        entity({ id: 'p1', kind: 'portfolio_item' }),
    ]
    const { deps, cards } = rig({ entities, queue: [queued()] })
    await _tick(deps)

    assert.equal(cards.length, 1, 'never a card per desk again')
    assert.equal(cards[0].count, 4)
    assert.deepEqual(cards[0].assets.sort(), ['AAPL', 'MU'])
})

test('KIND-BLIND: setups sweep too', async () => {
    // `awaiting_market` is written by ideas, portfolio items AND setups; the old sweep lived in a
    // single-kind monitor and only ever understood ideas.
    const { deps, claimed, cards } = rig({ entities: [entity({ id: 's1', kind: 'setup' }), entity({ id: 's2', kind: 'setup' })] })
    await _tick(deps)
    assert.deepEqual(claimed, ['s1', 's2'])
    assert.equal(cards.length, 1)
})

test('the card reports the age of the OLDEST decision', async () => {
    const entities = [
        entity({ id: 'a', pendingOrder: { builtAt: NOW - 2 * HOUR } }),
        entity({ id: 'b', pendingOrder: { builtAt: NOW - 62 * HOUR } }),
    ]
    const { deps, cards } = rig({ entities })
    await _tick(deps)
    assert.equal(Math.round(cards[0].staleHours), 62, 'the decision most likely to have drifted')
})

test('the count is everything WAITING, not just this tick\'s wake-ups', async () => {
    // A card that says 2 above a list of 5 reads as a bug. The list is the truth; the card counts it.
    const { deps, cards } = rig({ entities: [entity()] })
    deps.countReady = async () => 5
    await _tick(deps)
    assert.equal(cards[0].count, 5)
})

test('a failed count falls back to this tick rather than blocking the nudge', async () => {
    const { deps, cards } = rig({ entities: [entity({ id: 'a' }), entity({ id: 'b' })] })
    deps.countReady = async () => 0
    await _tick(deps)
    assert.equal(cards[0].count, 2, 'better a slightly low count than no notification at all')
})

test('different users never share a card', async () => {
    const entities = [
        entity({ id: 'a', userId: 'u1' }), entity({ id: 'b', userId: 'u1' }),
        entity({ id: 'c', userId: 'u2' }),
    ]
    const { deps, cards } = rig({ entities, queue: [queued({ id: 'q2', userId: 'u2' })] })
    await _tick(deps)
    assert.equal(cards.length, 2)
    assert.deepEqual(cards.map(c => c.userId).sort(), ['u1', 'u2'])
})

// ─── Failure paths ────────────────────────────────────────────────────────────

test('a LOST claim posts nothing — the nudge is exactly-once, not best-effort', async () => {
    // An overlapping tick (or a second process) already moved it off 'awaiting_market'.
    const { deps, cards } = rig({ entities: [entity()], claim: async () => null })
    await _tick(deps)
    assert.equal(cards.length, 0, 'whoever won the claim owns the notification')
})

test('a LOST release posts nothing either — same rule for the queue', async () => {
    const { deps, cards } = rig({ queue: [queued()], release: async () => false })
    await _tick(deps)
    assert.equal(cards.length, 0)
})

test('one failed claim does not abandon the rest of the sweep', async () => {
    const entities = [entity({ id: 'bad' }), entity({ id: 'good' })]
    const claim = async (id) => { if (id === 'bad') throw new Error('mongo blew up'); return true }
    const { deps, cards } = rig({ entities, claim })
    await _tick(deps)
    assert.equal(cards.length, 1, 'the healthy order still surfaces')
    assert.equal(cards[0].count, 1)
})

test('a dead QUEUE read does not stop the entities from waking', async () => {
    // The two sources are independent; one store being unreachable must not park the other.
    const { deps, claimed, cards } = rig({ entities: [entity()] })
    deps.listQueued = async () => { throw new Error('mongo blew up') }
    await _tick(deps)
    assert.deepEqual(claimed, ['e1'])
    assert.equal(cards.length, 1)
})

test('a dead ENTITY read does not stop the queue from releasing', async () => {
    const { deps, released, cards } = rig({ queue: [queued()] })
    deps.list = async () => { throw new Error('mongo blew up') }
    await _tick(deps)
    assert.deepEqual(released, ['q1'])
    assert.equal(cards.length, 1)
})

test('a failed card leaves the work executable rather than rolling it back', async () => {
    // The entity is already confirmable and the action already released; a delivery failure must
    // not undo either.
    const { deps, claimed, released } = rig({ entities: [entity()], queue: [queued()] })
    deps.onReady = async () => { throw new Error('chat server down') }
    await assert.doesNotReject(() => _tick(deps))
    assert.deepEqual(claimed, ['e1'])
    assert.deepEqual(released, ['q1'])
})

test('a card failure for one user does not stop the next user', async () => {
    const entities = [entity({ id: 'a', userId: 'u1' }), entity({ id: 'b', userId: 'u2' })]
    const seen = []
    const { deps } = rig({ entities })
    deps.onReady = async (c) => {
        seen.push(c.userId)
        if (c.userId === 'u1') throw new Error('chat server down')
    }
    await _tick(deps)
    assert.deepEqual(seen.sort(), ['u1', 'u2'])
})
