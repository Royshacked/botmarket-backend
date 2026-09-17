import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextCandleCloseMs } from '../../services/market.service.js'

// nextCandleCloseMs is what paces Talos (docs/design/talos-per-candle.md): the next read is the
// next candle close on the rung it is watching. Every instant here is fixed and passed in.
// Reference week (EDT, ET = UTC-4): 2026-07-15 Wed · 2026-07-17 Fri · 2026-07-18 Sat · 2026-07-20 Mon.
const ms  = (iso) => Date.parse(iso)
const iso = (t) => new Date(t).toISOString()
const at  = (sym, rung, from, cls = null) => iso(nextCandleCloseMs(sym, cls, rung, ms(from)))

// ─── Intraday: clock-aligned, strictly after now ──────────────────────────────

test('an intraday rung closes on the next clock boundary, strictly after now', () => {
    assert.equal(at('AAPL', '5min',  '2026-07-15T18:03:00Z'), '2026-07-15T18:05:00.000Z')
    assert.equal(at('AAPL', '5min',  '2026-07-15T18:05:00Z'), '2026-07-15T18:10:00.000Z', 'exactly on a boundary → the NEXT one')
    assert.equal(at('AAPL', '15min', '2026-07-15T18:03:00Z'), '2026-07-15T18:15:00.000Z')
    assert.equal(at('AAPL', '1hr',   '2026-07-15T18:03:00Z'), '2026-07-15T19:00:00.000Z')
})

test('multi-hour rungs align to ET midnight for session-bound instruments and UTC for crypto', () => {
    // 14:03 ET: ET-aligned 4hr bars close 12:00 / 16:00 / 20:00 ET → 16:00 ET = 20:00Z
    assert.equal(at('AAPL',   '4hr', '2026-07-15T18:03:00Z'), '2026-07-15T20:00:00.000Z')
    // 18:03Z: UTC-aligned 4hr bars close 16:00Z / 20:00Z → 20:00Z
    assert.equal(at('BTCUSD', '4hr', '2026-07-15T18:03:00Z'), '2026-07-15T20:00:00.000Z')
    // 21:03Z (17:03 ET): ET gives 20:00 ET = 00:00Z next day; UTC gives 00:00Z. NQ is on its break
    // at 17:03 ET, so it starts from the 18:00 ET reopen and closes the 20:00 ET bar.
    assert.equal(at('NQ',     '4hr', '2026-07-15T21:03:00Z'), '2026-07-16T00:00:00.000Z')
    assert.equal(at('BTCUSD', '2hr', '2026-07-15T21:03:00Z'), '2026-07-15T22:00:00.000Z')
})

test('a bar cut short by the session closes WITH the session', () => {
    // AAPL at 15:30 ET on a 1hr rung: clock boundary 16:00 is also the close. At 14:30 ET on a 4hr
    // rung the boundary is 16:00 ET — the close. At 15:59 ET on a 5min rung → 16:00.
    assert.equal(at('AAPL', '4hr',  '2026-07-15T18:30:00Z'), '2026-07-15T20:00:00.000Z')
    assert.equal(at('AAPL', '5min', '2026-07-15T19:59:00Z'), '2026-07-15T20:00:00.000Z')
    // NQ at 16:30 ET on a 4hr rung: the clock boundary is 20:00 ET but the daily break starts at
    // 17:00 ET, so the bar closes there.
    assert.equal(at('NQ', '4hr', '2026-07-15T20:30:00Z'), '2026-07-15T21:00:00.000Z')
    // Forex has no daily break Mon–Thu: a 4hr bar spanning 17:00 ET runs to its clock boundary.
    assert.equal(at('EURUSD', '4hr', '2026-07-15T20:30:00Z'), '2026-07-16T00:00:00.000Z')
})

