import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { weekOf, readable, dueRows, nameText, normalizeReads, runTiming, readsFor, _reset, COLLECTION, BATCH, BATCHES_PER_RUN, RETRY_MS }
    from '../../services/bookTiming.service.js'
import { timingOf } from '../../services/houseBook.service.js'

// Argus's timing read on the Swing / Long term lists (Roy, 2026-11-02: "Ask Argus" made automatic, re-read weekly).

const MON = Date.parse('2026-11-02T15:00:00Z')                 // a Monday, 10:00 ET
const row = (symbol, extra = {}) => ({ symbol, rating: 'buy', list: 'on', state: 'live', set_at: '2026-10-20T00:00:00Z',
    target: 120, upside_pct: 20, target_date: '2027-04-20', price: 100, origin: { source: 'pythia', why: 'the leader' }, ...extra })

beforeEach(() => _reset())

test('the week is its ET Monday — a Sunday belongs to the week before, Monday starts a new one', () => {
    assert.equal(weekOf(MON), '2026-11-02')
    assert.equal(weekOf(Date.parse('2026-11-08T20:00:00Z')), '2026-11-02', 'Sunday')
    assert.equal(weekOf(Date.parse('2026-11-03T03:00:00Z')), '2026-11-02', 'Monday 22:00 ET is still Monday')
    assert.equal(weekOf(Date.parse('2026-11-09T05:00:00Z')), '2026-11-09', 'Monday 00:00 ET')
})

test('read: the buys on a list, live — not a desk name, a name that left, a hold, a hit', () => {
    const book = { swing: [row('A'), row('B', { list: null }), row('C', { list: 'left' }), row('D', { rating: 'hold' })],
        long_term: [row('E', { rating: 'strong_buy' }), row('F', { state: 'hit' })] }
    assert.deepEqual(readable(book).map(r => `${r.symbol}:${r.book}`), ['A:swing', 'E:long_term'])
    assert.deepEqual(readable(null), [])
})

test('due: no read, last week\'s, or a target re-set since — not this week\'s on the same target', () => {
    const stored = new Map([
        ['B', { week: '2026-10-26', set_at: '2026-10-20T00:00:00Z' }],
        ['C', { week: '2026-11-02', set_at: '2026-10-01T00:00:00Z' }],
        ['D', { week: '2026-11-02', set_at: '2026-10-20T00:00:00Z' }],
    ])
    assert.deepEqual(dueRows(['A', 'B', 'C', 'D'].map(s => row(s)), stored, '2026-11-02').map(r => r.symbol), ['A', 'B', 'C'])
})

test('a name as the stock picker reads it: the thesis, what breaks it, the chart and its levels in dollars, the report', () => {
    const t = nameText({ ...row('ABC', { name: 'Alpha' }), book: 'swing' }, { kill_criteria: ['margins fall below 20%'] },
        { close: 50, sma20: 48, sma50: 45, low20: 46, high20: 51, low52w: 30, high52w: 52, atr_pct: 2.5, ret5: 3, ret20: 8, rs5: 1, rs20: 4, vol5_vs_50: 1.4, next_earnings: '2026-11-06' })
    for (const bit of ['ABC (Alpha) — SWING', 'the analyst buy', 'target 120.00 by 2027-04-20', '+20.0% from here', 'thesis: the leader',
        'wrong if: margins fall below 20%', 'trend over 20d · over 50d', '50d avg 45.00', '20d range 46.00–51.00', 'ATR 2.5%', 'next report 2026-11-06']) {
        assert.ok(t.includes(bit), `missing "${bit}" in ${t}`)
    }
    assert.ok(nameText({ ...row('X'), book: 'long_term' }, null, null).includes('levels: no chart today'))
    // A report already out (the stats lag it) is not shown — Argus waited for a past date once.
    const stats = { close: 50, next_earnings: '2026-10-30' }
    assert.ok(!nameText({ ...row('X'), book: 'swing' }, null, stats, { today: '2026-11-02' }).includes('next report'))
    assert.ok(nameText({ ...row('X'), book: 'swing' }, null, { ...stats, next_earnings: '2026-11-02' }, { today: '2026-11-02' }).includes('next report 2026-11-02'), 'today still ahead')
})

