import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    formatScreenerRows,
    formatMacroSnapshot,
    formatAnalystBlock,
    formatEtfSectorWeights,
    formatPeers,
    formatLiquidityFloat,
    formatSectorSnapshot,
    formatMovers,
    formatAnalystActionsBulk,
    formatAnalystActionsForSymbols,
} from '../../providers/fmp.provider.js'

// Pure formatters behind Atlas's Starter-plan tools (screen_candidates,
// get_macro_snapshot) and the enriched get_fundamentals. Network fetch isn't
// unit-tested — these lock the LLM-facing shape and the risky arithmetic
// (dividend yield, target upside, 2s10s spread, decimal-vs-percent).

// ─── formatPeers (get_peers — the correlation-read cohort) ──────────────────
test('peers: rows → one line, self excluded, capped', () => {
    const rows = [
        { symbol: 'NVDA', companyName: 'NVIDIA' },   // self — dropped
        { symbol: 'avgo', companyName: 'Broadcom' }, // lowercased → uppercased
        { symbol: 'AMD' },                            // no name
    ]
    const out = formatPeers('NVDA', rows)
    assert.ok(!out.includes('NVDA (') && !/\bNVDA\b,/.test(out))   // self not listed as a peer
    assert.ok(out.includes('AVGO (Broadcom)'))
    assert.ok(out.includes('AMD'))
})

test('peers: caps at topN', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ symbol: `P${i}` }))
    const out = formatPeers('X', rows, 5)
    assert.equal((out.match(/P\d+/g) || []).length, 5)
})

test('peers: empty / non-array → explicit "no peers" line', () => {
    assert.ok(formatPeers('AAPL', []).includes('No fundamental peers'))
    assert.ok(formatPeers('AAPL', null).includes('No fundamental peers'))
})

// ─── formatLiquidityFloat (Phase-3 risk/sizing) ─────────────────────────────
test('liquidityFloat: avg volume + derived avg $ volume + free float %', () => {
    const out = formatLiquidityFloat({ price: 100, averageVolume: 2_000_000 }, { freeFloat: 88.5, floatShares: 23_225_466_000 })
    const s = out.join('\n')
    assert.ok(s.includes('Avg volume: 2,000,000'))
    assert.ok(s.includes('Avg $ volume: $200'))     // 100 * 2M = $200M (compactMoney)
    assert.ok(s.includes('Free float: 88.5%'))
    assert.ok(s.includes('Float shares: 23.2B'))
})

test('liquidityFloat: low free float flags squeeze/gap risk', () => {
    const out = formatLiquidityFloat({ price: 12, averageVolume: 500000 }, { freeFloat: 14.2 }).join('\n')
    assert.ok(/Free float: 14\.2% — LOW float/.test(out))
})

test('liquidityFloat: missing data → only the lines it can build (never throws)', () => {
    assert.deepEqual(formatLiquidityFloat({}, null), [])
    assert.deepEqual(formatLiquidityFloat(null, null), [])
    const onlyVol = formatLiquidityFloat({ averageVolume: 1000 }, null)   // no price → no $ vol; no float
    assert.deepEqual(onlyVol, ['Avg volume: 1,000'])
})

// ─── formatScreenerRows ─────────────────────────────────────────────────────
test('screener: row → compact line with derived dividend yield', () => {
    const out = formatScreenerRows([{
        symbol: 'AAPL', companyName: 'Apple Inc.', marketCap: 3.4e12, sector: 'Technology',
        industry: 'Consumer Electronics', beta: 1.2, price: 317.31, lastAnnualDividend: 1.0, isEtf: false,
    }], { sector: 'Technology' })
    assert.match(out, /^Screen results \(Technology\) — 1 match:/)
    assert.match(out, /AAPL/)
    assert.match(out, /mcap \$3\.40T/)
    assert.match(out, /β 1\.20/)
    assert.match(out, /\$317\.31/)
    assert.match(out, /div 0\.3%/)   // 1.0 / 317.31 ≈ 0.32%
})

test('screener: empty → no-match line naming the filters', () => {
    assert.equal(formatScreenerRows([], { sector: 'Energy' }), 'No stocks matched the screen (Energy).')
    assert.equal(formatScreenerRows(null, {}), 'No stocks matched the screen.')
})

test('screener: ETF flagged, plural count', () => {
    const out = formatScreenerRows([
        { symbol: 'SPY', companyName: 'SPDR S&P 500', marketCap: 5e11, price: 600, isEtf: true },
        { symbol: 'QQQ', companyName: 'Invesco QQQ', marketCap: 3e11, price: 500, isEtf: true },
    ], { isEtf: true })
    assert.match(out, /2 matches:/)
    assert.match(out, /SPY.*ETF/)
})

