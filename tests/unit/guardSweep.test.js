import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardFires, guardsFromZones, normalizeSetup } from '../../services/setup.schema.js'
import { publish, rangeSince, _reset } from '../../services/priceFeed.service.js'

// The guard sweep's arithmetic (docs/desks/talos-guards.md).
//
// This is the tier that replaces price bands, so what is asserted here is the CLAIM the whole design
// rests on: that testing a RANGE beats testing a spot price by enough to make bands unnecessary.
// The loop itself is thin — read prices, ask these functions, mark a document due — and its I/O is
// the same one-fetch-per-symbol shape paperMark already proves. The judgment is all here.

const T = Date.parse('2026-08-21T14:00:00Z')

// ─── The range trail ──────────────────────────────────────────────────────────

test('the feed remembers a TRAIL, so a level touched and left is still evidence', () => {
    _reset()
    // Price ran to 313 and came back. A spot read at the end sees 305 and concludes nothing happened
    // — which is exactly the miss that band width was invented to paper over.
    publish('NVDA', 305, T)
    publish('NVDA', 313, T + 5_000)
    publish('NVDA', 305, T + 10_000)

    const range = rangeSince('NVDA', T - 1)
    assert.equal(range.high, 313, 'the high survives even though price left it')
    assert.equal(range.low, 305)
    assert.equal(range.count, 3)
})

test('the trail is bounded by the window asked for, not by everything ever seen', () => {
    _reset()
    publish('NVDA', 400, T)              // an old spike, outside the window below
    publish('NVDA', 305, T + 60_000)
    assert.equal(rangeSince('NVDA', T + 30_000).high, 305, 'the old spike is not evidence about this window')
    assert.equal(rangeSince('NVDA', T + 999_000), null, 'nothing seen in the window at all')
})

test('a late-arriving observation cannot roll the current mark backwards', () => {
    _reset()
    publish('NVDA', 310, T + 10_000)
    publish('NVDA', 299, T)              // arrives second, but happened first
    const range = rangeSince('NVDA', T - 1)
    assert.equal(range.low, 299, 'it still counts toward the range')
    assert.equal(range.high, 310)
})

// ─── RANGE BEATS SPOT — the thesis ────────────────────────────────────────────

test('a guard fires on a level CROSSED between two sweeps, not merely one price is sitting on', () => {
    // THE test. The zone gate asked "is price inside the band right now" and missed everything that
    // happened between two glances; a guard asks "did price reach this line since I last looked".
    const guard = { after_min: null, price: 312, direction: 'above', means: 'entry' }

    // Price spiked through 312 and came back to 305. Spot says 305 — nothing to see.
    assert.equal(guardFires(guard, { range: { high: 313, low: 305 } }), true,
        'the crossing is caught even though price ended below the level')

    // And it does not fire when price genuinely never got there.
    assert.equal(guardFires(guard, { range: { high: 311.9, low: 305 } }), false)
})

test('a gap clean over a level still counts as reaching it', () => {
    // An overnight gap from 300 to 320 never printed 312. A band would have to be 20 wide to catch
    // it; a range straddling the level catches it exactly.
    const touch = { after_min: null, price: 312, direction: 'any' }
    assert.equal(guardFires(touch, { range: { high: 320, low: 300 } }), true)
})

test('direction decides which side of the line matters', () => {
    const above = { after_min: null, price: 312, direction: 'above' }
    const below = { after_min: null, price: 312, direction: 'below' }
    const range = { high: 313, low: 311 }
    assert.equal(guardFires(above, { range }), true)
    assert.equal(guardFires(below, { range }), true, 'the range covers both sides here')

    assert.equal(guardFires(above, { range: { high: 311, low: 300 } }), false)
    assert.equal(guardFires(below, { range: { high: 330, low: 313 } }), false)
})

test('a touch needs the range to STRADDLE the level, not merely to be near it', () => {
    const touch = { after_min: null, price: 312, direction: 'any' }
    assert.equal(guardFires(touch, { range: { high: 320, low: 315 } }), false, 'entirely above')
    assert.equal(guardFires(touch, { range: { high: 305, low: 300 } }), false, 'entirely below')
    assert.equal(guardFires(touch, { range: { high: 312, low: 312 } }), true,  'exactly on it')
})

