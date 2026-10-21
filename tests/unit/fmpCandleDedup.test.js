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

test('dedup: 1hour slot normalisation — snapped to the EQUITY bar, which starts at :30', async () => {
    // An equity's hourly bars run from the 09:30 open, so "10:35:00" (5 min into the 10:30–11:30
    // bar) normalises to 10:30:00. A plain epoch floor said 10:00 — half an hour early on every
    // hour-scale bar — and the canonical "09:30" row became "09:00".
    const restore = stubFetch([
        row('2026-09-03 10:35:00'),
        row('2026-09-03 09:30:00'),
    ])
    try {
        const out = await getFmpCandles('TSLA', { timeSpan: 'hour', multiplier: 1 })
        assert.equal(out.length, 2)
        assert.equal(out[0].timestamp, fmpDateToEpochSec('2026-09-03 09:30:00'), 'the open bar keeps its own stamp')
        assert.equal(out[1].timestamp, fmpDateToEpochSec('2026-09-03 10:30:00'))
    } finally { restore() }
})

test('dedup: FMP\'s native 4hour bars keep their 09:30 / 13:30 stamps', async () => {
    const restore = stubFetch([
        row('2026-10-19 13:30:00'),
        row('2026-10-19 09:30:00'),
    ])
    try {
        const out = await getFmpCandles('EXPD', { timeSpan: 'hour', multiplier: 4 })
        assert.deepEqual(out.map(c => c.timestamp), [
            fmpDateToEpochSec('2026-10-19 09:30:00'),
            fmpDateToEpochSec('2026-10-19 13:30:00'),
        ], 'not 08:00 / 12:00')
    } finally { restore() }
})

test('2hour, built from hourlies, is the session\'s own 2hr bars — never across two days', async () => {
    // Seven hourlies a day. Counted in pairs from the newest, day two's first pair would have been
    // [day-one 15:30, day-two 09:30]; bucketed, each day is 09:30, 11:30, 13:30, 15:30 (a stub).
    const day = d => ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30'].map(t => row(`${d} ${t}:00`))
    const restore = stubFetch([...day('2026-10-19'), ...day('2026-10-20')].reverse())
    try {
        const out = await getFmpCandles('EXPD', { timeSpan: 'hour', multiplier: 2 })
        const stamps = out.map(c => new Date(c.timestamp * 1000).toISOString())
        assert.deepEqual(stamps, [
            '2026-10-19T13:30:00.000Z', '2026-10-19T15:30:00.000Z', '2026-10-19T17:30:00.000Z', '2026-10-19T19:30:00.000Z',
            '2026-10-20T13:30:00.000Z', '2026-10-20T15:30:00.000Z', '2026-10-20T17:30:00.000Z', '2026-10-20T19:30:00.000Z',
        ])
    } finally { restore() }
})

test('dedup: a forex 4hour bar keeps its UTC grid — the 09:30 / ET-midnight anchor is equity only', async () => {
    // EURUSD in January (EST): ET midnight is 05:00Z. Anchored there, a 08:00Z bar would be relabelled
    // 05:00Z; the epoch floor it always had keeps it at 08:00Z.
    const restore = stubFetch([row('2026-01-15 03:00:00')])   // 03:00 ET = 08:00Z
    try {
        const out = await getFmpCandles('EURUSD', { timeSpan: 'hour', multiplier: 4 })
        assert.equal(new Date(out[0].timestamp * 1000).toISOString(), '2026-01-15T08:00:00.000Z')
    } finally { restore() }
})
