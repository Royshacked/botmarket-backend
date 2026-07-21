import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MODES, DEFAULT_MODE, normalizeMode, isMode } from '../../services/kairos.modes.js'
import { KAIROS_TOOLS_FOR_MODE } from '../../services/kairos.tools.js'
import { normalizeCall } from '../../api/kairos/kairos.service.js'
import { _sanitizeSeed } from '../../api/kairos/kairos.controller.js'

// K1: Kairos mode scaffolding (KAIROS_MODES.md) — mode field + per-mode tool subsets.

// ── normalizeMode / MODES ────────────────────────────────────────────────────
test('normalizeMode coerces to a known mode; unknown/absent → discretionary', () => {
    assert.deepEqual(MODES, ['discretionary', 'smc', 'institutional'])
    assert.equal(DEFAULT_MODE, 'discretionary')
    assert.equal(normalizeMode('smc'), 'smc')
    assert.equal(normalizeMode('institutional'), 'institutional')
    assert.equal(normalizeMode('bogus'), 'discretionary')
    assert.equal(normalizeMode(undefined), 'discretionary')
    assert.equal(normalizeMode(), 'discretionary')
    assert.equal(isMode('smc'), true)
    assert.equal(isMode('nope'), false)
})

// ── KAIROS_TOOLS_FOR_MODE (tool subsets) ─────────────────────────────────────
const names = mode => KAIROS_TOOLS_FOR_MODE(mode).map(t => t.name)

test('every mode gets the UNIVERSAL tools (incl. get_trading_context)', () => {
    for (const m of MODES) {
        for (const u of ['web_search', 'get_quote', 'get_candles', 'get_chart', 'get_trading_context']) {
            assert.ok(names(m).includes(u), `${m} missing ${u}`)
        }
    }
})

test('discretionary: classical + false-breaks + key-levels, NOT the SMC-lens tools', () => {
    const t = names('discretionary')
    assert.ok(t.includes('get_false_breaks'))
    assert.ok(t.includes('get_indicators'))
    assert.ok(t.includes('get_correlations'))   // discretionary keeps its Phase-2 correlation read
    assert.ok(t.includes('get_key_levels'))     // prior-day levels are classical too (shared)
    assert.ok(!t.includes('get_orderblocks'))   // SMC-lens tools excluded
    assert.ok(!t.includes('get_fvg'))
    assert.ok(!t.includes('get_structure'))
})

test('smc: structure tools (vision + K2 numeric), NO macro/fundamentals', () => {
    const t = names('smc')
    assert.ok(t.includes('get_orderblocks'))
    assert.ok(t.includes('get_false_breaks'))
    assert.ok(t.includes('get_fvg'))         // K2 numeric SMC engine
    assert.ok(t.includes('get_structure'))
    assert.ok(t.includes('get_liquidity'))
    assert.ok(!t.includes('get_macro_snapshot'))
    assert.ok(!t.includes('get_fundamentals'))
})

test('institutional: macro/positioning + sector snapshot, NO structure-vision tools', () => {
    const t = names('institutional')
    assert.ok(t.includes('get_macro_snapshot'))
    assert.ok(t.includes('get_sector_snapshot'))   // wired from scanner for the RS/rotation read
    assert.ok(t.includes('get_correlations'))
    assert.ok(t.includes('get_short_interest'))
    assert.ok(!t.includes('get_orderblocks'))
    assert.ok(!t.includes('get_false_breaks'))
})

test('unknown mode falls back to the discretionary toolset', () => {
    assert.deepEqual(names('bogus'), names('discretionary'))
})

// ── mode persists on the call (normalizeCall) ────────────────────────────────
const rawCall = (over = {}) => ({
    asset: 'AAPL', asset_class: 'equity', trade_type: 'day', bias: 'long',
    sizing: { max_size: 10 }, broker: 'paper', accounts: ['paper-u1'],
    entry_zones: [{ side: 'long', lower: 1, upper: 2 }], reference_levels: [], patterns: [],
    ...over,
})

// ── K3: Argus candidate seed ─────────────────────────────────────────────────
test('_sanitizeSeed: uppercases ticker, keeps string fields, requires a ticker', () => {
    assert.deepEqual(
        _sanitizeSeed({ ticker: 'nvda', direction: 'long', thesis: 'AI leader', analysis: 'clean base' }),
        { ticker: 'NVDA', direction: 'long', thesis: 'AI leader', analysis: 'clean base' })
    assert.deepEqual(_sanitizeSeed({ ticker: 'aapl' }), { ticker: 'AAPL', direction: null, thesis: null, analysis: null })
    assert.equal(_sanitizeSeed({ thesis: 'no ticker' }), null)   // ticker required
    assert.equal(_sanitizeSeed(null), null)
    assert.equal(_sanitizeSeed('nope'), null)
    assert.equal(_sanitizeSeed({ ticker: '   ' }), null)         // blank ticker
})

test('normalizeCall stamps mode (default discretionary; coerces unknown)', () => {
    assert.equal(normalizeCall(rawCall()).mode, 'discretionary')
    assert.equal(normalizeCall(rawCall({ mode: 'smc' })).mode, 'smc')
    assert.equal(normalizeCall(rawCall({ mode: 'institutional' })).mode, 'institutional')
    assert.equal(normalizeCall(rawCall({ mode: 'bogus' })).mode, 'discretionary')
})

test('normalizeCall lens_fit: default good; weak+valid mode passes; weak+bad → null; good drops suggested', () => {
    assert.deepEqual(normalizeCall(rawCall()).lens_fit, { fit: 'good', suggested_mode: null })
    assert.deepEqual(normalizeCall(rawCall({ lens_fit: { fit: 'weak', suggested_mode: 'smc' } })).lens_fit,
        { fit: 'weak', suggested_mode: 'smc' })
    assert.deepEqual(normalizeCall(rawCall({ lens_fit: { fit: 'weak', suggested_mode: 'bogus' } })).lens_fit,
        { fit: 'weak', suggested_mode: null })
    assert.deepEqual(normalizeCall(rawCall({ lens_fit: { fit: 'good', suggested_mode: 'smc' } })).lens_fit,
        { fit: 'good', suggested_mode: null })   // suggested_mode only carried when fit==='weak'
})
