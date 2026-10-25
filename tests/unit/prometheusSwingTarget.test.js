import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { _parseCatalystRead, _cleanOwnTarget, _cleanCompany, MODES, _buildSystemPrompt } from '../../services/agents/analyst.agent.service.js'
import { buildCatalystRead, ownTarget, readFacts, catalystReadService, _setDeps as setReadDeps } from '../../services/catalystRead.service.js'
import { hotlistSeed } from '../../services/hotlist.service.js'
import { BOARDS } from '../../services/hotlist.boards.js'

// THE WEEK'S TARGET IS PROMETHEUS'S (Roy, 2026-10-24: "Prometheus should analyze the catalyst and company and decide of a
// short-term swing PT"): he reads the catalyst AND the company and sets the price; the tools' number is his yardstick;
// the trade's rules still hold whoever set it; Mentor is handed it on a week name.

const NOW = Date.parse('2026-10-23T13:40:00Z')
const RUNUP = { report: '2026-10-30', median_pct: 3, p25_pct: 1, p75_pct: 5, n: 8, up_share: 0.75 }
const BLOCK = (over = {}) => `Read.\n<catalyst_read>\n${JSON.stringify({
    ticker: 'abc', verdict: 'credible', window_days: 10, confidence: 0.7, read: 'Run-up into the 30th.',
    runup: RUNUP, target: { price: 104.5, low: 103, high: 106, why: 'the run-up yardstick is +3%; estimates rising, I take +4.5%' },
    company: { verdict: 'sound', why: 'revenue +12%, net cash' }, kill: ['guidance cut'], ...over,
})}\n</catalyst_read>`

test('the block carries his target and the company, checked: a bad price is no target, a broken band is dropped', () => {
    const p = _parseCatalystRead(BLOCK())
    assert.deepEqual(p.target, { price: 104.5, low: 103, high: 106, why: 'the run-up yardstick is +3%; estimates rising, I take +4.5%' })
    assert.deepEqual(p.company, { verdict: 'sound', why: 'revenue +12%, net cash' })
    assert.equal(_cleanOwnTarget({ price: 'soon' }), null)
    assert.equal(_cleanOwnTarget({ price: -3 }), null)
    assert.deepEqual(_cleanOwnTarget({ price: 50, low: 52, high: 55 }), { price: 50, low: null, high: null, why: null }, 'a band that does not hold the price is no band')
    assert.equal(_cleanCompany({ verdict: 'great' }), null, 'a word outside sound / weak / broken is unchecked')
    assert.equal(_parseCatalystRead(BLOCK({ target: undefined, company: undefined })).target, null)
})

test('his number is the target, measured from the read\'s price; the tools\' line rides beside it as the yardstick', () => {
    const r = buildCatalystRead(_parseCatalystRead(BLOCK()), { symbol: 'ABC', spot: 100, nowMs: NOW })
    assert.equal(r.status, 'active')
    assert.equal(r.target.value, 104.5)
    assert.equal(r.target.basis, 'prometheus')
    assert.equal(r.target.open_pct, 4.5)
    assert.deepEqual(r.target.yardstick, { value: 103, open_pct: 3, basis: 'run_up' })
    assert.equal(r.target.why, 'the run-up yardstick is +3%; estimates rising, I take +4.5%')
    assert.equal(r.company.verdict, 'sound')
    assert.equal(r.valid_until, '2026-10-29T21:00:00.000Z', 'still out before the report')
})

test('no number of his is a pass — never the yardstick in his place (code review 2026-10-24)', () => {
    const r = buildCatalystRead(_parseCatalystRead(BLOCK({ target: null })), { symbol: 'ABC', spot: 100, nowMs: NOW })
    assert.deepEqual([r.status, r.pass_reason, r.target], ['pass', 'no_target', null])
    assert.equal(readFacts(r), null, 'and Mentor is handed nothing to build on')
})