// ─── formatAnalystBlock ─────────────────────────────────────────────────────
test('analyst: target upside vs price + rating split', () => {
    const out = formatAnalystBlock(300, { targetConsensus: 328.83 },
        { strongBuy: 1, buy: 69, hold: 33, sell: 8, strongSell: 0, consensus: 'Buy' })
    assert.equal(out[0], '— Analyst view (forward) —')
    assert.match(out[1], /Price target \(consensus\): \$329 \(\+10% vs price\)/)
    assert.match(out[2], /Analyst ratings: Buy \(70 buy \/ 33 hold \/ 8 sell, 111 analysts\)/)
})

test('analyst: no price → target shown without upside; nothing → []', () => {
    const out = formatAnalystBlock(null, { targetConsensus: 100 }, null)
    assert.deepEqual(out, ['— Analyst view (forward) —', 'Price target (consensus): $100'])
    assert.deepEqual(formatAnalystBlock(null, null, null), [])
    assert.deepEqual(formatAnalystBlock(50, { targetConsensus: 0 }, { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }), [])
})

// ─── formatEtfSectorWeights ─────────────────────────────────────────────────
test('etf weights: sorted desc, percent shown as-is, capped', () => {
    const out = formatEtfSectorWeights([
        { sector: 'Cash', weightPercentage: 0.28 },
        { sector: 'Technology', weightPercentage: 32.1 },
        { sector: 'Healthcare', weightPercentage: 12.4 },
    ], 2)
    assert.deepEqual(out, ['— Sector exposure (look-through) —', 'Technology: 32.1%', 'Healthcare: 12.4%'])
    assert.deepEqual(formatEtfSectorWeights([]), [])
})

// ─── formatMacroSnapshot ────────────────────────────────────────────────────
test('macro: latest treasury row wins, 2s10s computed', () => {
    const out = formatMacroSnapshot({
        treasury: [
            { date: '2026-07-15', month3: 3.80, year2: 4.10, year10: 4.50, year30: 5.00 },
            { date: '2026-07-16', month3: 3.84, year2: 4.16, year10: 4.57, year30: 5.09 },
        ],
    })
    assert.match(out, /Treasury curve \(2026-07-16\):/)   // newest, not array order
    assert.match(out, /3M 3\.84%  2Y 4\.16%  10Y 4\.57%  30Y 5\.09%/)
    assert.match(out, /2s10s \+41bp/)
})

test('macro: inverted curve flagged', () => {
    const out = formatMacroSnapshot({ treasury: [{ date: '2026-01-02', year2: 5.0, year10: 4.5 }] })
    assert.match(out, /2s10s -50bp \(INVERTED\)/)
})

test('macro: indicators format rates as % and levels with separators', () => {
    const out = formatMacroSnapshot({
        indicators: [
            { label: 'Inflation (YoY)', value: 2.29, date: '2025-10-15' },
            { label: 'Real GDP', value: 24055.749, date: '2025-10-01' },
        ],
    })
    assert.match(out, /Inflation \(YoY\): 2\.29% \(as of 2025-10-15\)/)
    assert.match(out, /Real GDP: 24,055\.7 \(as of 2025-10-01\)/)
})

test('macro: sector leaders/laggards ranked', () => {
    const out = formatMacroSnapshot({
        sectors: [
            { sector: 'Energy', averageChange: -2.0, exchange: 'NASDAQ' },
            { sector: 'Technology', averageChange: 1.5, exchange: 'NASDAQ' },
            { sector: 'Utilities', averageChange: 0.3, exchange: 'NASDAQ' },
            { sector: 'Financials', averageChange: -1.1, exchange: 'NASDAQ' },
        ],
    })
    assert.match(out, /leaders: Technology \+1\.50%/)
    assert.match(out, /laggards:.*Energy -2\.00%/)
    assert.match(out, /\(NASDAQ, today\)/)
})

test('macro: nothing available → web_search fallback line', () => {
    assert.equal(formatMacroSnapshot({}), 'Macro snapshot unavailable right now — fall back to web_search.')
})

