import { test } from 'node:test'
import assert from 'node:assert/strict'

// Must be set before the dynamic import — the module captures API_KEY at load time.
process.env.FMP_API_KEY ??= 'test-key'
process.env.HTTP_RETRIES  = '0'

const { getFmpCandles, fmpDateToEpochSec } = await import('../../providers/fmp.price.provider.js')

// FMP intraday deduplication — slot-normalisation and duplicate-row handling.
//
// FMP occasionally emits two rows within the same bar period, e.g. both "10:30:00" and "10:30:30"
// for a 5-min bar, producing two chart candles at the same displayed minute. The fix: normalise
// every timestamp to its bar-boundary floor (floor(t / barSec) * barSec) and keep the first
// occurrence in the ascending-sorted list.

function stubFetch(rows) {
    const real = globalThis.fetch
    globalThis.fetch = async () => ({
        ok: true, status: 200,
        json: async () => rows,
        text: async () => JSON.stringify(rows),
    })
    return () => { globalThis.fetch = real }
}

const row = (date, o = 100, h = 101, l = 99, c = 100, v = 1000) =>
    ({ date, open: o, high: h, low: l, close: c, volume: v })

// Canonical 5-min slot start for "2026-09-03 10:30:00" ET.
// EDT = UTC-4 → 14:30:00 UTC → already a multiple of 300s.
const slot1030 = fmpDateToEpochSec('2026-09-03 10:30:00')
const slot1035 = fmpDateToEpochSec('2026-09-03 10:35:00')

test('dedup: two rows with identical date → one candle', async () => {
    const restore = stubFetch([
        row('2026-09-03 10:35:00'),
        row('2026-09-03 10:30:00'),  // first occurrence
        row('2026-09-03 10:30:00'),  // duplicate — must be dropped
    ])
    try {
        const out = await getFmpCandles('TSLA', { timeSpan: 'minute', multiplier: 5 })
        assert.equal(out.length, 2, 'both slots present, each once')
        assert.equal(out[0].timestamp, slot1030)
        assert.equal(out[1].timestamp, slot1035)
    } finally { restore() }
})

test('dedup: off-boundary row alongside canonical → canonical wins, off-boundary dropped', async () => {
    // "10:30:30" is 30 seconds into the 10:30–10:35 slot; should collapse to slot 10:30:00.
    const restore = stubFetch([
        row('2026-09-03 10:35:00'),
        row('2026-09-03 10:30:30', 110, 112, 108, 109, 2000),  // off-boundary, different prices
        row('2026-09-03 10:30:00', 100, 101,  99, 100, 1000),  // canonical — should survive
    ])
    try {
        const out = await getFmpCandles('TSLA', { timeSpan: 'minute', multiplier: 5 })
        assert.equal(out.length, 2)
        assert.equal(out[0].timestamp, slot1030)
        // The canonical row's prices must survive (first occurrence after ascending sort)
        assert.equal(out[0].open,  100)
        assert.equal(out[0].close, 100)
    } finally { restore() }
})

test('dedup: only off-boundary row → timestamp normalised to slot floor', async () => {
    // "10:30:45" has no canonical twin; it should be kept but stamped at 10:30:00.
    const restore = stubFetch([
        row('2026-09-03 10:30:45', 105, 106, 104, 105, 1500),
    ])
    try {
        const out = await getFmpCandles('TSLA', { timeSpan: 'minute', multiplier: 5 })
        assert.equal(out.length, 1)
        assert.equal(out[0].timestamp, slot1030, 'timestamp normalised to bar-boundary floor')
        assert.equal(out[0].open, 105)
    } finally { restore() }
})

test('dedup: clean non-duplicate data — no bars lost', async () => {
    const restore = stubFetch([
        row('2026-09-03 10:40:00'),
        row('2026-09-03 10:35:00'),
        row('2026-09-03 10:30:00'),
    ])
    try {
        const out = await getFmpCandles('TSLA', { timeSpan: 'minute', multiplier: 5 })
        assert.equal(out.length, 3, 'three distinct slots → three bars')
        assert.equal(out[0].timestamp, slot1030)
        assert.equal(out[1].timestamp, slot1035)
    } finally { restore() }
})

test('dedup: 15min slot normalisation — off-boundary bar snapped to slot floor', async () => {
    // "10:31:00" (1 min into the 10:30–10:45 slot) should normalise to 10:30:00.
    const restore = stubFetch([
        row('2026-09-03 10:31:00'),
    ])
    try {
        const out = await getFmpCandles('TSLA', { timeSpan: 'minute', multiplier: 15 })
        assert.equal(out.length, 1)
        assert.equal(out[0].timestamp, fmpDateToEpochSec('2026-09-03 10:30:00'))
    } finally { restore() }
})

test('dedup: 1hour slot normalisation — off-boundary bar snapped to slot floor', async () => {
    // "10:05:00" (5 min into the 10:00–11:00 slot) should normalise to 10:00:00.
    const restore = stubFetch([
        row('2026-09-03 10:05:00'),
    ])
    try {
        const out = await getFmpCandles('TSLA', { timeSpan: 'hour', multiplier: 1 })
        assert.equal(out.length, 1)
        assert.equal(out[0].timestamp, fmpDateToEpochSec('2026-09-03 10:00:00'))
    } finally { restore() }
})
