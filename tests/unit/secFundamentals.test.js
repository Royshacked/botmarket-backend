import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactFacts, quarterly, fundamentalsAt, prepareFundamentals } from '../../services/secFundamentals.service.js'

// The fundamentals as known on a day, from SEC companyfacts (screener-lab.md §39). Shapes as KO's 2026-11-07 sample.

const q = (start, end, val, filed, form = '10-Q') => ({ start, end, val, filed, form, accn: `a-${filed}` })

test('each period once, at its first filing; a restatement filed later does not replace it', () => {
    const json = { facts: { 'us-gaap': { Revenues: { units: { USD: [q('2025-01-01', '2025-03-31', 100, '2025-04-25'), q('2025-01-01', '2025-03-31', 90, '2026-04-25'), { ...q('2025-01-01', '2025-03-31', 1, '2025-04-20'), form: '8-K' }] } } } } }
    assert.deepEqual(compactFacts(json).rev, [['2025-01-01', '2025-03-31', 100, '2025-04-25']])
})

test('revenue under a second name fills the periods the first lacks', () => {
    const json = { facts: { 'us-gaap': {
        SalesRevenueNet: { units: { USD: [q('2016-01-01', '2016-03-31', 50, '2016-04-25'), q('2018-01-01', '2018-03-31', 999, '2018-04-25')] } },
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [q('2018-01-01', '2018-03-31', 70, '2018-04-25')] } },
    } } }
    const rev = compactFacts(json).rev.sort((a, b) => a[1].localeCompare(b[1]))
    assert.deepEqual(rev.map(r => r[2]), [50, 70], 'the earlier name in the list wins a period filed the same day')
})

test('a period filed first under one name and as a comparative under another a year later: the first filing wins', () => {
    const json = { facts: { 'us-gaap': {
        Revenues: { units: { USD: [q('2024-04-01', '2024-06-30', 84, '2025-07-24')] } },
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [q('2024-04-01', '2024-06-30', 85, '2024-07-24')] } },
    } } }
    assert.deepEqual(compactFacts(json).rev, [['2024-04-01', '2024-06-30', 85, '2024-07-24']])
})

test('share counts before a split are put on today\'s basis; a buyback is not a split', () => {
    const sh = [['2023-05-20', 2470, '2023-05-26'], ['2024-05-17', 2460, '2024-05-29'], ['2024-08-23', 24530, '2024-08-28'], ['2025-08-22', 24300, '2025-08-27']]
    assert.deepEqual(prepareFundamentals({ rev: [], ni: [], eq: [], sh }).sh.map(x => x[1]), [24700, 24600, 24530, 24300])
    const buyback = [['2024-01-01', 100, '2024-01-05'], ['2025-01-01', 90, '2025-01-05']]
    assert.deepEqual(prepareFundamentals({ rev: [], ni: [], eq: [], sh: buyback }).sh.map(x => x[1]), [100, 90])
    const reverse = [['2024-01-01', 1000, '2024-01-05'], ['2025-01-01', 100, '2025-01-05']]
    assert.deepEqual(prepareFundamentals({ rev: [], ni: [], eq: [], sh: reverse }).sh.map(x => x[1]), [100, 100], 'a 1:10 reverse split')
})

test('Q4 is the fiscal year less its three quarters, filed with the 10-K', () => {
    const rows = [['2025-01-01', '2025-03-31', 10, '2025-04-25'], ['2025-04-01', '2025-06-30', 11, '2025-07-25'], ['2025-07-01', '2025-09-30', 12, '2025-10-25'],
        ['2025-01-01', '2025-12-31', 50, '2026-02-20'], ['2025-01-01', '2025-06-30', 21, '2025-07-25']]
    assert.deepEqual(quarterly(rows), [
        { end: '2025-03-31', val: 10, filed: '2025-04-25' }, { end: '2025-06-30', val: 11, filed: '2025-07-25' },
        { end: '2025-09-30', val: 12, filed: '2025-10-25' }, { end: '2025-12-31', val: 17, filed: '2026-02-20' }])
    assert.equal(quarterly([['2025-01-01', '2025-12-31', 50, '2026-02-20']]).length, 0, 'no quarters, no Q4')
})

test('share classes filed together are summed; the cover page wins over the weighted average', () => {
    const json = { facts: { dei: { EntityCommonStockSharesOutstanding: { units: { shares: [
        { end: '2025-04-20', val: 300, filed: '2025-04-25', accn: 'x' }, { end: '2025-04-20', val: 200, filed: '2025-04-25', accn: 'x' }] } } } } }
    assert.deepEqual(compactFacts(json).sh, [['2025-04-20', 500, '2025-04-25']])
})

function company() {
    // Eight quarters, revenue +10% a year, margin up from 10% to 20%, shares down 5%.
    const ends = ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31']
    const filed = (e) => new Date(Date.parse(`${e}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10)
    const start = (e) => new Date(Date.parse(`${e}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10)
    return prepareFundamentals({
        rev: ends.map((e, n) => [start(e), e, n < 4 ? 100 : 110, filed(e)]),
        ni: ends.map((e, n) => [start(e), e, n < 4 ? 10 : 22, filed(e)]),
        eq: [['2025-12-31', 2200, '2026-01-30']],
        sh: [['2024-12-31', 100, '2025-01-30'], ['2025-12-31', 95, '2026-01-30']],
    })
}

test('the day sees only what was filed by then', () => {
    const f = company()
    const early = fundamentalsAt(f, '2026-01-29', 100), late = fundamentalsAt(f, '2026-02-01', 100)
    assert.equal(early.mcap_log, Math.log10(100 * 100), 'the new share count is not filed yet')
    assert.equal(late.mcap_log, Math.log10(95 * 100))
    assert.ok(Math.abs(late.rev_growth - 10) < 1e-9)
    assert.ok(Math.abs(late.margin - 20) < 1e-9)
    assert.ok(Math.abs(late.margin_chg - 10) < 1e-9)
    assert.ok(Math.abs(late.share_chg + 5) < 1e-9)
    assert.ok(Math.abs(late.ps - 9500 / 440) < 1e-9)
    assert.ok(Math.abs(late.earn_yield - 88 / 9500 * 100) < 1e-9)
    assert.ok(Math.abs(late.book_mkt - 2200 / 9500) < 1e-9)
})

test('nothing known, or no price: every field null', () => {
    const none = fundamentalsAt(company(), '2020-01-01', 100)
    assert.ok(Object.values(none).every(v => v == null))
    assert.ok(Object.values(fundamentalsAt(null, '2026-01-01', 100)).every(v => v == null))
    assert.ok(Object.values(fundamentalsAt(company(), '2026-02-01', 0)).every(v => v == null))
})