test('no price observed at all is NOT a crossing', () => {
    // A dead feed must read as "I do not know", never as "nothing happened" — the second one would
    // silently stop a setup being watched the moment quotes failed.
    const guard = { after_min: null, price: 312, direction: 'above' }
    assert.equal(guardFires(guard, { range: null }), false)
    assert.equal(guardFires(guard, { range: { high: NaN, low: NaN } }), false)
})

// ─── The conjunction ──────────────────────────────────────────────────────────

test('BOTH terms must hold — the timer alone does not buy a read', () => {
    // The saving the whole design turns on: a timer firing while price is nowhere near would buy a
    // model call whose only possible answer is "still nowhere near".
    const g = { after_min: 30, price: 305, direction: 'above', means: null }

    assert.equal(guardFires(g, { elapsedMin: 45, range: { high: 306, low: 300 } }), true, 'both')
    assert.equal(guardFires(g, { elapsedMin: 45, range: { high: 299, low: 290 } }), false, 'time yes, price no')
    assert.equal(guardFires(g, { elapsedMin: 10, range: { high: 306, low: 300 } }), false, 'price yes, time no')
})

test('an unconditional backstop fires on time alone — that is its whole job', () => {
    const backstop = { after_min: 240, price: null, direction: null, means: null }
    assert.equal(guardFires(backstop, { elapsedMin: 241, range: null }), true,
        'no price data, no crossing, and it still looks — this is what catches a stale premise')
    assert.equal(guardFires(backstop, { elapsedMin: 5, range: null }), false)
})

test('a guard carrying neither term never fires', () => {
    // clampGuards drops these, so reaching here means a hand-written or legacy document. Refusing is
    // the safe read: a guard that cannot say when it wants to be woken is not asking for anything.
    for (const g of [{}, null, { means: 'entry' }, { after_min: null, price: null }]) {
        assert.equal(guardFires(g, { elapsedMin: 9e9, range: { high: 999, low: 0 } }), false, JSON.stringify(g))
    }
})

// ─── Migration ────────────────────────────────────────────────────────────────

test('a setup that predates guards is watched by its own ZONES until its next read', () => {
    // No backfill script. A document armed before this design has zones and no guards, and treating
    // that as "nothing to watch" would silently stop monitoring a live trade.
    const legacy = normalizeSetup({
        asset: 'NVDA', direction: 'long', type: 'swing',
        scenarios: [{ id: 's1', entry_zones: [{ lower: 237.8, upper: 238.6, quantity: 100 }],
                      stop_zones: [{ lower: 234.8, upper: 235.9 }], tp_zones: [{ lower: 246, upper: 247.2 }],
                      conditions: [{ text: 'holds the shelf' }] }],
    })
    const guards = guardsFromZones(legacy)

    // Both edges, as TOUCHES: the zone gate fired on "price is inside the band", and to be inside it
    // price must have crossed an edge.
    assert.deepEqual(guards.filter(g => g.price != null).map(g => g.price), [237.8, 238.6])
    assert.ok(guards.every(g => g.price == null || g.direction === 'any'))

    // Price entering the old band from below trips it, exactly as the zone gate would have.
    assert.equal(guards.some(g => guardFires(g, { range: { high: 238.0, low: 236.0 } })), true)
    // …and a price that never came near does not.
    assert.equal(guards.some(g => guardFires(g, { elapsedMin: 0, range: { high: 220, low: 219 } })), false)
})

test('the synthesised set still carries a backstop, so migration cannot starve either', () => {
    const guards = guardsFromZones({ direction: 'long', cadence: { min: 30, max: 240 }, scenarios: [] })
    assert.deepEqual(guards, [{ after_min: 240, price: null, direction: null, means: null }])
})

test('a zero-width level yields ONE guard, not two identical ones', () => {
    const guards = guardsFromZones({
        direction: 'long', cadence: { min: 30, max: 240 },
        scenarios: [{ entry_zones: [{ lower: 312, upper: 312 }] }],
    })
    assert.equal(guards.filter(g => g.price != null).length, 1)
    assert.equal(guards[0].price, 312)
})
