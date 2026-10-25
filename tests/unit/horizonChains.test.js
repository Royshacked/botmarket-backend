import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { normalizeRead, MAX_PICKS } from '../../services/hotlist.argus.js'
import { dayList, hotlistSeed } from '../../services/hotlist.service.js'
import { BOARDS } from '../../services/hotlist.boards.js'
import { _parseCatalystRead, MODES, _buildSystemPrompt } from '../../services/agents/analyst.agent.service.js'
import { catalystTarget, buildCatalystRead, gradeCatalystRead } from '../../services/catalystRead.service.js'
import { startRun, getRun, researchOpening, isCatalystItem } from '../../services/researchRun.service.js'
import { weekPicks, hotlistContext, queueWeekPicks, afterCheckpoint, resume, dayStart } from '../../services/hotlistResearch.service.js'
import { _tick, _resetGrade } from '../../monitoring/dailyScreener.monitor.service.js'

// The horizon chains (docs/design/horizon-chains.md; Roy, 2026-10-23): every horizon automatic, the Hotlist a list per
// horizon. §2 — Argus picks PER COLUMN.

const row = (symbol, cols) => ({ symbol, cells: Object.fromEntries(cols.map(c => [c, { grade: 'B', range: { atr_mult: 1 } }])) })

test('Argus picks per column: each column capped on its own, a name can be a pick on two columns', () => {
    const rows = [...Array.from({ length: 12 }, (_, i) => row(`O${i}`, ['open'])), ...Array.from({ length: 12 }, (_, i) => row(`W${i}`, ['week'])), row('BOTH', ['open', 'week'])]
    const raw = { picks: [
        { symbol: 'BOTH', column: 'open', why: 'gap' }, { symbol: 'BOTH', column: 'week', why: 'drift' }, { symbol: 'BOTH', column: 'week', why: 'repeat' },
        ...rows.filter(r => r.symbol !== 'BOTH').map(r => ({ symbol: r.symbol, column: Object.keys(r.cells)[0], why: 'x' })),
    ] }
    const r = normalizeRead(raw, { rows })
    const by = (c) => r.picks.filter(p => p.column === c).map(p => p.symbol)
    assert.equal(by('open').length, MAX_PICKS)
    assert.equal(by('week').length, MAX_PICKS)
    assert.equal(by('open')[0], 'BOTH')
    assert.equal(by('week')[0], 'BOTH')
    assert.equal(r.picks.filter(p => p.symbol === 'BOTH' && p.column === 'week').length, 1, 'a repeat on the same column goes')
})

test('the day\'s list: a column\'s pick comes from the latest board that graded it', () => {
    const b1 = { id: 'hb_d_preopen', checkpoint: 'preopen', rows: [{ symbol: 'X', cells: { open: { grade: 'A' }, week: { grade: 'B' } },
        pick: { symbol: 'X', column: 'open' }, picks: { open: { why: 'open trade', rank: 1 }, week: { why: 'week trade', rank: 1 } } }] }
    // 10:30 grades mid only and picks it — the open and week picks stand.
    const b2 = { id: 'hb_d_mid', checkpoint: 'mid', rows: [{ symbol: 'X', cells: { mid: { grade: 'B' } }, picks: { mid: { why: 'mid trade', rank: 2 } } }] }
    let [x] = dayList([b1, b2])
    assert.deepEqual(Object.keys(x.picks).sort(), ['mid', 'open', 'week'])
    // A later board that grades the week again WITHOUT picking it takes the week pick back.
    const b3 = { id: 'hb_d_close', checkpoint: 'close', rows: [{ symbol: 'X', cells: { week: { grade: 'C' } } }] }
    ;[x] = dayList([b1, b2, b3])
    assert.equal(x.picks.week, undefined)
    assert.equal(x.picks.open.why, 'open trade')
})

