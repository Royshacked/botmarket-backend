import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAggregateRows } from '../../providers/massive.provider.js'

// Massive is asked for `sort: desc` (so a truncating `limit` would keep the most RECENT bars), but
// the candle contract the whole app reads by is OLDEST FIRST — same as FMP and Yahoo. Serving the
// raw desc response drew the chart backwards (right edge = oldest bar, live tick painted on it) and
// fed every `.slice(-n)` / `.at(-1)` / indicator walk a time-reversed window.

const row = (t, c) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 100 })
const SEC = 1000

test('a newest-first response comes back oldest-first', () => {
    const out = normalizeAggregateRows([row(3_000, 30), row(2_000, 20), row(1_000, 10)])
    assert.deepEqual(out.map(x => x.timestamp), [1, 2, 3])
    assert.equal(out.at(-1).close, 30, 'the LAST bar must be the newest')
})

test('an already-ascending response is left in order', () => {
    const out = normalizeAggregateRows([row(1_000, 10), row(2_000, 20), row(3_000, 30)])
    assert.deepEqual(out.map(x => x.timestamp), [1, 2, 3])
})

test('slice(-n) yields the LATEST n bars', () => {
    const rows = [5, 4, 3, 2, 1].map(n => row(n * SEC, n * 10))   // desc, as Massive serves it
    const latest2 = normalizeAggregateRows(rows).slice(-2)
    assert.deepEqual(latest2.map(x => x.close), [40, 50])
})

test('maps ms → epoch seconds and carries OHLCV through', () => {
    const [out] = normalizeAggregateRows([{ t: 1_700_000_000_500, o: 1, h: 2, l: 0.5, c: 1.5, v: 42 }])
    assert.deepEqual(out, { timestamp: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 })
})

test('drops bars without a finite timestamp, keeps the rest sorted', () => {
    const out = normalizeAggregateRows([row(3_000, 30), { o: 1, h: 2, l: 0, c: 1 }, { t: null }, row(1_000, 10)])
    assert.deepEqual(out.map(x => x.timestamp), [1, 3])
})

test('a missing / non-array payload yields [] rather than throwing', () => {
    for (const bad of [undefined, null, {}, 'nope']) {
        assert.deepEqual(normalizeAggregateRows(bad), [], String(bad))
    }
})
