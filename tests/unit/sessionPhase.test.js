import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionPhase } from '../../services/market.service.js'

// Thursday 2026-07-16 is a weekday in EDT (ET = UTC-4 in summer). Dates MUST be Date objects
// (sessionPhase → _etWall calls .toLocaleString). Saturday 2026-07-18 for the weekend cases.
const at = (utcIso) => new Date(utcIso)

test('sessionPhase: equity RTH texture (ET, summer EDT)', () => {
    assert.equal(sessionPhase('AAPL', 'equity', at('2026-07-16T13:45:00Z')), 'opening')    // 09:45 ET
    assert.equal(sessionPhase('AAPL', 'equity', at('2026-07-16T14:30:00Z')), 'mid')        // 10:30 ET
    assert.equal(sessionPhase('AAPL', 'equity', at('2026-07-16T16:30:00Z')), 'lunch')      // 12:30 ET
    assert.equal(sessionPhase('AAPL', 'equity', at('2026-07-16T18:00:00Z')), 'mid')        // 14:00 ET
    assert.equal(sessionPhase('AAPL', 'equity', at('2026-07-16T19:20:00Z')), 'power')      // 15:20 ET
    assert.equal(sessionPhase('AAPL', 'equity', at('2026-07-16T19:55:00Z')), 'into-close') // 15:55 ET
})
test('sessionPhase: equity outside RTH + weekend', () => {
    assert.equal(sessionPhase('AAPL', 'equity', at('2026-07-16T12:00:00Z')), 'pre-market')  // 08:00 ET
    assert.equal(sessionPhase('AAPL', 'equity', at('2026-07-16T20:30:00Z')), 'after-hours') // 16:30 ET
    assert.equal(sessionPhase('AAPL', 'equity', at('2026-07-18T16:30:00Z')), 'closed')      // Saturday
})
test('sessionPhase: crypto + forex are always 24h (texture immaterial)', () => {
    assert.equal(sessionPhase('BTCUSD', 'crypto', at('2026-07-16T16:30:00Z')), '24h')
    assert.equal(sessionPhase('EURUSD', 'forex',  at('2026-07-16T16:30:00Z')), '24h')
    assert.equal(sessionPhase('BTCUSD', null,     at('2026-07-18T00:00:00Z')), '24h')       // symbol fallback, weekend
})
test('sessionPhase: index futures use RTH texture, overnight otherwise', () => {
    assert.equal(sessionPhase('NQ', 'futures', at('2026-07-16T16:30:00Z')), 'lunch')       // 12:30 ET (RTH)
    assert.equal(sessionPhase('NQ', 'futures', at('2026-07-16T12:00:00Z')), 'overnight')   // 08:00 ET (pre-RTH)
    assert.equal(sessionPhase('NQ', 'futures', at('2026-07-18T16:30:00Z')), 'overnight')   // Saturday
})
test('sessionPhase: symbol fallback when no assetClass', () => {
    assert.equal(sessionPhase('AAPL', null, at('2026-07-16T16:30:00Z')), 'lunch')          // equity heuristic
})
