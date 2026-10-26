import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCusips, booksOf, betsOf, isConcentrated, isNotCommon, firstPerKey, meanWithoutBest, MIN_WEIGHT } from '../../services/managers.service.js'
import { joinWindows } from '../../services/screenerLab.data.js'

// The managers (13F) — test J (Roy, 2026-10-26: "test the managers — do not make short cuts").

test('isNotCommon: preferreds, notes, warrants and units are not the common', () => {
    for (const c of ['PFD SER A', '6.5% NOTES', 'WTS', 'DEP SHS', 'UNIT 99/99/9999', 'PREFERRED']) assert.equal(isNotCommon(c), true, c)
    for (const c of ['COM', 'CL A NEW', 'COMMON STOCK', 'SHS', 'ORD SHS', 'COM NEW']) assert.equal(isNotCommon(c), false, c)
})

test('resolveCusips: the most-held candidate wins over a map that gave the common to a preferred', () => {
    // gics put the common's CUSIP on the preferred's symbol (CMS → CMS-PB) and a preferred's on MSTR; FMP has both right.
    const metas = new Map([
        ['2026-03-31', { '125896100': [800, 3e8, 'CMS ENERGY', 'COM'], '594972408': [850, 2e8, 'STRATEGY INC', 'CL A NEW'], '594972853': [1, 2e3, 'STRATEGY PFD', 'COM'] }],
        ['2026-06-30', { '125896100': [823, 3e8, 'CMS ENERGY', 'COM'], '594972408': [852, 2e8, 'STRATEGY INC', 'CL A NEW'], '594972853': [1, 2e3, 'STRATEGY PFD', 'COM'] }],
    ])
    const { cusipOf, report } = resolveCusips(['CMS', 'MSTR'], {
        gics: { '125896100': 'CMS-PB', '594972853': 'MSTR' },
        fmp: { CMS: { cusip: '125896100' }, MSTR: { cusip: '594972408' } }, metas })
    assert.equal(cusipOf.get('CMS').get('2026-06-30'), '125896100')
    assert.equal(cusipOf.get('MSTR').get('2026-06-30'), '594972408')
    assert.ok(report.some(r => r.symbol === 'MSTR' && r.kind === 'gics_cusip_replaced' && r.from === '594972853'))
    assert.ok(report.some(r => r.symbol === 'CMS' && r.kind === 'gics_had_none' && r.gicsHolder === 'CMS-PB'))
})

test('resolveCusips: a changed CUSIP — the same issuer code stands in, a preferred or another name’s CUSIP never', () => {
    const metas = new Map([
        ['2025-12-31', { '111111AA1': [5, 1, 'X CORP', 'COM'], '111111BB2': [300, 1, 'X CORP', 'COM'], '111111PP9': [900, 1, 'X CORP PFD', 'PFD SER A'] }],
        ['2026-03-31', { '111111AA1': [310, 1, 'X CORP', 'COM NEW'] }],
        ['2026-06-30', { '111111AA1': [320, 1, 'X CORP', 'COM NEW'] }],
    ])
    const { cusipOf } = resolveCusips(['X'], { gics: { '111111AA1': 'X' }, fmp: {}, metas })
    assert.equal(cusipOf.get('X').get('2026-06-30'), '111111AA1')
    assert.equal(cusipOf.get('X').get('2025-12-31'), '111111BB2')          // the old common, not the bigger preferred
    const { cusipOf: c2 } = resolveCusips(['X', 'Y'], { gics: { '111111AA1': 'X', '111111BB2': 'Y' }, fmp: {}, metas })
    assert.equal(c2.get('X').has('2025-12-31'), false)                    // Y's own CUSIP is not X's stand-in
})

test('booksOf: per filer per name, summed; holders counted once per filer; the earliest filing kept', () => {
    const symOf = new Map([['C1', 'A'], ['C2', 'A'], ['C3', 'B']])
    const { books, holders } = booksOf([
        ['f1', 'C1', 10, 100, '2026-08-10'], ['f1', 'C2', 5, 50, '2026-08-01'], ['f2', 'C1', 1, 10, '2026-08-12'], ['f2', 'ZZ', 1, 1, '2026-08-12'],
    ], symOf)
    assert.deepEqual(books.get('f1').get('A'), { shares: 15, value: 150, filed: '2026-08-01' })
    assert.equal(holders.get('A'), 2)
    assert.equal(books.get('f2').has('ZZ'), false)
})

const filer = (V, N, unit = 1) => ['m', V, N, unit, '2026-08-01', 10, 0]
function quarter(rows) { return booksOf(rows, new Map(rows.map(r => [r[1], r[1]]))) }

