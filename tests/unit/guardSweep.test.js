import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardFires } from '../../services/setup.schema.js'
import { publish, rangeSince, _reset } from '../../services/priceFeed.service.js'

// The guard sweep's arithmetic (docs/design/talos-per-candle.md).
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
    const guard = { price: 312, direction: 'above', means: 'entry' }

    // Price spiked through 312 and came back to 305. Spot says 305 — nothing to see.
    assert.equal(guardFires(guard, { high: 313, low: 305 }), true,
        'the crossing is caught even though price ended below the level')

    // And it does not fire when price genuinely never got there.
    assert.equal(guardFires(guard, { high: 311.9, low: 305 }), false)
})

test('a gap clean over a level still counts as reaching it', () => {
    // An overnight gap from 300 to 320 never printed 312. A band would have to be 20 wide to catch
    // it; a range straddling the level catches it exactly.
    const touch = { price: 312, direction: 'any' }
    assert.equal(guardFires(touch, { high: 320, low: 300 }), true)
})

test('direction decides which side of the line matters', () => {
    const above = { price: 312, direction: 'above' }
    const below = { price: 312, direction: 'below' }
    const range = { high: 313, low: 311 }
    assert.equal(guardFires(above, range), true)
    assert.equal(guardFires(below, range), true, 'the range covers both sides here')

    assert.equal(guardFires(above, { high: 311, low: 300 }), false)
    assert.equal(guardFires(below, { high: 330, low: 313 }), false)
})

test('a touch needs the range to STRADDLE the level, not merely to be near it', () => {
    const touch = { price: 312, direction: 'any' }
    assert.equal(guardFires(touch, { high: 320, low: 315 }), false, 'entirely above')
    assert.equal(guardFires(touch, { high: 305, low: 300 }), false, 'entirely below')
    assert.equal(guardFires(touch, { high: 312, low: 312 }), true,  'exactly on it')
})

test('no price observed at all is NOT a crossing', () => {
    // A dead feed must read as "I do not know", never as "nothing happened" — the second one would
    // silently stop a setup being watched the moment quotes failed.
    const guard = { price: 312, direction: 'above' }
    assert.equal(guardFires(guard, null), false)
    assert.equal(guardFires(guard, { high: NaN, low: NaN }), false)
})

// ─── No time term ─────────────────────────────────────────────────────────────

test('a guard without a price never fires — the candle close is the only timer', () => {
    // clampGuards drops these; reaching here means a hand-written or pre-design document. A guard
    // that names no price is not asking for anything the next close will not give.
    for (const g of [{}, null, { means: 'entry' }, { after_min: 240, price: null }, { after_min: 30 }]) {
        assert.equal(guardFires(g, { high: 999, low: 0 }), false, JSON.stringify(g))
    }
})
