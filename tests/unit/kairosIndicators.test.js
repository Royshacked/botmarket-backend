import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _parseIndicatorSpecs, _formatIndicator } from '../../services/kairos.tools.js'

// ── _parseIndicatorSpecs ─────────────────────────────────────────────────
test('parse: names + optional periods, case/space tolerant', () => {
    assert.deepEqual(
        _parseIndicatorSpecs('EMA(20), rsi(14) , atr,  macd ,vwap'),
        [
            { name: 'ema', period: 20 },
            { name: 'rsi', period: 14 },
            { name: 'atr', period: null },
            { name: 'macd', period: null },
            { name: 'vwap', period: null },
        ],
    )
})

test('parse: empty / junk → []', () => {
    assert.deepEqual(_parseIndicatorSpecs(''), [])
    assert.deepEqual(_parseIndicatorSpecs('  , , '), [])
    assert.deepEqual(_parseIndicatorSpecs(null), [])
})

// ── _formatIndicator (reuses the monitor calc math) ──────────────────────
// 30 rising closes → EMA/SMA computable; monitor-form candles for ATR/VWAP.
const closes = Array.from({ length: 30 }, (_, i) => 100 + i)
const mon = closes.map((c, i) => ({ t: 1_700_000_000 + i * 60, o: c - 0.5, h: c + 0.5, l: c - 0.8, c, v: 1000 }))

test('format: ema shows latest value with the requested period', () => {
    const out = _formatIndicator('ema', 10, closes, mon)
    assert.match(out, /^ema\(10\): \d+\.\d{2}/)
})

test('format: default periods when omitted (ema→20, rsi→14, atr→14)', () => {
    assert.match(_formatIndicator('ema', null, closes, mon), /^ema\(20\):/)
    assert.match(_formatIndicator('rsi', null, closes, mon), /^rsi\(14\):/)
    assert.match(_formatIndicator('atr', null, closes, mon), /^atr\(14\):/)
})

test('format: rsi of a monotonic uptrend is ~100', () => {
    const out = _formatIndicator('rsi', 14, closes, mon)   // all-gains → RSI pegs high
    const val = Number(out.match(/rsi\(14\): ([\d.]+)/)[1])
    assert.ok(val > 95, `expected high RSI, got ${val}`)
})

test('format: macd reports line/signal/hist', () => {
    assert.match(_formatIndicator('macd', null, closes, mon), /^macd: line .* · signal .* · hist /)
})

test('format: vwap uses the given session anchor; falls back to approx without one', () => {
    // With a real anchor at/under the first bar → session VWAP over the window.
    assert.match(_formatIndicator('vwap', null, closes, mon, 1_700_000_000_000), /^vwap: [\d.]+.*\(session\)$/)
    // No anchor → labeled session-approx.
    assert.match(_formatIndicator('vwap', null, closes, mon), /\(session-approx\)$/)
})

test('format: unsupported name is explained', () => {
    assert.match(_formatIndicator('bogus', null, closes, mon), /unsupported/)
})