test("a target far past the options' implied move and the yardstick is flagged a stretch — shown, never blocked", async () => {
    const { STRETCH_X } = await import('../../services/catalystRead.service.js')
    assert.equal(STRETCH_X, 3)
    const far = buildCatalystRead(_parseCatalystRead(BLOCK({ target: { price: 125 }, implied_move_pct: 6 })), { symbol: 'ABC', spot: 100, nowMs: NOW })
    assert.equal(far.status, 'active')
    assert.deepEqual(far.target.stretch, { ref_pct: 6, times: 4.17 }, '+25% against the larger of a 6% implied move and the +3% yardstick')
    assert.match(readFacts(far), /a STRETCH — 4\.17× the larger of the options' implied move and the yardstick \(\+6\.0%\)/)
    assert.equal(buildCatalystRead(_parseCatalystRead(BLOCK({ implied_move_pct: 6 })), { symbol: 'ABC', spot: 100, nowMs: NOW }).target.stretch, undefined, '+4.5% is no stretch')
})

test("the out-by date is the window's ET session date, not its UTC date", () => {
    const evening = Date.parse('2026-10-23T23:30:00Z')   // 19:30 ET — a 5-day window ends 2026-10-28T23:30Z, still the 28th in ET
    const r = buildCatalystRead(_parseCatalystRead(BLOCK({ runup: undefined, window_days: 5, delta: { delta_price_pct: 6, spot: 100, moved_pct: 0 } })), { symbol: 'ABC', spot: 100, nowMs: evening })
    assert.equal(r.valid_until, '2026-10-28T23:30:00.000Z')
    assert.match(readFacts(r), / by 2026-10-28/)
    const late = buildCatalystRead(_parseCatalystRead(BLOCK({ runup: undefined, window_days: 5, delta: { delta_price_pct: 6, spot: 100, moved_pct: 0 } })), { symbol: 'ABC', spot: 100, nowMs: Date.parse('2026-10-24T02:30:00Z') })
    assert.match(readFacts(late), / by 2026-10-28/, '22:30 ET on the 23rd: a UTC date would have said the 29th')
})

test('the trade\'s rules hold over his number: a broken company, too little open, at or under the price, a run-up already run', () => {
    const at = (over) => buildCatalystRead(_parseCatalystRead(BLOCK(over)), { symbol: 'ABC', spot: 100, nowMs: NOW, context: { atr_pct: 3 } })
    const broken = at({ company: { verdict: 'broken', why: 'S-3 filed, 4 months of cash' } })
    assert.equal(broken.status, 'pass')
    assert.equal(broken.pass_reason, 'company')
    assert.equal(at({ target: { price: 101.2 } }).pass_reason, 'too_small', 'under half the 3% daily range')
    assert.equal(at({ target: { price: 99 } }).pass_reason, 'nothing_open')
    assert.equal(at({ runup: { ...RUNUP, full_median_pct: 4, so_far_pct: 4.5 } }).pass_reason, 'already_ran')
    assert.equal(at({ verdict: 'contradicted' }).target, null, 'a target on a contradicted read is not taken')
    assert.equal(at({ company: { verdict: 'weak', why: 'a loss-maker' } }).status, 'active', 'weak carries it; the why says what holds it down')
})

test('ownTarget: nothing to measure from is no target', () => {
    assert.equal(ownTarget({ price: 10 }, null), null)
    assert.equal(ownTarget(null, 10), null)
})

test('his target is priced off a fresh quote, even when the read also carries a delta and its spot', async () => {
    const { db } = memDb()
    setReadDeps({ db: async () => db, now: () => NOW, price: async (s) => (s === 'SPY' ? 500 : 98), bars: async () => null })
    const parsed = _parseCatalystRead(BLOCK({ runup: undefined, delta: { delta_price_pct: 6, spot: 90, moved_pct: 1, remaining_pct: 5 } }))
    const saved = await catalystReadService.saveRead(parsed, { symbol: 'ABC' })
    assert.equal(saved.ok, true)
    assert.equal(saved.doc.target.spot, 98)
    assert.equal(saved.doc.target.open_pct, 6.63)
    assert.equal(saved.doc.target.yardstick.basis, 'event')
    assert.equal((await catalystReadService.liveRead('abc')).id, saved.doc.id, 'the live read, by symbol')
})

test('the read as Mentor hears it: his target, the window, the yardstick, the company, the kill', () => {
    const r = buildCatalystRead(_parseCatalystRead(BLOCK()), { symbol: 'ABC', spot: 100, nowMs: NOW, context: { exit_before: '2026-10-30' } })
    const line = readFacts(r)
    assert.match(line, /^Prometheus \(credible, 0\.7\): target 104\.50 \(band 103\.00–106\.00\), \+4\.5% from 100\.00 by 2026-10-29 — out before the report 2026-10-30/)
    assert.match(line, /his own number, the run-up yardstick \+3\.0%: the run-up yardstick is \+3%/)
    assert.match(line, /company sound — revenue \+12%, net cash; kill: guidance cut$/)
    assert.equal(readFacts({ status: 'pass', target: null }), null)
})

test('a week hand-off carries his live read; a day column, or a failed read, goes on without it', async () => {
    const { db, rows } = memDb()
    rows(BOARDS).push({ id: 'hb_2026-10-23_preopen', day: '2026-10-23', checkpoint: 'preopen', status: 'done', unverified_columns: [],
        rows: [{ symbol: 'ABC', cells: { open: { grade: 'A', range: { open_sky: true } }, week: { grade: 'B', range: { pct: 4, atr_mult: 1, level: 105 } } } }] })
    const read = buildCatalystRead(_parseCatalystRead(BLOCK()), { symbol: 'ABC', spot: 100, nowMs: NOW })
    const ref = (column) => ({ board: 'hb_2026-10-23_preopen', column, symbol: 'ABC' })
    const week = await hotlistSeed(ref('week'), { db: async () => db, liveRead: async () => read })
    assert.match(week.catalyst_facts, /^Prometheus \(credible/)
    assert.equal((await hotlistSeed(ref('open'), { db: async () => db, liveRead: async () => read })).catalyst_facts, null)
    assert.equal((await hotlistSeed(ref('week'), { db: async () => db, liveRead: async () => { throw new Error('down') } })).catalyst_facts, null)
    assert.equal((await hotlistSeed(ref('week'), { db: async () => db, liveRead: () => { throw new Error('sync') } })).catalyst_facts, null)
})

test('the catalyst mode asks for the company and his own target', () => {
    const p = _buildSystemPrompt({}, null, null, MODES.CATALYST).map(b => b.text).join('\n')
    assert.match(p, /get_fundamentals` ONCE/)
    assert.match(p, /YOUR SHORT-SWING PRICE TARGET/)
    assert.match(p, /"company": \{ "verdict": "sound" \| "weak" \| "broken"/)
})