// ─── formatSectorSnapshot (scanner rotation discovery) ──────────────────────
test('sectorSnapshot: every sector ranked leaders→laggards, signed %', () => {
    const out = formatSectorSnapshot([
        { sector: 'Energy',     averageChange: -2.0, exchange: 'NASDAQ' },
        { sector: 'Technology', averageChange: 1.5,  exchange: 'NASDAQ' },
        { sector: 'Utilities',  averageChange: 0.3,  exchange: 'NASDAQ' },
    ])
    const lines = out.split('\n')
    assert.match(lines[0], /Sector rotation \(NASDAQ, today\)/)
    // leaders first: Technology before Utilities before Energy
    assert.ok(out.indexOf('Technology') < out.indexOf('Utilities'))
    assert.ok(out.indexOf('Utilities') < out.indexOf('Energy'))
    assert.match(out, /Technology\s+\+1\.50%/)
    assert.match(out, /Energy\s+-2\.00%/)
})

test('sectorSnapshot: empty / bad rows → ETF fallback line, never throws', () => {
    assert.match(formatSectorSnapshot([]), /Sector snapshot unavailable/)
    assert.match(formatSectorSnapshot(null), /Sector snapshot unavailable/)
    assert.match(formatSectorSnapshot([{ sector: 'X', averageChange: 'n/a' }]), /Sector snapshot unavailable/)
})

// ─── formatMovers (scanner momentum discovery) ──────────────────────────────
test('movers: gainers row → symbol, exchange, price, signed % ; kind label', () => {
    const out = formatMovers('gainers', [
        { symbol: 'SDOT', name: 'Sadot Group Inc.', price: 25.3, change: 11.05, changesPercentage: 77.54386, exchange: 'NASDAQ' },
    ])
    assert.match(out, /^Top gainers \(US, today\) — top 1:/)
    assert.match(out, /SDOT/)
    assert.match(out, /NASDAQ/)
    assert.match(out, /\$25\.30/)
    assert.match(out, /\+77\.54%/)
})

test('movers: losers keep the negative sign; label switches by kind', () => {
    const out = formatMovers('losers', [
        { symbol: 'VIVK', name: 'Vivakor', price: 2.26, changesPercentage: -46.94836, exchange: 'NASDAQ' },
    ])
    assert.match(out, /^Top losers/)
    assert.match(out, /-46\.95%/)
})

test('movers: limit caps rows; empty → explicit line', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ symbol: `M${i}`, price: 10, changesPercentage: 1 }))
    const out = formatMovers('active', rows, 5)
    assert.equal((out.match(/M\d+/g) || []).length, 5)
    assert.match(formatMovers('gainers', []), /No top gainers available/)
    assert.match(formatMovers('gainers', null), /No top gainers available/)
})

// ─── formatAnalystActions (scanner ratings catalyst) ────────────────────────
test('analystActions bulk: newest first, action tag + grade move', () => {
    const out = formatAnalystActionsBulk([
        { symbol: 'CLNE', publishedDate: '2026-07-17T20:40:09.000Z', action: 'downgrade', newGrade: 'Neutral', previousGrade: 'Buy', gradingCompany: 'UBS' },
        { symbol: 'NVDA', publishedDate: '2026-07-18T09:00:00.000Z', action: 'upgrade',   newGrade: 'Buy',     previousGrade: 'Hold', gradingCompany: 'Morgan Stanley' },
    ])
    // NVDA (07-18) sorts before CLNE (07-17) despite input order
    assert.ok(out.indexOf('NVDA') < out.indexOf('CLNE'))
    assert.match(out, /2026-07-18\s+NVDA\s+▲ upgrade by Morgan Stanley \(Hold→Buy\)/)
    assert.match(out, /2026-07-17\s+CLNE\s+▼ downgrade by UBS \(Buy→Neutral\)/)
})

test('analystActions bulk: empty → explicit line', () => {
    assert.match(formatAnalystActionsBulk([]), /No recent analyst rating changes/)
    assert.match(formatAnalystActionsBulk(null), /No recent analyst rating changes/)
})

test('analystActions per-symbol: grouped blocks, capped at 4 each; empty → line', () => {
    const out = formatAnalystActionsForSymbols({
        AAPL: [
            { date: '2026-07-14', action: 'downgrade', previousGrade: 'Sector Weight', newGrade: 'Underweight', gradingCompany: 'Keybanc' },
            { date: '2026-07-01', action: 'maintain',  newGrade: 'Buy', gradingCompany: 'Citi' },
        ],
        TSLA: [],   // dropped — no rows
    })
    assert.match(out, /AAPL:/)
    assert.ok(!out.includes('TSLA'))
    assert.match(out, /2026-07-14\s+▼ downgrade by Keybanc \(Sector Weight→Underweight\)/)
    assert.match(formatAnalystActionsForSymbols({}), /No recent analyst rating actions/)
})
