// The one worker pool — services/concurrency.util.js.
//
// What is worth pinning is the three properties its callers actually lean on: the cap is never
// exceeded, the results come back in INPUT order however the work finishes, and a rejection is the
// caller's problem rather than something swallowed here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapLimit } from '../../services/concurrency.util.js'

/** A task that resolves after `ms`, recording the high-water mark of how many ran at once. */
function tracker() {
    const t = { active: 0, peak: 0, order: [] }
    t.run = (value, ms) => new Promise(resolve => {
        t.active++
        t.peak = Math.max(t.peak, t.active)
        setTimeout(() => { t.active--; t.order.push(value); resolve(value) }, ms)
    })
    return t
}

test('never runs more than the cap at once', async () => {
    const t = tracker()
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], v => t.run(v, 5), { concurrency: 3 })
    assert.equal(t.peak, 3)
    assert.deepEqual(out, [1, 2, 3, 4, 5, 6, 7, 8])
})

test('results are in INPUT order even when the work finishes backwards', async () => {
    const t = tracker()
    // Descending durations inside one wave: the last item finishes first.
    const out = await mapLimit(['a', 'b', 'c'], (v, i) => t.run(v, 30 - i * 10), { concurrency: 3 })
    assert.deepEqual(t.order, ['c', 'b', 'a'], 'the work really did finish backwards')
    assert.deepEqual(out, ['a', 'b', 'c'])
})

test('the index is passed through, so a caller can pair a result with its slot', async () => {
    const out = await mapLimit(['x', 'y'], async (v, i) => `${i}:${v}`, { concurrency: 1 })
    assert.deepEqual(out, ['0:x', '1:y'])
})

// A SHARED CURSOR, not a slice each: one slow item must not leave the other workers idle while the
// list still has work on it.
test('a slow item does not park the workers behind it', async () => {
    const t = tracker()
    const out = await mapLimit([100, 1, 1, 1], v => t.run(v, v), { concurrency: 2 })
    assert.deepEqual(t.order, [1, 1, 1, 100], 'the fast tail finished while the slow head ran')
    assert.deepEqual(out, [100, 1, 1, 1])
})

test('a rejection reaches the caller — there is no swallow mode', async () => {
    await assert.rejects(
        () => mapLimit([1, 2, 3], async v => { if (v === 2) throw new Error('boom'); return v }, { concurrency: 2 }),
        /boom/,
    )
})

test('an empty or non-array input is no work and no error', async () => {
    assert.deepEqual(await mapLimit([], async v => v), [])
    assert.deepEqual(await mapLimit(null, async v => v), [])
    assert.deepEqual(await mapLimit(undefined, async v => v), [])
})

// The cap is a ceiling on workers, not a promise to start that many: a two-item list never opens
// five slots, and a nonsense cap still runs the work one at a time rather than not at all.
test('the cap is clamped to something that runs', async () => {
    const t = tracker()
    await mapLimit([1, 2], v => t.run(v, 5), { concurrency: 9 })
    assert.equal(t.peak, 2)

    for (const bad of [0, -3, NaN, undefined]) {
        const u = tracker()
        const out = await mapLimit([1, 2, 3], v => u.run(v, 1), { concurrency: bad })
        assert.deepEqual(out, [1, 2, 3], `cap ${bad} still ran every item`)
        assert.ok(u.peak >= 1)
    }
})
