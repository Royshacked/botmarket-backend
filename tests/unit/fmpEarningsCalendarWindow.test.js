// The earnings calendar's row cap, and the hole it used to leave.
//
// FMP answers at most 4000 rows per calendar request AND TRIMS FROM THE END OF THE WINDOW. Measured
// against the live key: `from=2026-09-27&to=2026-12-20` returns exactly 4000 rows whose earliest date
// is 2026-11-05 — the next six weeks absent, with nothing in the response saying so. Every caller
// reads that as "nothing reports before November": a confident negative from a source that did not
// answer, which is the failure shape this codebase refuses everywhere else.
//
// readCalendarWindow pays for one request whenever one is enough (the shared 30-day window is well
// inside the cap and costs exactly what it did before) and splits only a window that comes back AT
// the ceiling.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTtlCache } from '../../services/ttlCache.util.js'
import { readCalendarWindow, splitCalendarWindow } from '../../providers/fmp.provider.js'

const io = (get) => ({ get, cache: createTtlCache({ ttlMs: 60_000, max: 50 }) })

/** `n` rows all dated `date`, shaped like the provider's. */
const rows = (n, date) => Array.from({ length: n }, (_, i) => ({ symbol: `T${i}`, date }))

// ── splitCalendarWindow — pure ────────────────────────────────────────────────

test('a window halves into two DISJOINT spans', () => {
    // Inclusive at BOTH ends, so [from, mid] + [mid, to] would return the middle day twice and
    // double every name reporting on it.
    assert.deepEqual(splitCalendarWindow('2026-09-27', '2026-10-05'),
        [['2026-09-27', '2026-10-01'], ['2026-10-02', '2026-10-05']])
})

test('an odd span still covers every day exactly once', () => {
    const [[a1, a2], [b1, b2]] = splitCalendarWindow('2026-01-01', '2026-01-04')
    assert.equal(a1, '2026-01-01')
    assert.equal(b2, '2026-01-04')
    // the day after the first half's end is the second half's start — no gap, no overlap
    assert.equal(new Date(Date.parse(`${a2}T00:00:00Z`) + 864e5).toISOString().slice(0, 10), b1)
})

test('a single day cannot be split, and says so rather than looping', () => {
    assert.equal(splitCalendarWindow('2026-09-27', '2026-09-27'), null)
    assert.equal(splitCalendarWindow('2026-09-27', '2026-09-26'), null, 'a reversed window is not splittable either')
})

// ── readCalendarWindow ───────────────────────────────────────────────────────

test('a window under the cap is ONE request — the common path costs what it always did', async () => {
    const calls = []
    const out = await readCalendarWindow('2026-09-27', '2026-10-27', io(async (f, t) => {
        calls.push(`${f}|${t}`); return rows(1750, '2026-10-01')
    }))
    assert.deepEqual(calls, ['2026-09-27|2026-10-27'])
    assert.equal(out.length, 1750)
})

test('a window AT the cap is split, and the halves are asked for separately', async () => {
    const calls = []
    const out = await readCalendarWindow('2026-09-27', '2026-12-20', io(async (f, t) => {
        calls.push(`${f}|${t}`)
        // Only the whole window is over; each half fits.
        return f === '2026-09-27' && t === '2026-12-20' ? rows(4000, '2026-11-05') : rows(2000, f)
    }))
    assert.equal(calls.length, 3, 'the truncated ask, then its two halves')
    assert.equal(calls[0], '2026-09-27|2026-12-20')
    assert.equal(out.length, 4000, 'both halves, merged')
    // THE POINT: the near end is present. Truncation dropped exactly this.
    assert.ok(out.some(r => r.date === '2026-09-27'), 'the nearest weeks came back')
})

// The boundaries are DERIVED, not written down: a test that hardcodes the midpoint is testing my
// date arithmetic rather than the splitting, and it drifts the moment the split changes.
const FULL  = ['2026-09-27', '2026-12-20']
const HALF1 = splitCalendarWindow(...FULL)[0]            // 2026-09-27 → 2026-11-08
const QTR1  = splitCalendarWindow(...HALF1)[0]           // …and its own first half
const span  = ([f, t]) => `${f}|${t}`

test('splitting RECURSES — a half can be over the cap too, in earnings season', async () => {
    const calls = []
    await readCalendarWindow(...FULL, io(async (f, t) => {
        calls.push(`${f}|${t}`)
        // The whole window and its first half are both at the ceiling; everything narrower fits.
        const wide = [span(FULL), span(HALF1)].includes(`${f}|${t}`)
        return wide ? rows(4000, t) : rows(500, f)
    }))
    assert.ok(calls.length >= 4, `expected a second level of splitting, got ${calls.length} requests`)
    assert.ok(calls.includes(span(FULL)))
    assert.ok(calls.includes(span(HALF1)), 'the first half was asked for…')
    assert.ok(calls.includes(span(QTR1)), '…and then split again')
})

// The one case this cannot fix. It must not recurse forever, and it must not pass a knowingly
// incomplete day off as a whole one — the busiest day measured carries ~360 rows, so 4000 in a single
// day means the cap moved or the endpoint changed.
test('a SINGLE DAY at the cap is returned as-is rather than split forever', async () => {
    let n = 0
    const out = await readCalendarWindow('2026-10-29', '2026-10-29', io(async () => { n++; return rows(4000, '2026-10-29') }))
    assert.equal(n, 1)
    assert.equal(out.length, 4000)
})

test('the cache answers the second ask, and each split half caches under its own window', async () => {
    let n = 0
    const shared = io(async (f, t) => {
        n++
        return `${f}|${t}` === span(FULL) ? rows(4000, '2026-11-05') : rows(10, f)
    })
    await readCalendarWindow(...FULL, shared)
    const after = n
    await readCalendarWindow(...FULL, shared)
    assert.equal(n, after, 'the repeat ask spent nothing')

    // …and a later caller asking for just one of the halves is served from the cache too.
    await readCalendarWindow(...HALF1, shared)
    assert.equal(n, after, 'the half was cached under its own key')
})

test('a non-array answer is no rows rather than a throw', async () => {
    assert.deepEqual(await readCalendarWindow('2026-09-27', '2026-10-27', io(async () => null)), [])
    assert.deepEqual(await readCalendarWindow('2026-09-27', '2026-10-27', io(async () => ({ error: 'nope' }))), [])
})
