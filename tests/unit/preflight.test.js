import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate } from '../../monitoring/evaluators/structured.evaluator.js'

// The arm-time pre-flight prompts when the entry LEVEL is already held on the last
// closed candle (state=true) but the monitor's rising-edge path would NOT fire it
// (edge=false). These tests pin that premise on the pure evaluator — the exact
// TSLA "closes above 426.28" case where price was already above with no fresh cross.

const V = 426.28

// closes → candles {o,h,l,c,v,t}, newest-last, 15-min spacing (ms timestamps).
function candles(closes, startMs = 1_700_000_000_000) {
    return closes.map((c, i) => ({ o: c, h: c, l: c, c, v: 1000, t: startMs + i * 900_000 }))
}
const at = (cs, i) => cs[i].t

const crossAbove = { operator: 'crossAbove', subject: 'close', value: V, value2: null, confirmation: 0 }
const gt         = { operator: 'gt',         subject: 'close', value: V, value2: null, confirmation: 0 }

test('preflight premise: crossAbove already above since before the floor → state true, edge false', () => {
    // Price breached V before the floor and held; no fresh cross at/after the floor.
    const cs = candles([426.40, 426.50, 426.60, 426.51])
    const floorAt = at(cs, 2)

    const edge  = evaluate(crossAbove, cs, floorAt)                       // monitor path
    const state = evaluate(crossAbove, cs, null, null, { stateLevel: true })

    assert.equal(edge.pass,  false, 'monitor would NOT fire (no fresh cross)')
    assert.equal(state.pass, true,  'level is held right now')
    assert.equal(state.pass && !edge.pass, true, 'alreadySatisfied → prompt user')
})

test('preflight premise: gt already above since before the floor → state true, edge false', () => {
    const cs = candles([426.40, 426.50, 426.60, 426.51])
    const floorAt = at(cs, 2)

    const edge  = evaluate(gt, cs, floorAt)
    const state = evaluate(gt, cs, null, null, { stateLevel: true })

    assert.equal(edge.pass,  false)
    assert.equal(state.pass, true)
})

test('preflight premise: genuine cross at/after the floor → edge fires, so NO prompt', () => {
    // Dips below V then closes back above at index 2 (at/after floor) — a real breakout.
    const cs = candles([426.40, 426.10, 426.51, 426.55])
    const floorAt = at(cs, 1)

    const edge  = evaluate(crossAbove, cs, floorAt)
    const state = evaluate(crossAbove, cs, null, null, { stateLevel: true })

    assert.equal(edge.pass, true, 'monitor fires on the fresh cross')
    assert.equal(state.pass && !edge.pass, false, 'not alreadySatisfied — monitor handles it')
})

test('stateLevel is required: plain snapshot of crossAbove misses an already-held level', () => {
    // Without stateLevel, the snapshot still demands a cross on the last two bars,
    // so a continuously-above series reads false — which is why the flag exists.
    const cs = candles([426.40, 426.50, 426.60, 426.51])

    const plain      = evaluate(crossAbove, cs, null)                        // legacy snapshot
    const levelState = evaluate(crossAbove, cs, null, null, { stateLevel: true })

    assert.equal(plain.pass,      false, 'plain snapshot: no cross on last two bars')
    assert.equal(levelState.pass, true,  'stateLevel: level is held')
})

test('stateLevel does not change threshold operators (gt stays gt)', () => {
    const below = candles([426.00, 426.10, 426.20])   // never above V
    assert.equal(evaluate(gt, below, null, null, { stateLevel: true }).pass, false)

    const above = candles([426.30, 426.40, 426.50])
    assert.equal(evaluate(gt, above, null, null, { stateLevel: true }).pass, true)
})

// ── requireHeld: a reverted breakout must not stay latched true (AND staleness) ──
// The "break above 1150 AND cumulative volume" case: the breakout fired yesterday but
// price is back below 1150 today, so the structured leg must read false.
const L = 1150
const brk = { operator: 'crossAbove', subject: 'close', value: L, value2: null, confirmation: 0 }
const gtL = { operator: 'gt',         subject: 'close', value: L, value2: null, confirmation: 0 }

test('requireHeld: edge fired since floor but level reverted → leg is FALSE', () => {
    const cs = candles([1140, 1160, 1170, 1145])   // cross up at idx 1, back below by the last bar
    const floorAt = at(cs, 0)

    assert.equal(evaluate(brk, cs, floorAt).pass,                    true,  'legacy: stale edge still true')
    assert.equal(evaluate(brk, cs, floorAt, null, { requireHeld: true }).pass, false, 'requireHeld: level not held now')
    assert.equal(evaluate(gtL, cs, floorAt, null, { requireHeld: true }).pass, false, 'same for gt')
})

test('requireHeld: edge fired and level still held → leg is TRUE, keeps triggerAt', () => {
    const cs = candles([1140, 1160, 1170, 1165])   // crossed up and still above
    const floorAt = at(cs, 0)

    const res = evaluate(brk, cs, floorAt, null, { requireHeld: true })
    assert.equal(res.pass, true)
    assert.equal(res.triggerAt, at(cs, 1), 'triggerAt is the breakout candle, not now')
})

test('requireHeld: no edge at all → still false (unchanged)', () => {
    const cs = candles([1140, 1141, 1142])   // never crosses V
    assert.equal(evaluate(brk, cs, at(cs, 0), null, { requireHeld: true }).pass, false)
})
