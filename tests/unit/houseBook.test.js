import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { bookOf, closeOn, bookRow, bookRecord, houseBook, MARKS } from '../../services/houseBook.service.js'

// The Hotlist's Swing and Long term lists (Roy, 2026-10-24): the house's coverage by its target's horizon.

const TODAY = '2026-10-24'
const cov = (symbol, horizon, extra = {}) => ({ symbol, status: 'active', rating: 'buy',
    price_target: { value: 120, horizon, set_at: '2026-09-01T14:00:00Z', target_date: '2027-03-01' }, ...extra })
const bar = (day, close) => ({ timestamp: Date.parse(`${day}T04:00:00Z`) / 1000, close })

test('the book follows the target horizon: 3m / 6m swing, 12m / 18m / 24m long term, anything else out', () => {
    assert.deepEqual(['3m', '6m', '12m', '18m', '24m', '1m', undefined].map(h => bookOf(cov('X', h))), ['swing', 'swing', 'long_term', 'long_term', 'long_term', null, null])
})

test('the close on a date: that day, else the last before it', () => {
    const bars = [bar('2026-08-28', 98), bar('2026-08-31', 99), bar('2026-09-02', 101)]
    assert.equal(closeOn(bars, '2026-09-01'), 99, 'the 1st had no bar')
    assert.equal(closeOn(bars, '2026-09-02'), 101)
    assert.equal(closeOn([], '2026-09-02'), null)
})

test('a row: upside to the target, the move since it was set against SPY, and how far toward the target', () => {
    const r = bookRow(cov('AAA', '6m'), { close: 110, mark: { price: 100, spy: 500 }, spyNow: 510, today: TODAY, name: 'Alpha' })
    assert.deepEqual([r.upside_pct, r.since_set_pct, r.spy_since_pct, r.vs_spy, r.progress, r.state, r.days_left], [9.09, 10, 2, 8, 0.5, 'live', 128])
    assert.deepEqual(r.origin, { source: 'desk' })
    const chain = bookRow(cov('AAA', '6m'), { close: 110, today: TODAY, origin: { subject: 'Semiconductors', kind: 'industry', verdict: 'swing', argus: { why: 'leader', caution: 'cyclical' } } })
    assert.deepEqual(chain.origin, { source: 'pythia', subject: 'Semiconductors', kind: 'industry', verdict: 'swing', why: 'leader', caution: 'cyclical' })
    assert.equal(chain.since_set_pct, null, 'no set-day price yet: no move')
})

test('progress only toward a target well above the set price — a hold a hair over it, or a sell, has none', () => {
    const at = { price: 100, spy: 500 }
    assert.equal(bookRow(cov('A', '12m', { price_target: { value: 102, horizon: '12m' } }), { close: 90, mark: at, today: TODAY }).progress, null)
    assert.equal(bookRow(cov('A', '12m', { price_target: { value: 80, horizon: '12m' } }), { close: 90, mark: at, today: TODAY }).progress, null)
})

test("a row's state: the monitor's hit and broken, a passed target date expired, else live", () => {
    assert.equal(bookRow(cov('A', '6m', { status: 'target_hit' }), { today: TODAY }).state, 'hit')
    assert.equal(bookRow(cov('A', '6m', { status: 'thesis_broken' }), { today: TODAY }).state, 'broken')
    assert.equal(bookRow(cov('A', '3m', { price_target: { value: 1, horizon: '3m', target_date: '2026-10-01' } }), { today: TODAY }).state, 'expired')
})

test("a book's record: the settled and their hit rate, the live names' median move and how many beat SPY", () => {
    const rows = [{ state: 'hit', since_set_pct: 20, vs_spy: 15 }, { state: 'expired', since_set_pct: -5, vs_spy: -8 }, { state: 'broken', since_set_pct: -20, vs_spy: -22 },
        { state: 'live', since_set_pct: 4, vs_spy: 1 }, { state: 'live', since_set_pct: null, vs_spy: null }]
    assert.deepEqual(bookRecord(rows), { n: 5, live: 2, hit: 1, broken: 1, expired: 1, hit_rate: 33.33, priced: 4, median_since: -0.5, median_vs_spy: -3.5, beat_spy: 50 })
})

test('the book from the database: live coverage by book, the chain names first, set-day prices read once and kept', async () => {
    const { db, rows } = memDb()
    rows('coverage').push(cov('AAA', '6m'), cov('CHAIN', '12m'), cov('BIG', '12m', { price_target: { value: 500, horizon: '12m', set_at: '2026-09-01T14:00:00Z', target_date: '2027-09-01' } }),
        cov('GONE', '12m', { status: 'retired' }), cov('ODD', '1m'))
    rows('daily_screener_stats').push({ symbol: 'AAA', day: '2026-10-23', close: 110, name: 'Alpha' }, { symbol: 'CHAIN', day: '2026-10-23', close: 105 },
        { symbol: 'AAA', day: '2026-10-22', close: 1 })
    rows('research_queue').push({ symbol: 'CHAIN', source: 'pythia', status: 'done', updated_at: '2026-10-20', context: { subject: 'Rails', verdict: 'long_term', argus: { why: 'the leader' } } })
    const asked = []
    const deps = {
        db: async () => db, now: () => Date.parse(`${TODAY}T15:00:00Z`), price: async () => 510, awaitFill: true,
        bars: async (sym) => { asked.push(sym); return sym === 'SPY' ? [bar('2026-09-01', 500)] : sym === 'BIG' ? [bar('2026-10-23', 300)] : [bar('2026-09-01', 100)] },
    }
    const first = await houseBook({ deps })
    assert.equal(first.asof, '2026-10-23')
    assert.deepEqual(first.swing.map(r => r.symbol), ['AAA'])
    assert.deepEqual(first.long_term.map(r => r.symbol), ['CHAIN', 'BIG'], "the chain's name first; retired and off-book names out")
    assert.equal(first.long_term[0].origin.subject, 'Rails')
    // The test waits for the fill (awaitFill); a live read does not, and shows BIG without a price until the next.
    assert.equal(first.long_term[1].price, 300, 'BIG is outside the screener: its last daily close, read in the fill')
    const setDay = rows(MARKS).filter(m => !m.key.endsWith('|last'))
    assert.deepEqual(setDay.map(m => [m.symbol, m.price]).sort(), [['AAA', 100], ['BIG', null], ['CHAIN', 100]],
        'set-day prices kept, one per (symbol, set_at) — BIG had no bar that day: kept as a miss, tried again tomorrow')
    assert.deepEqual(rows(MARKS).filter(m => m.key.endsWith('|last')).map(m => [m.symbol, m.close, m.day]), [['BIG', 300, '2026-10-23']],
        "BIG's last close is kept in the database — a restart opens the book with it")
    const second = await houseBook({ deps })
    assert.equal(second.swing[0].since_set_pct, 10)
    assert.equal(second.swing[0].vs_spy, 8)
    assert.equal(second.long_term.find(r => r.symbol === 'BIG').price, 300, "its last daily close, read in the first read's fill")
    const reads = asked.length
    await houseBook({ deps })
    assert.equal(asked.length, reads, 'nothing read again: the marks are kept, the last close is fresh for an hour')
})
