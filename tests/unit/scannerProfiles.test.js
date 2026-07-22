import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _cleanScore, _normalizeScan, SCANNER_TOOLS_FOR_PROFILE } from '../../services/scanner.agent.service.js'

// Argus P4a — trading vs investing profiles (scoring axes, tool subset, scan_list profile/destination).

// ── investing scoring axes ───────────────────────────────────────────────────
test('investing _cleanScore: quality/valuation/growth/balance_sheet axes + weights', () => {
    // q.30 v.30 g.25 b.15 → 88*.30 + 62*.30 + 80*.25 + 90*.15 = 26.4+18.6+20+13.5 = 78.5 → 79
    const s = _cleanScore({ quality: 88, valuation: 62, growth: 80, balance_sheet: 90 }, 'long term', 'investing')
    assert.deepEqual(s, { total: 79, quality: 88, valuation: 62, growth: 80, balance_sheet: 90 })
})

test('investing _cleanScore: trade axes are ignored under the investing profile', () => {
    // catalyst/technical are not investing axes → no usable axis → null
    assert.equal(_cleanScore({ catalyst: 80, technical: 70 }, 'long term', 'investing'), null)
})

test('trading _cleanScore unchanged (default profile) — trade axes still apply', () => {
    // swing: 80*.30 + 70*.30 + 60*.25 + 90*.15 = 73.5 → 74
    const s = _cleanScore({ catalyst: 80, technical: 70, relativeStrength: 60, liquidity: 90 }, 'swing')
    assert.equal(s.total, 74)
    assert.ok('catalyst' in s && !('quality' in s))
})

// ── _normalizeScan: profile + destination + no trade lens on investing ───────
test('_normalizeScan investing: investing axes, profile=investing, destination=analyst, no recommended_mode', () => {
    const scan = {
        thesis: 'quality tech', direction: 'long', style: 'long term',
        candidates: [{
            ticker: 'msft', direction: 'long', thesis: 'compounder', analysis: 'a',
            score: { quality: 90, valuation: 60, growth: 75, balance_sheet: 95 }, recommended_mode: 'smc',
        }],
    }
    const out = _normalizeScan(scan, null, null, 'investing')
    assert.equal(out.profile, 'investing')
    assert.equal(out.destination, 'analyst')
    const c = out.candidates[0]
    assert.equal(c.recommended_mode, null)                 // investing → to the Analyst, not Kairos
    assert.equal(c.score.total, 78)                        // 90*.3+60*.3+75*.25+95*.15 = 78
    assert.ok('quality' in c.score)
})

test('_normalizeScan trading (default): profile=trading, destination=kairos', () => {
    const scan = { thesis: 's', direction: 'long', candidates: [{ ticker: 'AAA', direction: 'long', thesis: 't', analysis: 'a', score: { catalyst: 80, technical: 70, relativeStrength: 60, liquidity: 90 } }] }
    const out = _normalizeScan(scan)
    assert.equal(out.profile, 'trading')
    assert.equal(out.destination, 'kairos')
})

// ── tool subset ──────────────────────────────────────────────────────────────
test('SCANNER_TOOLS_FOR_PROFILE: investing keeps the fundamental kit, drops technical/vision', () => {
    const inv = SCANNER_TOOLS_FOR_PROFILE('investing').map(t => t.name)
    for (const k of ['screen_candidates', 'get_fundamentals', 'get_sec_filings', 'get_earnings']) assert.ok(inv.includes(k), `investing missing ${k}`)
    for (const k of ['get_candles', 'get_indicators', 'get_chart', 'get_orderblocks', 'get_market_movers']) assert.ok(!inv.includes(k), `investing should drop ${k}`)

    const trd = SCANNER_TOOLS_FOR_PROFILE('trading').map(t => t.name)
    assert.ok(trd.includes('get_candles') && trd.includes('get_indicators') && trd.includes('get_orderblocks'))  // full kit
})
