// What a Talos read is told a LEG IS — a price, never the storage shape.
//   node --test tests/unit/talosLevels.test.js
//
// The pre-entry block and the cheap tier's PLAN LEVELS used to `JSON.stringify` the stored legs, so
// both tiers opened on `{"lower":238.2,"upper":238.2}` for a level the user wrote as 238.2 — a band
// shape taught on every wake by the desk that stopped drawing bands. The keys are gone from the
// document entirely now (2026-09-24), and these tests stay as the guard that no prompt grows a
// JSON dump of a leg again: asserting the ABSENCE of the shape, not only the presence of the line,
// because a renderer added beside an old dump passes every positive assertion.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legText, legsText } from '../../monitoring/assess.shared.js'
import { _scenarioBlock, _armedLevelLine } from '../../monitoring/talos.assess.js'
import { buildCheapUserText } from '../../monitoring/talos.cheap.js'
import { normalizeSetup } from '../../services/setup.schema.js'

const PLAN = {
    asset: 'NVDA', asset_class: 'stock', direction: 'long', type: 'swing',
    trade_mode: 'discretionary', timeframe: '1hr', market_cap: 'large',
    scenarios: [{
        id: 's1',
        name: 'false break of the shelf',
        entry_legs: [{ id: 'ez1', price: 238.2, quantity: 100, note: 'the shelf' }],
        stop_legs:  [{ id: 'sz1', price: 234.8 }],
        target_legs:    [{ id: 'tz1', price: 246.5, quantity: 50 },
                      { id: 'tz2', price: 252, quantity: 50,
                        conditions: [{ text: 'only while it is still making higher lows' }] }],
        conditions: [{ id: 's1c1', text: '15min close above VWAP', weight: 'primary', mode: 'measured', persistence: 'live' }],
    }],
}
const SETUP    = { id: 'setup_NVDA_1', userId: 'u1', ...normalizeSetup(PLAN) }
const SCENARIO = SETUP.scenarios[0]

/** A leg dumped as JSON rather than rendered — the shape these tests exist to keep out. */
const STORAGE = /"?(lower|upper|price|quantity)"?\s*:/

// ─── legText / legsText ───────────────────────────────────────────────────────

test('a leg is its id, its price and its size — and no JSON', () => {
    const line = legText(SCENARIO.entry_legs[0])
    assert.equal(line, '[ez1] at 238.2 (size 100) — the shelf')
    assert.doesNotMatch(line, STORAGE)
})

test('a leg carrying a rule is MARKED, and its sentence is not inlined', () => {
    // Pre-entry judges the entry conditions and nothing else; an exit's words belong to the
    // in-position read. The marker says a rule exists without inviting this read to grade it.
    const line = legText(SCENARIO.target_legs[1])
    assert.match(line, /· conditional/)
    assert.doesNotMatch(line, /higher lows/, 'the condition text stays with the read that owns it')
})

test('the BAND shape renders as NOTHING — there is no edge left to pick', () => {
    // This used to assert that a prompt read a band at the same edge `protectionPlan` rested it at,
    // because naming one price while the broker held another is a lie the journal cannot catch. The
    // rule it defended went with the shape: a document carrying edges has no legs at all now, and
    // rendering one would invent a price nothing else in the system agrees with.
    assert.equal(legText({ id: 'sz9', lower: 305.2, upper: 306.4 }), null)
    assert.equal(legText({ id: 'sz9', lower: 305.2, upper: 305.2 }), null)
})

test('a leg with no finite price renders as nothing rather than as "at null"', () => {
    assert.equal(legText({ id: 'x' }), null)
    assert.equal(legText(null), null)
    assert.equal(legsText([{ id: 'x' }, null], 'ENTRY'), '')
    assert.equal(legsText(null, 'ENTRY'), '')
})

test('a size of zero or nothing is simply absent, never "(size 0)"', () => {
    assert.equal(legText({ id: 'z', price: 10, quantity: 0 }), '[z] at 10')
    assert.equal(legText({ id: 'z', price: 10 }), '[z] at 10')
})

// ─── the pre-entry block ──────────────────────────────────────────────────────

test('SCENARIO ON THE TABLE is priced lines, in the WATCHED LEGS sentence', () => {
    const block = _scenarioBlock(SETUP, SCENARIO)
    assert.match(block, /SCENARIO ON THE TABLE — "false break of the shelf":/)
    assert.match(block, /- ENTRY \[ez1\] at 238\.2 \(size 100\) — the shelf/)
    assert.match(block, /- STOP \[sz1\] at 234\.8/)
    assert.match(block, /- TARGET \[tz1\] at 246\.5 \(size 50\)/)
    assert.doesNotMatch(block, STORAGE, 'a leg is rendered, never dumped')
    assert.doesNotMatch(block, /entry_legs|target_legs|stop_legs/, 'nor are the field names')
})

test('the premise carries its size and r:r, which are read with the legs', () => {
    assert.match(_scenarioBlock(SETUP, { ...SCENARIO, rr: 2.1 }), /THIS PREMISE: size 100 · r:r 2\.1/)
})

test('a scenario with nothing priced says so instead of emitting an empty block', () => {
    assert.match(_scenarioBlock(SETUP, { id: 's9' }), /\(no priced legs\)/)
})

// ─── ARMED LEVEL ──────────────────────────────────────────────────────────────

test('ARMED LEVEL says WHERE PRICE IS and nothing about what may be answered', () => {
    // The line used to end `"enter" is not available` — the zone gate still talking after the code
    // stopped vetoing (docs/desks/mentor-talos.md §Entry). It contradicted the prompt's own
    // paragraph two hundred words up, and it spoke at exactly the moment the removal existed for:
    // price reached the level, the conditions confirm two candles later, the satisfied entry guard
    // is already dropped, and nothing is standing on a level any more.
    const none = _armedLevelLine(SETUP, null)
    assert.match(none, /ARMED LEVEL: \(none/)
    assert.doesNotMatch(none, /not available/)
    assert.doesNotMatch(none, /enter/i, 'the data line never rules a verdict in or out')
})

test('an armed level reads as a price, like every other leg', () => {
    const line = _armedLevelLine(SETUP, SCENARIO.entry_legs[0])
    assert.match(line, /ARMED LEVEL \(price is standing on it\): \[ez1\] at 238\.2/)
    assert.doesNotMatch(line, STORAGE)
})

// ─── the cheap tier ───────────────────────────────────────────────────────────

test('the cheap tier reads the same vocabulary as the tier it escalates to', () => {
    const txt = buildCheapUserText(SETUP, {
        scenario: SCENARIO, conditions: SCENARIO.conditions,
        rung: '15min', candles: 'rows', indicators: 'vwap: 238', price: 238,
    })
    assert.match(txt, /PLAN LEVELS:\n- ENTRY \[ez1\] at 238\.2/)
    assert.match(txt, /- STOP \[sz1\] at 234\.8/)
    assert.doesNotMatch(txt, STORAGE, 'a numbers-only read is the last place a band shape belongs')
})