test('the reply is held to the names asked: a known symbol, now or wait, a wait names what it waits for', () => {
    const reads = normalizeReads({ reads: [
        { symbol: 'abc', verdict: 'NOW', wait_for: 'ignored', wrong_if: 'loses 45', why: 'a base' },
        { symbol: 'DEF', verdict: 'wait', wait_for: 'a pullback to 41.20', wrong_if: 'runs past 50', why: 'stretched' },
        { symbol: 'GHI', verdict: 'wait', wait_for: '  ' },
        { symbol: 'ZZZ', verdict: 'now' },
        { symbol: 'JKL', verdict: 'maybe' },
        { symbol: 'ABC', verdict: 'wait', wait_for: 'a repeat' },
    ] }, ['ABC', 'DEF', 'GHI', 'JKL'])
    assert.deepEqual([...reads.keys()], ['ABC', 'DEF'])
    assert.deepEqual(reads.get('ABC'), { verdict: 'now', wait_for: null, wrong_if: 'loses 45', why: 'a base' })
    assert.equal(reads.get('DEF').wait_for, 'a pullback to 41.20')
    // It reads after "Wait — for": a sentence's capital is lowered, a ticker's case kept.
    const cased = normalizeReads({ reads: [{ symbol: 'A', verdict: 'wait', wait_for: 'A pullback to 41.20' }, { symbol: 'B', verdict: 'wait', wait_for: 'SPY to hold 500' }] }, ['A', 'B'])
    assert.deepEqual([cased.get('A').wait_for, cased.get('B').wait_for], ['a pullback to 41.20', 'SPY to hold 500'])
    assert.equal(normalizeReads(null, ['A']).size, 0)
})

function harness({ rows, reply, now = MON, chartless = [] } = {}) {
    const { db, rows: memRows } = memDb()
    // Last night's chart for every name but the chartless ones.
    memRows('daily_screener_stats').push(...rows.filter(r => !chartless.includes(r.symbol)).map(r => ({ symbol: r.symbol, day: '2026-10-30', close: 100, sma20: 95, sma50: 90 })))
    const sent = [], booked = []
    let clock = now
    const deps = {
        db: async () => db,
        book: async () => ({ swing: rows, long_term: [] }),
        enabled: () => true,
        send: async (args) => { sent.push(args); args.onUsage?.({ input_tokens: 10, output_tokens: 5 }); return typeof reply === 'function' ? reply(args) : reply },
        model: async () => 'house-model',
        costOf: () => 0.01,
        ledger: async () => 'roy',
        record: async (...a) => { booked.push(a) },
        now: () => clock,
    }
    return { db, rows: memRows, deps, sent, booked, tick: (ms) => { clock += ms } }
}
const answerAll = (args) => JSON.stringify({ reads: [...args.userText.matchAll(/^([A-Z]+) — /gm)].map(m => ({ symbol: m[1], verdict: 'now', wrong_if: 'w', why: 'y' })) })

