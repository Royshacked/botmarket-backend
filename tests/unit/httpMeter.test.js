import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _meterKey } from '../../services/http.util.js'

// The meter answers "which call is spending the quota". That means grouping by ENDPOINT and
// dropping the ticker — one line per symbol would be the noise the meter exists to replace — while
// KEEPING the timeframe, because "190 of these were 1-minute bars this plan refuses" is the finding.

test('the symbol is dropped so requests group by endpoint', () => {
    assert.equal(_meterKey('FMP /quote AAPL'), 'FMP /quote')
    assert.equal(_meterKey('FMP /quote SPY'),  'FMP /quote')
})

test('the timeframe is kept — it is the difference between a cost and a diagnosis', () => {
    assert.equal(_meterKey('FMP candles AAPL/minutex1'), 'FMP candles minutex1')
    assert.equal(_meterKey('FMP candles MSFT/minutex5'), 'FMP candles minutex5')
    assert.notEqual(_meterKey('FMP candles AAPL/minutex1'), _meterKey('FMP candles AAPL/minutex5'))
})

test('labels from other providers still group, and a missing one never throws', () => {
    assert.equal(_meterKey('Finnhub earnings'), 'Finnhub earnings')
    assert.equal(_meterKey('single'), 'single')
    assert.equal(_meterKey(''), 'http')
    assert.equal(_meterKey(), 'http')
    assert.equal(_meterKey(null), 'http')
})