test('the Mentor hand-off carries Argus\'s reason for THAT column', async () => {
    const { db, rows } = memDb()
    rows(BOARDS).push({ id: 'hb_2026-10-21_preopen', day: '2026-10-21', checkpoint: 'preopen', status: 'done', unverified_columns: [],
        rows: [{ symbol: 'X', cells: { open: { grade: 'A', range: { open_sky: true } }, week: { grade: 'B', range: { pct: 4, atr_mult: 1, level: 50 } } },
            pick: { symbol: 'X', column: 'open', why: 'open why' }, picks: { open: { why: 'open why' }, week: { why: 'week why', caution: 'week caution' } } }] })
    const seed = await hotlistSeed({ board: 'hb_2026-10-21_preopen', column: 'week', symbol: 'X' }, { db: async () => db })
    assert.equal(seed.thesis, 'week why')
    assert.equal(seed.caution, 'week caution')
    assert.equal(seed.horizon, 'short term swing')
})

// ─── §3 the catalyst read ───────────────────────────────────────────────────

const DELTA = { delta_price_pct: 8, delta_price_low: 5, delta_price_high: 11, spot: 100, moved_pct: 3, remaining_pct: 5 }
const BLOCK = (over = {}) => `The read.\n<catalyst_read>\n${JSON.stringify({
    ticker: 'abc', verdict: 'credible', catalyst: { what: 'a contract', date: '2026-10-21', kind: 'contract', material: true },
    news_driven: true, window_days: 50, confidence: 1.4, read: 'Worth +8%, moved +3%.', delta: DELTA, delta_basis: '12% of revenue',
    implied_move_pct: 9, history: 'drifted after the last two wins', positioning: '8% short, 3 days to cover',
    event_risk: ['Q3 report 2026-10-29 — out before it'], kill: ['the contract is cut'], evidence: [{ fact: '8-K names it', source: '8-K' }, { nofact: 1 }],
    // His own target (2026-10-24) — the delta above is its yardstick.
    target: { price: 105, why: 'the delta leaves +5% open' },
    ...over })}\n</catalyst_read>`

test('the catalyst block is checked, not trusted: window clamped to 30, confidence to 1, a stray verdict is unclear', () => {
    const r = _parseCatalystRead(BLOCK())
    assert.equal(r.ticker, 'ABC')
    assert.equal(r.window_days, 30)
    assert.equal(r.confidence, 1)
    assert.equal(r.catalyst.kind, 'contract')
    assert.equal(r.evidence.length, 1)
    assert.equal(r.delta.remaining_pct, 5)
    assert.equal(_parseCatalystRead(BLOCK({ verdict: 'buy it' })).verdict, 'unclear')
    assert.equal(_parseCatalystRead('no block'), null)
})

test('catalyst mode adds its own block to the prompt and nothing else', () => {
    const coverage = _buildSystemPrompt({}, null, null, MODES.COVERAGE)
    const catalyst = _buildSystemPrompt({}, null, null, MODES.CATALYST)
    assert.equal(catalyst.length, coverage.length + 1)
    assert.match(catalyst[1].text, /CATALYST READ MODE/)
    assert.equal(catalyst[0].text, coverage[0].text, 'the spine (and its cache) is the same')
})

test("the target: spot plus what is still open; the band off the delta's low and high; the share already priced", () => {
    const t = catalystTarget(DELTA, 100)
    assert.deepEqual([t.value, t.low, t.high, t.open_pct, t.priced_share], [105, 102, 108, 5, 0.38])
    // No move measured: the whole delta is open.
    assert.equal(catalystTarget({ delta_price_pct: 8 }, 50).value, 54)
    assert.equal(catalystTarget({ delta_price_pct: null }, 50), null)
    assert.equal(catalystTarget(DELTA, 0), null)
})

