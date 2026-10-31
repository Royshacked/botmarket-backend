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

// Roy, 2026-10-24: "hand off to Mentor — tell Mentor the horizon".
test('a book hand-off is a reference — which list — and the server reads the horizon off the coverage', async () => {
    const { sanitizeScanSeed } = await import('../../services/scanSeed.util.js')
    assert.deepEqual(sanitizeScanSeed({ ticker: 'chn', book: { column: 'long_term', horizon: 'intraday' } }).book, { column: 'long_term', symbol: 'CHN' })
    assert.equal(sanitizeScanSeed({ ticker: 'CHN', book: { column: 'week' } }).book, null)
    const { bookSeed, bookFacts } = await import('../../services/houseBook.service.js')
    const { db, rows } = memDb()
    rows('coverage').push({ symbol: 'CHN', status: 'active', rating: 'buy', conviction: { level: 'medium' }, thesis: 'Volumes recover into the cycle. More detail follows.',
        kill_criteria: ['volumes fall two quarters running'], price_target: { value: 130, horizon: '6m', target_date: '2027-03-01' } })
    rows('daily_screener_stats').push({ symbol: 'CHN', day: '2026-10-23', close: 100 })
    rows('research_queue').push({ symbol: 'CHN', source: 'pythia', status: 'done', updated_at: '2026-10-20', context: { subject: 'Railroads', verdict: 'swing', argus: { why: 'the leader' } } })
    // The request said long term; the coverage's 6m target makes it a SWING name.
    const s = await bookSeed({ column: 'long_term', symbol: 'CHN' }, { db: async () => db })
    assert.deepEqual([s.book, s.horizon], ['swing', 'swing'])
    assert.equal(s.book_facts, "Prometheus buy (medium conviction), target 130.00 by 2027-03-01 (a 6m target), +30.0% from 100.00; from the weekly chain: Pythia's swing call on Railroads")
    assert.equal(s.thesis, 'the leader')
    assert.equal(s.caution, 'volumes fall two quarters running')
    assert.equal(await bookSeed({ column: 'swing', symbol: 'NONE' }, { db: async () => db }), null)
    assert.match(bookFacts({ rating: 'hold', price_target: { value: 50, horizon: '12m' } }), /^Prometheus hold, target 50\.00 \(a 12m target\); researched at the desk$/)
})

test("Mentor's seed section says the book, the horizon (the user's to confirm), and what breaks it", async () => {
    const { _buildSeedSection } = await import('../../services/agents/mentor.agent.service.js')
    const text = _buildSeedSection({ ticker: 'CHN', direction: 'long', thesis: 'the leader', horizon: 'swing', book_name: 'swing',
        book_facts: 'Prometheus buy, target 130.00 by 2027-03-01 (a 6m target)', caution: 'volumes fall' })
    assert.match(text, /From the house's SWING book: Prometheus buy, target 130\.00 by 2027-03-01 \(a 6m target\)\. The horizon is swing — the user's to confirm\./)
    assert.match(text, /What would break the thesis: volumes fall/)
    assert.match(text, /not a take-profit/)
})