test('a run reads the due names in batches, stores one read per symbol, books the spend to the house ledger', async () => {
    const rows = Array.from({ length: BATCH * BATCHES_PER_RUN + 3 }, (_, i) => row(`S${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`))
    const h = harness({ rows, reply: answerAll })
    const r = await runTiming({ deps: h.deps })
    assert.deepEqual([r.outcome, r.week, r.due, r.read], ['done', '2026-11-02', rows.length, BATCH * BATCHES_PER_RUN])
    assert.equal(h.sent.length, BATCHES_PER_RUN, 'the rest wait for the next run')
    assert.equal(h.sent[0].model, 'house-model')
    assert.deepEqual(h.booked[0], ['roy', 'house-model', { input_tokens: 10, output_tokens: 5 }])
    const stored = h.rows(COLLECTION)
    assert.equal(stored.length, BATCH * BATCHES_PER_RUN)
    assert.deepEqual(Object.keys(stored[0]).filter(k => k !== '_id').sort(),
        ['book', 'model', 'price', 'price_day', 'read_at', 'set_at', 'symbol', 'verdict', 'wait_for', 'week', 'why', 'wrong_if'])

    // Within CHECK_EVERY_MS: not looked at. After it: the 3 left, and then nothing until next week.
    assert.equal((await runTiming({ deps: h.deps })).outcome, 'not_due')
    h.tick(31 * 60_000)
    assert.equal((await runTiming({ deps: h.deps })).read, 3)
    h.tick(31 * 60_000)
    assert.deepEqual([(await runTiming({ deps: h.deps })).due, h.sent.length], [0, BATCHES_PER_RUN + 1])
    h.tick(7 * 86_400_000)
    assert.equal((await runTiming({ deps: h.deps })).week, '2026-11-09')
})

test('a failed batch, or a name the reply leaves out, is tried again after RETRY_MS — not every tick', async () => {
    let fail = true
    const h = harness({ rows: [row('AAA'), row('BBB')], reply: (args) => {
        if (fail) throw new Error('model down')
        return JSON.stringify({ reads: [{ symbol: 'AAA', verdict: 'now', why: 'y' }] })
    } })
    assert.deepEqual([(await runTiming({ deps: h.deps })).read, h.sent.length], [0, 1])
    h.tick(31 * 60_000)
    assert.deepEqual([(await runTiming({ deps: h.deps })).due, h.sent.length], [0, 1], 'not asked again yet')
    fail = false
    h.tick(RETRY_MS)
    assert.equal((await runTiming({ deps: h.deps })).read, 1)
    h.tick(31 * 60_000)
    assert.deepEqual([(await runTiming({ deps: h.deps })).due, h.sent.length], [0, 2], 'BBB was left out — waits RETRY_MS too')
})

test('a name with no chart tonight is not read — no "wait for a chart" — and is tried again later', async () => {
    const h = harness({ rows: [row('AAA'), row('NOC')], reply: answerAll, chartless: ['NOC'] })
    const r = await runTiming({ deps: h.deps })
    assert.equal(r.read, 1)
    assert.ok(!h.sent[0].userText.includes('NOC'), 'not sent to the stock picker')
    assert.deepEqual(h.rows(COLLECTION).map(d => d.symbol), ['AAA'])
    _reset()
    const alone = harness({ rows: [row('NOC')], reply: answerAll, chartless: ['NOC'] })
    assert.deepEqual([(await runTiming({ deps: alone.deps })).read, alone.sent.length], [0, 0], 'no call at all')
})

test('off with BOOK_TIMING=false; a failing book read is an error result, never a throw', async () => {
    const h = harness({ rows: [row('AAA')], reply: answerAll })
    assert.equal((await runTiming({ deps: { ...h.deps, enabled: () => false } })).outcome, 'off')
    const r = await runTiming({ deps: { ...h.deps, book: async () => { throw new Error('db down') } } })
    assert.deepEqual([r.outcome, r.error], ['error', 'db down'])
})

test('the row shows the read only against the target it was made for', async () => {
    const h = harness({ rows: [row('AAA')], reply: answerAll })
    await runTiming({ deps: h.deps })
    const reads = await readsFor(['AAA', 'NONE'], h.deps)
    assert.deepEqual([...reads.keys()], ['AAA'])
    const read = reads.get('AAA')
    assert.deepEqual(timingOf(row('AAA'), read), { verdict: 'now', wait_for: null, wrong_if: 'w', why: 'y', week: '2026-11-02', read_at: read.read_at, price: 100 })
    assert.equal(timingOf(row('AAA', { set_at: '2026-11-01T00:00:00Z' }), read), null, 'The analyst re-set the target since')
    assert.equal(timingOf(row('AAA'), null), null)
})