test('a read: a target on credible / priced in; a pass (no target) on contradicted or unsized; dated by its window', () => {
    const now = Date.parse('2026-10-23T14:00:00Z')
    const live = buildCatalystRead(_parseCatalystRead(BLOCK({ window_days: 10 })), { symbol: 'ABC', spy: 500, nowMs: now })
    assert.equal(live.status, 'active')
    assert.equal(live.target.value, 105)
    assert.equal(live.valid_until, '2026-11-02T14:00:00.000Z')
    assert.equal(live.price_at_read, 100, "the tool's spot when there was no other")
    const pass = buildCatalystRead(_parseCatalystRead(BLOCK({ verdict: 'contradicted', delta: null })), { symbol: 'ABC', nowMs: now })
    assert.equal(pass.status, 'pass')
    assert.equal(pass.target, null)
})

test('graded: a hit the day the target is reached; otherwise expired at the window, with its return against SPY', () => {
    const now = Date.parse('2026-10-23T14:00:00Z')
    const read = buildCatalystRead(_parseCatalystRead(BLOCK({ window_days: 10 })), { symbol: 'ABC', spy: 500, nowMs: now })
    assert.equal(gradeCatalystRead(read, { price: 103, spy: 505, nowMs: now + 86_400_000 }), null, 'neither yet')
    const hit = gradeCatalystRead(read, { price: 105.5, spy: 505, nowMs: now + 2 * 86_400_000 })
    assert.equal(hit.status, 'hit')
    assert.deepEqual([hit.outcome.return_pct, hit.outcome.spy_return_pct, hit.outcome.vs_spy], [5.5, 1, 4.5])
    // Past the window, the window's own bars grade it: its high never reached the target, its last close is the return.
    const exp = gradeCatalystRead(read, { price: 120, spy: 510, nowMs: Date.parse(read.valid_until), window: { high: 104, close: 99, spy_close: 510 } })
    assert.equal(exp.status, 'expired')
    assert.equal(exp.outcome.hit, false)
    assert.equal(gradeCatalystRead({ ...read, status: 'pass' }, { price: 200, nowMs: now }), null)
})

// ─── §3-§4 the research run, on a Hotlist row ───────────────────────────────

async function settled() {
    for (let i = 0; i < 50; i++) { await new Promise(r => setImmediate(r)); if (getRun()?.status !== 'running') return getRun() }
    throw new Error('run never settled')
}
const HOT = (symbol) => ({ id: `rq_${symbol}`, symbol, source: 'hotlist', context: { hotlist: true, day: '2026-10-23', why: 'drift after the beat', caution: 'report inside', facts: 'this week (2–10 days) B' } })

test('a Hotlist row is read in CATALYST mode, saved as a read, never as coverage — and a covered name still gets one', async () => {
    const saved = [], asked = [], done = []
    await startRun({ userId: null, symbols: ['COV', 'NEW'] }, {
        listQueue: async () => [HOT('COV'), HOT('NEW')],
        coveredSymbols: async () => new Set(['COV']),
        liveCatalystSymbols: async () => new Set(),
        startResearch: async () => ({ ok: true }), markDone: async (id) => { done.push(id); return { ok: true } },
        reject: async () => ({ ok: true }), annotate: async () => ({ ok: true }),
        research: async ({ symbol, mode, opening }) => { asked.push([symbol, mode, opening]); return { reply: 'r', catalyst: _parseCatalystRead(BLOCK({ ticker: symbol })) } },
        saveCatalyst: async (parsed, opts) => { saved.push(opts.symbol); return { ok: true, doc: { id: `cr_${opts.symbol}`, status: 'active' } } },
        initiate: async () => { throw new Error('a catalyst read must never initiate coverage') },
        costOf: () => 0, houseLedger: async () => null, book: async () => {},
    })
    const run = await settled()
    assert.deepEqual(asked.map(a => [a[0], a[1]]), [['COV', 'catalyst'], ['NEW', 'catalyst']])
    assert.match(asked[0][2], /^Catalyst read on COV — the Hotlist graded it THIS WEEK.*Argus picked it: drift after the beat/)
    assert.deepEqual(saved, ['COV', 'NEW'])
    assert.deepEqual(done, ['rq_COV', 'rq_NEW'])
    assert.equal(run.read, 2)
})