test('betsOf: a new name at 3%+ of the book is a bet; under 3%, or a filer with no filing before, is not', () => {
    const cur = quarter([['f1', 'A', 10, 5e6, '2026-08-01'], ['f1', 'B', 10, 1e6, '2026-08-01'], ['f2', 'A', 10, 9e6, '2026-08-02']])
    const prev = quarter([['f1', 'C', 10, 1e6, '2026-05-01'], ['x', 'A', 1, 1, '2026-05-01'], ['y', 'A', 1, 1, '2026-05-01']])
    const bets = betsOf({ cur, prev, filersCur: { f1: filer(1e8, 20), f2: filer(1e8, 20) }, filersPrev: { f1: filer(1e8, 20) },
        holdersCur: cur.holders, holdersPrev: prev.holders, priceRatio: () => 1, period: 'Q' })
    assert.deepEqual(bets.map(b => [b.cik, b.symbol, b.kind]), [['f1', 'A', 'new']])    // B is 1%; f2 has no filing before
    assert.equal(bets[0].weight, 0.05)
    assert.ok(bets[0].weight >= MIN_WEIGHT)
})

test('betsOf: an add is the dollar value up 1.5x after the price move; a split cannot fake it', () => {
    const prev = quarter([['f1', 'A', 100, 2e6, '2026-05-01'], ['f1', 'B', 100, 2e6, '2026-05-01'], ['h', 'B', 1, 1, '2026-05-01']])
    // A: price doubled (and split 2:1 — shares doubled), dollars doubled → no add. B: price flat, dollars ×2 → add.
    const cur = quarter([['f1', 'A', 200, 4e6, '2026-08-01'], ['f1', 'B', 200, 4e6, '2026-08-01'], ['h', 'B', 1, 1, '2026-08-01']])
    const bets = betsOf({ cur, prev, filersCur: { f1: filer(5e7, 10), h: filer(1e9, 999) }, filersPrev: { f1: filer(5e7, 10), h: filer(1e9, 999) },
        holdersCur: cur.holders, holdersPrev: prev.holders, priceRatio: (s) => (s === 'A' ? 2 : 1), period: 'Q' })
    assert.deepEqual(bets.map(b => [b.symbol, b.kind]), [['B', 'add']])
})

test('betsOf: a data break (half the holders the quarter before) and an untrusted unit give no bets', () => {
    const prev = quarter([['f1', 'Z', 1, 1, '2026-05-01']])
    const cur = quarter([['f1', 'A', 10, 5e6, '2026-08-01'], ['g', 'A', 1, 1, '2026-08-01'], ['f2', 'B', 10, 5e6, '2026-08-01']])
    const prevHolders = new Map([['A', 0], ['B', 5]])
    const bets = betsOf({ cur, prev, filersCur: { f1: filer(1e8, 20), f2: filer(1e8, 20, 0), g: filer(1e8, 20) }, filersPrev: { f1: filer(1e8, 20), f2: filer(1e8, 20), g: filer(1e8, 20) },
        holdersCur: cur.holders, holdersPrev: prevHolders, priceRatio: () => 1, period: 'Q' })
    assert.deepEqual(bets, [])
})

test('isConcentrated: 40 positions or fewer and $100M+', () => {
    assert.equal(isConcentrated({ N: 40, V: 1e8 }), true)
    assert.equal(isConcentrated({ N: 41, V: 1e9 }), false)
    assert.equal(isConcentrated({ N: 10, V: 9.9e7 }), false)
})

test('firstPerKey keeps the earliest entry per key', () => {
    const out = firstPerKey([{ key: 'A|Q', day: '2026-08-14', n: 1 }, { key: 'A|Q', day: '2026-08-03', n: 2 }, { key: 'B|Q', day: '2026-08-05', n: 3 }])
    assert.deepEqual(out.map(t => t.n).sort(), [2, 3])
})

test('meanWithoutBest drops the best 1% (one at least from 20 values)', () => {
    const xs = [...Array.from({ length: 99 }, () => 0), 100]
    assert.equal(meanWithoutBest(xs), 0)
    assert.equal(meanWithoutBest([1, 2, 3]), 2)
    assert.equal(meanWithoutBest([]), null)
})

test('joinWindows: the older bars go in front, scaled at the last common day; a mismatch is listed', () => {
    const bar = (iso, close) => ({ timestamp: Date.parse(`${iso}T20:00:00Z`) / 1000, open: close, high: close, low: close, close, volume: 1 })
    const older = { names: { A: [bar('2023-01-03', 10), bar('2023-01-04', 20), bar('2023-01-05', 20)], B: [bar('2023-01-03', 5)] }, spy: [bar('2023-01-03', 400), bar('2023-01-04', 400)], bars_from: '2023-01-03' }
    // A split 2:1 between the two fetches: the newer cache has half the price on the common day.
    const newer = { names: { A: [bar('2023-01-04', 10), bar('2023-01-05', 10), bar('2023-01-06', 11)], C: [bar('2023-01-05', 7)] }, spy: [bar('2023-01-04', 400), bar('2023-01-05', 401)], bars_from: '2023-01-04' }
    const { raw, scaled, unmatched } = joinWindows(older, newer)
    assert.deepEqual(raw.names.A.map(b => b.close), [5, 10, 10, 11])
    assert.deepEqual(scaled.map(([s, r]) => [s, r]), [['A', 0.5]])
    assert.deepEqual(raw.names.B.map(b => b.close), [5])
    assert.deepEqual(raw.names.C.map(b => b.close), [7])
    assert.deepEqual(raw.spy.map(b => b.close), [400, 400, 401])
    assert.deepEqual(unmatched, [])
    assert.equal(raw.bars_from, '2023-01-03')
})
