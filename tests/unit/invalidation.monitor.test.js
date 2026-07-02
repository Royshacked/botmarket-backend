import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    checkInvalidation,
    closedInZone,
    buildEnvelopeEdges,
    buildApproachEdges,
} from '../../monitoring/invalidation.monitor.js'

// Note: the condition parser (`parseCondition`) is LLM-backed, so the actual
// close-outside-range FIRING is exercised by the proven `evaluateTree` path and
// can't run offline. Here we test the NEW deterministic logic: the arming scan,
// the edge derivation, and the branch guards that resolve BEFORE evaluateTree.

const candle = (c, t) => ({ o: c, h: c, l: c, c, v: 0, t })
const series = (...closes) => closes.map((c, i) => candle(c, 1_000 + i))

// ── closedInZone (the state-based arming check) ──────────────────────────────────

test('closedInZone: true when the latest close lands strictly inside the band', () => {
    assert.equal(closedInZone(series(100, 11), 9, 12), true)
})

test('closedInZone: arms an idea authored already in the zone', () => {
    assert.equal(closedInZone(series(10, 10), 9, 12), true)
})

test('closedInZone: false while price is only in the corridor', () => {
    assert.equal(closedInZone(series(100, 100), 9, 12), false)
})

test('closedInZone: false when the latest candle closed through the band', () => {
    assert.equal(closedInZone(series(11, 8), 9, 12), false)
})

test('closedInZone: only the latest candle counts (an earlier dip that left does not arm)', () => {
    // Dipped to 11 (in-zone) then closed at 8 — not in the zone now, so no arm.
    assert.equal(closedInZone(series(100, 11, 8), 9, 12), false)
})

test('closedInZone: edges are exclusive (a close exactly on an edge does not arm)', () => {
    assert.equal(closedInZone(series(12), 9, 12), false)  // upper edge
    assert.equal(closedInZone(series(9),  9, 12), false)  // lower edge
})

test('closedInZone: arms on the current bar regardless of its timestamp (daily-bar fix)', () => {
    // A daily bar is stamped at 00:00 — older than an intraday author-time floor. The
    // arm is a pure state check now, so an in-zone close still arms (was the NNOX bug).
    assert.equal(closedInZone(series(11), 9, 12), true)
})

test('closedInZone: guards missing candles / half-open ranges', () => {
    assert.equal(closedInZone(null, 9, 12), false)
    assert.equal(closedInZone([], 9, 12), false)
    assert.equal(closedInZone(series(11), null, 12), false)
})

// ── buildEnvelopeEdges ───────────────────────────────────────────────────────────

test('buildEnvelopeEdges: lower→closes-below, upper→closes-above', () => {
    const edges = buildEnvelopeEdges({ lower: 9, upper: 12, lowerAnchor: 'a', upperAnchor: 'b' }, 'day')
    assert.deepEqual(edges.map(e => [e.edge, e.leaf.condition]), [
        ['lower', 'closes below 9'],
        ['upper', 'closes above 12'],
    ])
    assert.equal(edges[0].leaf.type, 'structured')
    assert.equal(edges[0].leaf.timeframe, 'day')
})

test('buildEnvelopeEdges: one-sided range yields a single edge', () => {
    assert.deepEqual(buildEnvelopeEdges({ lower: 9, upper: null }, 'day').map(e => e.edge), ['lower'])
})

// ── buildApproachEdges (the new distant-entry derivation) ────────────────────────

test('buildApproachEdges: entry BELOW spot (approach above the band) — away=above, overshoot=below lower', () => {
    const edges = buildApproachEdges({ lower: 9, upper: 12, approach: 108 }, 'day')
    assert.deepEqual(edges.map(e => [e.edge, e.leaf.condition]), [
        ['approach',  'closes above 108'],
        ['overshoot', 'closes below 9'],
    ])
})

test('buildApproachEdges: entry ABOVE spot (approach below the band) — away=below, overshoot=above upper', () => {
    const edges = buildApproachEdges({ lower: 108, upper: 112, approach: 90 }, 'day')
    assert.deepEqual(edges.map(e => [e.edge, e.leaf.condition]), [
        ['approach',  'closes below 90'],
        ['overshoot', 'closes above 112'],
    ])
})

test('buildApproachEdges: null when no approach authored', () => {
    assert.equal(buildApproachEdges({ lower: 9, upper: 12, approach: null }, 'day'), null)
})

test('buildApproachEdges: null when approach sits inside the envelope (malformed)', () => {
    assert.equal(buildApproachEdges({ lower: 9, upper: 12, approach: 10 }, 'day'), null)
})

// ── checkInvalidation branch guards (resolve before evaluateTree) ────────────────

function makeDb() {
    const writes = []
    return { writes, collection: () => ({ updateOne: async (_f, u) => { writes.push(u.$set) } }) }
}

function idea(extra = {}) {
    return {
        id: 'i1', asset: 'TEST', userId: null, entryFloorAt: 1,
        invalidation: { range: { lower: 9, upper: 12, approach: 108 } },
        invalidation_status: null, invalidation_armed: false,
        ...extra,
    }
}

const run = (db, doc, closes, opts) => checkInvalidation(db, doc, { TEST: series(...closes) }, opts)

test('checkInvalidation: reaching the zone writes the armed latch (no status)', async () => {
    const db = makeDb()
    await run(db, idea(), [100, 11])
    assert.deepEqual(db.writes, [{ invalidation_armed: true }])
})

test('checkInvalidation: arms on the latest close in-zone even after an earlier excursion', async () => {
    const db = makeDb()
    // Approached from above, overshot to 8, recovered to 11 (in the zone now) → arm.
    await run(db, idea(), [100, 8, 11])
    assert.deepEqual(db.writes, [{ invalidation_armed: true }])
})

test('checkInvalidation: a high entry floor no longer blocks arming (daily-bar regression)', async () => {
    // Repro of the NNOX bug: entryFloorAt = Date.now() sits after a daily bar's 00:00
    // stamp, so the old floor scan discarded the in-zone bar and never armed.
    const db = makeDb()
    await run(db, idea({ entryFloorAt: 9_999_999_999_999 }), [11])
    assert.deepEqual(db.writes, [{ invalidation_armed: true }])
})

test('checkInvalidation: a latched status suppresses all further checks', async () => {
    const db = makeDb()
    await run(db, idea({ invalidation_status: 'drifting', invalidation_armed: true }), [11, 8])
    assert.equal(db.writes.length, 0)
})

test('checkInvalidation: portfolio holdings are skipped', async () => {
    const db = makeDb()
    await run(db, idea({ portfolioId: 'pf1' }), [100, 11])
    assert.equal(db.writes.length, 0)
})

test('checkInvalidation: no invalidation range → skip', async () => {
    const db = makeDb()
    await run(db, idea({ invalidation: null }), [100, 11])
    assert.equal(db.writes.length, 0)
})