test('a name with a LIVE read is skipped; a read with no target is a pass', async () => {
    const rejected = []
    await startRun({ userId: null, symbols: ['LIVE', 'THIN'] }, {
        listQueue: async () => [HOT('LIVE'), HOT('THIN')],
        coveredSymbols: async () => new Set(), liveCatalystSymbols: async () => new Set(['LIVE']),
        startResearch: async () => ({ ok: true }), markDone: async () => ({ ok: true }),
        reject: async (id, reason) => { rejected.push([id, reason]); return { ok: true } }, annotate: async () => ({ ok: true }),
        research: async () => ({ catalyst: _parseCatalystRead(BLOCK({ verdict: 'unclear', delta: null })) }),
        saveCatalyst: async () => ({ ok: true, doc: { id: 'cr', status: 'pass', verdict: 'unclear' } }),
        costOf: () => 0, houseLedger: async () => null, book: async () => {},
    })
    const run = await settled()
    assert.deepEqual(rejected, [['rq_LIVE', 'live_read']])
    assert.deepEqual(run.results.map(r => [r.symbol, r.outcome, r.reason]), [['LIVE', 'skipped', 'live_read'], ['THIN', 'passed', 'unclear']])
    assert.equal(isCatalystItem({ context: { pythia: true } }), false)
    assert.doesNotMatch(researchOpening({ symbol: 'X', context: { sector: 'Tech' } }), /Catalyst/)
    // The overnight board's names were listed by the run-up rule — the opening says so, never "Argus picked it".
    const rule = researchOpening({ symbol: 'R', context: { hotlist: true, day: '2026-10-26', rule: true, facts: 'run-up rule: reports 2026-11-02' } })
    assert.match(rule, /The run-up rule listed it/)
    assert.doesNotMatch(rule, /Argus picked it/)
    assert.match(researchOpening({ symbol: 'R', context: { hotlist: true, rule: true, requested: true } }), /A user asked for this read now/)
})

// ─── §4 the automatic hand-off ──────────────────────────────────────────────

const HBOARD = {
    id: 'hb_2026-10-23_preopen', day: '2026-10-23', checkpoint: 'preopen', rows: [
        { symbol: 'TWO', cells: { week: { grade: 'B', range: { pct: 3, atr_mult: 1, level: 10 } } }, picks: { week: { why: 'second', rank: 2 } } },
        { symbol: 'ONE', cells: { week: { grade: 'A', range: { open_sky: true } } }, picks: { week: { why: 'first', caution: 'c', rank: 1 } }, catalyst: { type: 'drift', material: true, headline: 'beat', surprise: 'positive' } },
        { symbol: 'OPEN', cells: { open: { grade: 'A' } }, picks: { open: { why: 'an open trade', rank: 1 } } },
    ],
}

function handDeps(over = {}) {
    const queued = [], starts = [], marks = [], rejects = []
    return { queued, starts, marks, rejects, deps: {
        enabled: () => true, maxNames: () => 10, maxUsd: () => 1, now: () => Date.parse('2026-10-23T13:25:00Z'),
        board: async () => HBOARD,
        markBoard: async (id) => { marks.push(id) },
        liveSymbols: async () => new Set(),
        reject: async (id, reason) => { rejects.push([id, reason]) },
        enqueue: async (row) => { queued.push(row); return { ok: true } },
        // The day's rows (and the week's names) read back; the budget's read finds nothing spent.
        listQueue: async (q) => (q.updatedSince ? [] : queued.map(r => ({ ...r, status: 'queued' }))),
        requeueStale: async () => ({ ok: true }),
        startRun: async (o) => { starts.push(o); return { ok: true, run: { id: 'run_h' } } },
        getRun: () => null,
        ...over,
    } }
}

