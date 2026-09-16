import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateTree, evaluateConditions, isTimeBlocked, leafStateKey } from '../../monitoring/monitor.orchestrator.js'

// The evaluator EVERY monitor runs — the tree walk behind entry, exit, Talos and preflightEntry —
// had no unit test until §10; only a live harness (tests/test.tree.js) that needs the model and a
// data key exercised it. This is offline: it drives the walk through TOUCH and TIME leaves, which
// are pure candle-math / wall-clock, plus STRUCTURED leaves worded 'price touches N', which the
// condition parser resolves deterministically (parseTouchLiteral — no model). It pins the four
// things the tree walk decides: pass/fail, AND/OR with short-circuit, cheapest-first ordering, and
// the `out` state map that the UI reads.

// One candle per level so a touch leaf's range contains exactly the levels we mean it to. Real
// millisecond timestamps: candleMs leaves anything ≥ 1e12 untouched, and multiplies smaller values
// as if they were seconds — a genuine trap this test would otherwise walk straight into.
const T1 = 1_700_000_000_000, T2 = 1_700_000_060_000
const bar = (t, lo, hi) => ({ o: lo, h: hi, l: lo, c: hi, v: 1000, t })
// A series whose combined range is [90, 110]; a touch leaf passes iff its level falls in a bar.
const candles = [bar(T1, 90, 100), bar(T2, 100, 110)]
const MAP = { X: candles }

const touch = (level) => ({ type: 'touch', condition: `price touches ${level}` })
// A time leaf carries a condition string like every leaf — that is how the tree walk detects a
// leaf at all (typeof node.condition === 'string'); evaluateTime reads after/before off the node.
const time  = (over) => ({ type: 'time', condition: 'time window', ...over })

test('a single touch leaf: inside the range passes, outside fails', async () => {
    assert.equal((await evaluateTree(touch(95),  MAP, 'X')).triggered, true)
    assert.equal((await evaluateTree(touch(105), MAP, 'X')).triggered, true)
    assert.equal((await evaluateTree(touch(200), MAP, 'X')).triggered, false)
})

test('AND is all-or-nothing', async () => {
    const both = { operator: 'AND', children: [touch(95), touch(105)] }
    const one  = { operator: 'AND', children: [touch(95), touch(200)] }
    assert.equal((await evaluateTree(both, MAP, 'X')).triggered, true)
    assert.equal((await evaluateTree(one,  MAP, 'X')).triggered, false)
})

test('OR triggers on the first child that does, and reports which', async () => {
    const or = { operator: 'OR', children: [touch(200), touch(105)] }
    const r = await evaluateTree(or, MAP, 'X')
    assert.equal(r.triggered, true)
    assert.match(r.which, /105/)
    assert.equal((await evaluateTree({ operator: 'OR', children: [touch(200), touch(300)] }, MAP, 'X')).triggered, false)
})

test('nested groups compose', async () => {
    // (touch 95 AND touch 105) OR touch 999  → the AND is true, so the OR is
    const tree = { operator: 'OR', children: [
        { operator: 'AND', children: [touch(95), touch(105)] },
        touch(999),
    ] }
    assert.equal((await evaluateTree(tree, MAP, 'X')).triggered, true)
})

test('a malformed node is false, not a throw', async () => {
    assert.equal((await evaluateTree(null, MAP, 'X')).triggered, false)
    assert.equal((await evaluateTree({ operator: 'AND', children: [] }, MAP, 'X')).triggered, false)
    assert.equal((await evaluateTree({ type: 'touch', condition: '' }, MAP, 'X')).triggered, false)
})

