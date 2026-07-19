import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAssetOpen } from '../../services/market.service.js'

// The paper price feed (latestQuote / latestMarkPrice in paperExecution.service) skips the
// intraday 1-min fetch when isAssetOpen(symbol) is false — a closed session has no fresh 1-min
// bars, so the fetch only returns empty and logs "[ohlcv.provider] No candles returned …" noise.
// This locks in that gate decision across sessions. Dates are ET (summer = EDT = UTC-4); pass
// Date objects (isAssetOpen → session predicates → _etWall uses .toLocaleString).
const at = (utcIso) => new Date(utcIso)

// The exact instant from the Render log that prompted the fix: Sunday 2026-07-19 (US market closed).
const SUNDAY   = at('2026-07-19T15:20:00Z')   // 11:20 ET, Sunday
const SATURDAY = at('2026-07-18T18:00:00Z')   // 14:00 ET, Saturday
const WEEKDAY_RTH   = at('2026-07-16T14:30:00Z')   // Thu 10:30 ET — regular session
const WEEKDAY_AFTER = at('2026-07-16T21:00:00Z')   // Thu 17:00 ET — after RTH close

test('equity (AVGO) is closed on the weekend → paper feed skips 1-min', () => {
    assert.equal(isAssetOpen('AVGO', null, SUNDAY),   false)   // the logged scenario
    assert.equal(isAssetOpen('AVGO', 'equity', SUNDAY), false)
    assert.equal(isAssetOpen('AVGO', null, SATURDAY), false)
})

test('equity honours regular-session hours on a weekday', () => {
    assert.equal(isAssetOpen('AVGO', null, WEEKDAY_RTH),   true)
    assert.equal(isAssetOpen('AVGO', null, WEEKDAY_AFTER), false)   // after-hours → no live intraday
})

test('crypto is 24h → paper feed keeps polling 1-min even on the weekend', () => {
    assert.equal(isAssetOpen('BTCUSD', 'crypto', SUNDAY),   true)
    assert.equal(isAssetOpen('BTCUSD', null,     SATURDAY), true)   // symbol heuristic
})

test('index futures are closed all day Saturday', () => {
    assert.equal(isAssetOpen('NQ', 'futures', SATURDAY), false)
})

test('defaults to now when no date is passed (back-compatible signature)', () => {
    assert.equal(typeof isAssetOpen('AVGO'), 'boolean')
    assert.equal(isAssetOpen('BTCUSD', 'crypto'), true)   // crypto is always open regardless of now
})