test("a book name's seed section is headed as the house's book, not as Argus's hand-off", async () => {
    const { _buildSeedSection } = await import('../../services/agents/mentor.agent.service.js')
    assert.match(_buildSeedSection({ ticker: 'CHN', book_name: 'swing', book_facts: 'Prometheus buy' }), /FROM THE HOUSE'S BOOK: CHN/)
    assert.match(_buildSeedSection({ ticker: 'SPCX' }), /ARGUS HANDED YOU THIS NAME: SPCX/)
})

// Roy, 2026-10-24: "Pythia brings the industry → Argus brings names from it → Prometheus analyses them and brings a
// thesis and PT — the survivors in the Hotlist". The book carries the chain's picks and where each stands.
test("the chain's picks per book: covered, passed (and why), waiting — newest row per name, the last eight weeks only", async () => {
    const { pickState, PICK_DAYS } = await import('../../services/houseBook.service.js')
    assert.equal(pickState({ status: 'done' }), 'covered')
    assert.equal(pickState({ status: 'rejected', reason: 'no_edge' }), 'passed')
    assert.equal(pickState({ status: 'rejected', reason: 'already_covered' }), 'already_covered')
    assert.equal(pickState({ status: 'in_research' }), 'waiting')
    const { db, rows } = memDb()
    const at = (d) => `${d}T10:00:00.000Z`
    const ctx = (verdict, extra = {}) => ({ subject: 'Rails', kind: 'industry', verdict, argus: { why: 'the leader', caution: 'freight' }, ...extra })
    rows('research_queue').push(
        { symbol: 'NEW', source: 'pythia', status: 'done', created_at: at('2026-10-20'), context: ctx('swing') },
        { symbol: 'NEW', source: 'pythia', status: 'rejected', reason: 'no_edge', created_at: at('2026-10-06'), context: ctx('swing') },
        { symbol: 'PSS', source: 'pythia', status: 'rejected', reason: 'horizon_off_book', created_at: at('2026-10-19'), context: ctx('swing') },
        { symbol: 'WAI', source: 'pythia', status: 'queued', created_at: at('2026-10-21'), context: ctx('long_term') },
        { symbol: 'OLD', source: 'pythia', status: 'done', created_at: at('2026-08-01'), context: ctx('swing') },
        { symbol: 'HOT', source: 'hotlist', status: 'done', created_at: at('2026-10-21'), context: ctx('swing') })
    const book = await houseBook({ deps: { db: async () => db, now: () => Date.parse(`${TODAY}T15:00:00Z`), price: async () => null, bars: async () => null } })
    assert.deepEqual(book.picks.swing.map(p => [p.symbol, p.state, p.reason]), [['NEW', 'covered', null], ['PSS', 'passed', 'horizon_off_book']],
        'the newest row per name; older than PICK_DAYS and the other sources out')
    assert.equal(PICK_DAYS, 56)
    assert.deepEqual(book.picks.long_term.map(p => [p.symbol, p.state]), [['WAI', 'waiting']])
    assert.equal(book.picks.swing[0].why, 'the leader')
    assert.equal(book.picks.swing[0].subject, 'Rails')
})

// Roy, 2026-10-28: "if a name is not relevant anymore to swing or long term — leave it only in covered companies".
test("still called: Pythia's verdict now on what sent the name — unknown is never 'no'", async () => {
    const { stillCalled } = await import('../../services/houseBook.service.js')
    const NOW = '2026-10-31T12:00:00Z'
    const verdicts = new Map([['ia_rails', { verdict: 'swing' }], ['ia_pc', { verdict: 'watch' }], ['ia_blank', null],
        ['ia_semis', { verdict: 'swing', long_term: { call: 'yes', reviewed_at: '2026-10-20T00:00:00Z' } }],
        ['ia_old', { verdict: 'no_case', long_term: { call: 'yes', reviewed_at: '2026-08-01T00:00:00Z' } }],
        ['ia_legacy', { verdict: 'long_term', thesis: 't', assessed_at: '2026-10-20T00:00:00Z' }]])
    assert.deepEqual(stillCalled({ assessment_id: 'ia_rails' }, 'swing', verdicts, NOW), { verdict_now: 'swing', still: true })
    assert.deepEqual(stillCalled({ assessment_id: 'ia_pc' }, 'swing', verdicts, NOW), { verdict_now: 'watch', still: false })
    assert.deepEqual(stillCalled({ assessment_id: 'ia_rails' }, 'long_term', verdicts, NOW), { verdict_now: 'not_long_term', still: false }, 'called, but for the other book')
    // Two verdicts (2026-10-31): the long-term book reads the long-term call, the swing book the near term — one industry can be both.
    assert.deepEqual(stillCalled({ assessment_id: 'ia_semis' }, 'long_term', verdicts, NOW), { verdict_now: 'long_term', still: true })
    assert.deepEqual(stillCalled({ assessment_id: 'ia_semis' }, 'swing', verdicts, NOW), { verdict_now: 'swing', still: true })
    assert.equal(stillCalled({ assessment_id: 'ia_old' }, 'long_term', verdicts, NOW).still, false, 'a yes past its 60 days')
    assert.equal(stillCalled({ assessment_id: 'ia_legacy' }, 'long_term', verdicts, NOW).still, true, 'an unmigrated long-term verdict')
    assert.deepEqual(stillCalled({ assessment_id: 'ia_legacy' }, 'swing', verdicts, NOW), { verdict_now: 'no_case', still: false })
    assert.deepEqual(stillCalled({ assessment_id: 'ia_gone' }, 'swing', verdicts), { verdict_now: null, still: null }, 'not found')
    assert.deepEqual(stillCalled({}, 'swing', verdicts), { verdict_now: null, still: null }, 'an old row with no id')
    assert.deepEqual(stillCalled({ assessment_id: 'ia_pc' }, 'swing', null), { verdict_now: null, still: null }, 'the read failed')
})

test('the book marks each chain name and pick with her verdict now; the name stays in the book', async () => {
    const { db, rows } = memDb()
    rows('coverage').push(cov('KEEP', '6m'), cov('DROP', '6m'))
    rows('research_queue').push(
        { symbol: 'KEEP', source: 'pythia', status: 'done', created_at: `${TODAY}T10:00:00.000Z`, updated_at: '2026-10-20', context: { subject: 'Rails', verdict: 'swing', assessment_id: 'ia_rails' } },
        { symbol: 'DROP', source: 'pythia', status: 'done', created_at: `${TODAY}T10:00:00.000Z`, updated_at: '2026-10-20', context: { subject: 'P&C', verdict: 'swing', assessment_id: 'ia_pc' } })
    rows('industry_assessment').push({ id: 'ia_rails', verdict: 'swing' }, { id: 'ia_pc', verdict: 'watch' })
    const book = await houseBook({ deps: { db: async () => db, now: () => Date.parse(`${TODAY}T15:00:00Z`), price: async () => null, bars: async () => null } })
    const by = Object.fromEntries(book.swing.map(r => [r.symbol, r.origin]))
    assert.deepEqual([by.KEEP.still, by.DROP.still, by.DROP.verdict_now], [true, false, 'watch'])
    assert.deepEqual(book.picks.swing.map(p => [p.symbol, p.still]).sort(), [['DROP', false], ['KEEP', true]])
    assert.equal(book.picks.swing[0].assessment_id, undefined, 'the id is not sent')
    assert.deepEqual(book.swing.map(r => [r.symbol, r.list]).sort(), [['DROP', 'left'], ['KEEP', 'on']])
    assert.equal(book.record.swing.n, 1, 'the record is the list\'s: the name that left is not in it')
})

// 2026-10-28: a target reached re-models the coverage, and the re-model sets a new target and the status back to
// active — the record read "no target has come due" for ever. The frozen calls keep the hit.
test('the record\'s hits and expiries come from the frozen calls: a hit the re-model moved past still counts', async () => {
    const { callsSettled, CALLS } = await import('../../services/houseBook.service.js')
    const { COLLECTION } = await import('../../services/prometheusCalls.service.js')
    assert.equal(CALLS, COLLECTION, 'the book reads the scorecard\'s own collection')
    const today = '2026-10-28T12:00:00.000Z'
    const calls = [
        { horizon: '3m', made_at: '2026-07-01T14:00:00.000Z', target_reached: { day: '2026-08-12' } },   // hit, then re-modelled
        { horizon: '3m', made_at: '2026-07-01T14:00:00.000Z', target_reached: null },                     // ran out
        { horizon: '6m', made_at: '2026-07-01T14:00:00.000Z', target_reached: null },                     // still running
    ]
    assert.deepEqual(callsSettled(calls, today), { hit: 1, expired: 1 })
    const rows = [{ state: 'live', vs_spy: 2, since_set_pct: 3 }, { state: 'broken', vs_spy: -4, since_set_pct: -6 }]
    const rec = bookRecord(rows, calls)
    assert.deepEqual([rec.hit, rec.expired, rec.broken], [1, 1, 1])
    assert.deepEqual([bookRecord(rows).hit, bookRecord(rows, null).expired], [0, 0], 'no calls read: the rows, as before')
})

test('the book\'s record reads the list\'s frozen calls on its horizons', async () => {
    const { db, rows } = memDb()
    rows('coverage').push(cov('HIT', '6m'))
    rows('research_queue').push({ symbol: 'HIT', source: 'pythia', status: 'done', created_at: `${TODAY}T10:00:00.000Z`, updated_at: '2026-10-20', context: { subject: 'Rails', verdict: 'swing' } })
    rows('prometheus_calls').push({ symbol: 'HIT', horizon: '6m', made_at: '2026-05-01T14:00:00.000Z', target_reached: { day: '2026-06-01' } },
        { symbol: 'HIT', horizon: '12m', made_at: '2026-05-01T14:00:00.000Z', target_reached: { day: '2026-06-01' } },   // another book's horizon
        { symbol: 'OFF', horizon: '6m', made_at: '2026-05-01T14:00:00.000Z', target_reached: { day: '2026-06-01' } })    // not on the list
    const book = await houseBook({ deps: { db: async () => db, now: () => Date.parse(`${TODAY}T15:00:00Z`), price: async () => null, bars: async () => null } })
    assert.equal(book.record.swing.hit, 1)
})

test('on the list: the chain\'s names and the picks it covered, while Pythia still calls them; the desk\'s never', async () => {
    const { listOf } = await import('../../services/houseBook.service.js')
    const picks = [{ symbol: 'PRE', state: 'already_covered', still: true }, { symbol: 'GON', state: 'already_covered', still: false },
        { symbol: 'PSS', state: 'passed', still: true }]
    assert.equal(listOf({ symbol: 'CHN', origin: { source: 'pythia', still: true } }, picks), 'on')
    assert.equal(listOf({ symbol: 'UNK', origin: { source: 'pythia', still: null } }, picks), 'on', 'unknown stays')
    assert.equal(listOf({ symbol: 'LFT', origin: { source: 'pythia', still: false } }, picks), 'left')
    assert.equal(listOf({ symbol: 'PRE', origin: { source: 'desk' } }, picks), 'on', 'picked, covered at the desk')
    assert.equal(listOf({ symbol: 'GON', origin: { source: 'desk' } }, picks), 'left')
    assert.equal(listOf({ symbol: 'PSS', origin: { source: 'desk' } }, picks), null, 'a pass is not a survivor')
    assert.equal(listOf({ symbol: 'DSK', origin: { source: 'desk' } }, picks), null)
})