test("an older 09:20 board's WEEK picks keep his order; the hand-off now follows the overnight week board", async () => {
    assert.deepEqual(weekPicks(HBOARD).map(r => r.symbol), ['ONE', 'TWO'])
    const ctx = hotlistContext(HBOARD, HBOARD.rows[1])
    assert.equal(ctx.hotlist, true)
    assert.equal(ctx.why, 'first')
    assert.match(ctx.facts, /^this week \(2–10 days\)(?! [ABC]\b)/, 'no grade handed on (2026-10-24)')
    const { queued, starts, marks, deps } = handDeps()
    assert.equal((await afterCheckpoint({ outcome: 'done', id: 'hb_2026-10-23_preopen' }, deps)).outcome, 'not_this_board', 'the 09:20 board hands nothing on any more (2026-10-25)')
    const r = await afterCheckpoint({ outcome: 'done', id: 'hb_2026-10-23_week' }, deps)
    assert.deepEqual(r.queued, ['ONE', 'TWO'])
    assert.deepEqual(queued.map(q => [q.symbol, q.source]), [['ONE', 'hotlist'], ['TWO', 'hotlist']])
    assert.deepEqual(starts, [{ userId: null, symbols: ['ONE', 'TWO'], maxUsd: 1, source: 'hotlist' }])
    assert.deepEqual(marks, [HBOARD.id], 'the board read is stamped: handed off')
})

test("only the 09:20 board, only when on, and never past the day's name cap", async () => {
    assert.equal((await afterCheckpoint({ outcome: 'done', id: 'hb_2026-10-23_mid' }, handDeps().deps)).outcome, 'not_this_board')
    assert.equal((await afterCheckpoint({ outcome: 'done', id: 'hb_2026-10-23_preopen' }, handDeps({ enabled: () => false }).deps)).outcome, 'off')
    const capped = handDeps({ maxNames: () => 1 })
    const r = await queueWeekPicks(HBOARD, capped.deps)
    assert.deepEqual(r, { queued: ['ONE'], skipped: 1, live: 0 })
    // The previous weekday's UTC midnight: the overnight board for a day is built the evening before (code review 2026-10-25).
    assert.equal(dayStart('2026-10-23'), '2026-10-22T00:00:00.000Z')
    assert.equal(dayStart('2026-10-26'), '2026-10-23T00:00:00.000Z', 'Monday — from Friday')
})

test("the pick-up researches today's waiting names; a run going touches nothing", async () => {
    // The board was handed off already (stamped): the tick only picks up what waits.
    const { queued, starts, deps } = handDeps({ board: async () => ({ ...HBOARD, research_queued_at: '2026-10-23T13:21:00Z' }) })
    queued.push({ symbol: 'ONE', source: 'hotlist', requestedBy: 'house', context: { hotlist: true, day: '2026-10-23' } })
    assert.equal((await resume('2026-10-23', deps)).outcome, 'started')
    assert.deepEqual(starts[0].symbols, ['ONE'])
    assert.equal((await resume('2026-10-23', { ...deps, getRun: () => ({ status: 'running' }) })).outcome, 'busy')
    assert.equal((await resume('2026-10-23', { ...deps, enabled: () => false })).outcome, 'off')
})

test('the screener tick: the nightly pass, the week board, outcomes, the week board’s hand-off, the pick-up, the grading — no checkpoint', async () => {
    _resetGrade()
    const order = []
    const deps = {
        enabled: () => true, now: () => Date.parse('2026-10-23T13:25:00Z'),
        nightly: async () => { order.push('nightly') }, week: async () => { order.push('week'); return { outcome: 'done', id: 'hb_2026-10-26_week' } },
        outcomes: async () => { order.push('outcomes') },
        afterCheckpoint: async (r) => { order.push(`after:${r.id}`) }, resume: async (day) => { order.push(`resume:${day}`) },
        gradeReads: async () => { order.push('grade') },
    }
    await _tick(deps)
    assert.deepEqual(order, ['nightly', 'week', 'outcomes', 'after:hb_2026-10-26_week', 'resume:2026-10-23', 'grade'])
    order.length = 0
    await _tick(deps)
    assert.ok(!order.includes('grade'), 'graded at most hourly')
})