test('a shut market closes the FIRST bar of the next session', () => {
    // 03:00 ET Wed: AAPL opens 09:30 → first 5min bar closes 09:35 ET = 13:35Z
    assert.equal(at('AAPL', '5min', '2026-07-15T07:00:00Z'), '2026-07-15T13:35:00.000Z')
    // 16:30 ET Wed (after the close) → Thu 09:35 ET
    assert.equal(at('AAPL', '5min', '2026-07-15T20:30:00Z'), '2026-07-16T13:35:00.000Z')
    // Saturday → Monday 09:35 ET
    assert.equal(at('AAPL', '5min', '2026-07-18T16:00:00Z'), '2026-07-20T13:35:00.000Z')
    // A 1hr rung at the open: the 09:00–10:00 ET clock bar closes at 10:00 ET
    assert.equal(at('AAPL', '1hr',  '2026-07-15T07:00:00Z'), '2026-07-15T14:00:00.000Z')
    // Forex on Saturday → Sunday 17:00 ET open → first 15min bar closes 17:15 ET = 21:15Z
    assert.equal(at('EURUSD', '15min', '2026-07-18T16:00:00Z'), '2026-07-19T21:15:00.000Z')
})

test('crypto never waits for an open', () => {
    assert.equal(at('BTCUSD', '5min', '2026-07-18T16:03:00Z'), '2026-07-18T16:05:00.000Z')
})

// ─── Day / week / month: the session's daily close ────────────────────────────

test('a daily bar closes at the session close, today if still ahead, else the next trading day', () => {
    assert.equal(at('AAPL',   'day', '2026-07-15T18:00:00Z'), '2026-07-15T20:00:00.000Z', '14:00 ET Wed → 16:00 ET Wed')
    assert.equal(at('AAPL',   'day', '2026-07-15T20:00:00Z'), '2026-07-16T20:00:00.000Z', 'exactly at the close → tomorrow')
    assert.equal(at('AAPL',   'day', '2026-07-17T20:30:00Z'), '2026-07-20T20:00:00.000Z', 'Friday after the close → Monday')
    assert.equal(at('EURUSD', 'day', '2026-07-15T07:00:00Z'), '2026-07-15T21:00:00.000Z', 'forex: 17:00 ET')
    assert.equal(at('NQ',     'day', '2026-07-15T21:30:00Z'), '2026-07-16T21:00:00.000Z', 'futures after 17:00 ET → tomorrow 17:00')
    assert.equal(at('BTCUSD', 'day', '2026-07-15T18:03:00Z'), '2026-07-16T00:00:00.000Z', 'crypto: UTC midnight')
})

test('a weekly bar closes on Friday at the session close; a crypto week at Monday 00:00 UTC', () => {
    assert.equal(at('AAPL',   'week', '2026-07-15T18:00:00Z'), '2026-07-17T20:00:00.000Z')
    assert.equal(at('AAPL',   'week', '2026-07-17T20:00:00Z'), '2026-07-24T20:00:00.000Z', 'exactly at Friday close → next Friday')
    assert.equal(at('EURUSD', 'week', '2026-07-15T18:00:00Z'), '2026-07-17T21:00:00.000Z')
    assert.equal(at('BTCUSD', 'week', '2026-07-15T18:00:00Z'), '2026-07-20T00:00:00.000Z')
    assert.equal(at('BTCUSD', 'week', '2026-07-20T00:00:00Z'), '2026-07-27T00:00:00.000Z')
})

test('a monthly bar closes on the last weekday of the month; a crypto month on the 1st 00:00 UTC', () => {
    assert.equal(at('AAPL',   'month', '2026-07-15T18:00:00Z'), '2026-07-31T20:00:00.000Z', 'July 31 2026 is a Friday')
    assert.equal(at('AAPL',   'month', '2026-07-31T20:00:00Z'), '2026-08-31T20:00:00.000Z', 'Aug 31 2026 is a Monday')
    assert.equal(at('AAPL',   'month', '2026-10-20T18:00:00Z'), '2026-10-30T20:00:00.000Z', 'Oct 31 2026 is a Saturday → Fri 30th (EDT still)')
    assert.equal(at('BTCUSD', 'month', '2026-07-15T18:00:00Z'), '2026-08-01T00:00:00.000Z')
})

test('an unknown rung is null — the caller owns the fallback', () => {
    assert.equal(nextCandleCloseMs('AAPL', null, 'nonsense', ms('2026-07-15T18:00:00Z')), null)
    assert.equal(nextCandleCloseMs('AAPL', null, null,       ms('2026-07-15T18:00:00Z')), null)
})

test('the explicit asset_class beats the symbol heuristic', () => {
    // 'XYZ' looks like an equity; told it is crypto, it pages on UTC and never waits for an open.
    assert.equal(at('XYZ', '5min', '2026-07-18T16:03:00Z', 'crypto'), '2026-07-18T16:05:00.000Z')
})