test('the out map records EVERY leaf reached, and only those — an AND that fails early never reaches its rivals', async () => {
    // time sorts cheapest (COST -1) and is placed first; a failing time leaf fails the AND at child 1,
    // so the touch is never evaluated — proof of both short-circuit and cheapest-first ordering.
    const past = time({ before: '2000-01-01T00:00:00Z' })   // window closed → false
    const out = []
    const r = await evaluateTree({ operator: 'AND', children: [touch(95), past] }, MAP, 'X', null, [], out)
    assert.equal(r.triggered, false)
    assert.equal(out.length, 1, 'only the time leaf was reached')
    assert.equal(out[0].pass, false)
    assert.match(out[0].key, /^time\|/)
})

test('the out map keys and pass-flags round-trip through leafStateKey', async () => {
    const out = []
    await evaluateTree({ operator: 'OR', children: [touch(95), touch(105)] }, MAP, 'X', null, [], out)
    // OR short-circuits on the first pass, so only touch(95) is reached.
    assert.equal(out.length, 1)
    assert.equal(out[0].key, leafStateKey(touch(95)))
    assert.equal(out[0].pass, true)
    assert.ok(out[0].at >= T1)
})

test('floorAt gates a touch: a level touched only before the floor does not count', async () => {
    // 95 is in the first bar (t=1000) only. A floor after it means the touch is in the past.
    assert.equal((await evaluateTree(touch(95), MAP, 'X', T1 + 1)).triggered, false)
    assert.equal((await evaluateTree(touch(105), MAP, 'X', T2)).triggered, true, '105 is in the second bar, at the floor')
})

test('AND triggerAt is the LATEST child trigger — the moment the whole gate became true', async () => {
    // touch 95 fires at t=1000, touch 105 at t=2000; the AND becomes true at 2000.
    const r = await evaluateTree({ operator: 'AND', children: [touch(95), touch(105)] }, MAP, 'X')
    assert.equal(r.triggerAt, T2)
})

test('a cross-asset leaf with no candles is false, never a throw', async () => {
    const leaf = { type: 'touch', condition: 'price touches 50', symbol: 'MISSING' }
    assert.equal((await evaluateTree(leaf, MAP, 'X')).triggered, false)
})

test('evaluateConditions: the legacy flat array rides the same walk', async () => {
    assert.equal((await evaluateConditions([touch(95), touch(105)], 'AND', MAP, 'X')).triggered, true)
    assert.equal((await evaluateConditions([touch(95), touch(200)], 'AND', MAP, 'X')).triggered, false)
    assert.equal((await evaluateConditions([], 'AND', MAP, 'X')).triggered, false)
})

// ── isTimeBlocked: can the clock alone stop this tick? ────────────────────────

test('isTimeBlocked: a tree with no time leaf is never blocked', () => {
    assert.equal(isTimeBlocked(touch(95)), false)
    assert.equal(isTimeBlocked({ operator: 'AND', children: [touch(95), touch(105)] }), false)
})

test('isTimeBlocked: a closed AND time window blocks; an open one does not', () => {
    const closed = { operator: 'AND', children: [touch(95), time({ before: '2000-01-01T00:00:00Z' })] }
    const open   = { operator: 'AND', children: [touch(95), time({ after:  '2000-01-01T00:00:00Z' })] }
    assert.equal(isTimeBlocked(closed), true, 'the price leaf is optimistically true, so only the clock can block')
    assert.equal(isTimeBlocked(open), false)
})

test('isTimeBlocked: an OR with one open branch is not blocked', () => {
    const tree = { operator: 'OR', children: [
        time({ before: '2000-01-01T00:00:00Z' }),   // closed
        touch(95),                                   // always optimistically reachable
    ] }
    assert.equal(isTimeBlocked(tree), false)
})

test('leafStateKey is type|timeframe|condition — enough to tell sibling leaves apart', () => {
    assert.equal(leafStateKey({ type: 'touch', timeframe: '1h', condition: 'price touches 5' }), 'touch|1h|price touches 5')
    assert.equal(leafStateKey({ condition: 'x' }), 'structured||x')
    assert.equal(leafStateKey(null), 'structured||')
})
