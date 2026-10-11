import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { changes, scanIndustry, scanTheme, pickForWeek, SCAN, REASONS } from '../../api/strategy/changeScan.service.js'
import { runWeekly, scanWeek, latestWeek, _resetActive, COLLECTION, KEEP_WEEKS, STALE_MS, weekStatus, refusedTwice, mergeFlagged } from '../../services/pythiaWeekly.service.js'
import { formatFacts } from '../../api/strategy/industryAssessment.service.js'
import { config } from '../../services/config.js'
import { _tick } from '../../monitoring/pythiaWeekly.monitor.service.js'
import { triggerState } from '../../services/industryAssessmentRun.service.js'
import { weekForTraders } from '../../api/strategy/strategy.controller.js'
import { _parseStrategyResponse, _buildTurnContext, TOOLS } from '../../services/agents/strategy.agent.service.js'
import { memDb } from '../helpers/memDb.js'

// Pythia's week (pythia-assessment.md §8, step 6): code flags what MOVED since each standing assessment, and
// only those are assessed, up to a cap and a spend ceiling. Replaced the weekly screen.

const AT = '2026-10-11T12:00:00.000Z'
const moved = (o = {}) => ({ asof: '2026-10-09', ret_24m: 0.3, spy_24m: 0.4, excess_12m: 0.05, rel_1m: 0.01, ext_percentile: 0.5, hype: false, ...o })
const money = (o = {}) => ({ capex_change: 0.2, buybacks_change: 0.1, ...o })
const assessment = (o = {}) => ({ verdict: 'watch', moved: moved({ asof: '2026-10-02' }), money: money(), expires_at: '2026-12-01T00:00:00.000Z', ...o })

// ── the scan (pure) ──────────────────────────────────────────────────────────

test('nothing moved → no flag; the same run read twice is not a change', () => {
    assert.deepEqual(changes({ moved: moved(), money: money() }, { moved: moved({ asof: '2026-10-02' }), money: money() }), [])
    // A sharp month, but the assessment already saw this run: no price leg.
    assert.deepEqual(changes({ moved: moved({ rel_1m: 0.3 }) }, { moved: moved({ rel_1m: 0.3 }) }), [])
    assert.equal(scanIndustry({ code: '1', name: 'X', now: { moved: moved(), money: money() }, assessment: assessment(), at: AT }), null)
})

test('each price leg fires on its line, and only against the assessment it was made on', () => {
    const keys = (now, then) => changes({ moved: moved(now) }, { moved: moved({ asof: '2026-10-02', ...then }) }).map(c => c.key)
    assert.deepEqual(keys({ hype: true }, {}), ['hype_new'])
    assert.deepEqual(keys({ hype: false }, { hype: true }), ['hype_cleared'])
    assert.deepEqual(keys({ rel_1m: -SCAN.SHARP_MOVE_1M }, {}), ['sharp_move'], 'either way, at the line')
    assert.deepEqual(keys({ rel_1m: 0.09 }, {}), [])
    assert.deepEqual(keys({ excess_12m: 0.30 }, { excess_12m: 0.05 }), ['excess_shift'])
    assert.deepEqual(keys({ ext_percentile: 0.95 }, { ext_percentile: 0.6 }), ['stretched'])
    assert.deepEqual(keys({ ext_percentile: 0.95 }, { ext_percentile: 0.92 }), [], 'already stretched when assessed')
    assert.deepEqual(keys({ ext_percentile: 0.05 }, { ext_percentile: 0.4 }), ['washed_out'])
})

test('money legs: capex or buybacks TURNED, by enough to matter', () => {
    const keys = (now, then) => changes({ money: money(now) }, { money: money(then) }).map(c => c.key)
    assert.deepEqual(keys({ capex_change: -0.15 }, { capex_change: 0.2 }), ['capex_turn'])
    assert.deepEqual(keys({ capex_change: -0.05 }, { capex_change: 0.2 }), [], 'a small dip is not a turn')
    assert.deepEqual(keys({ buybacks_change: 0.4 }, { buybacks_change: -0.2 }), ['buyback_turn'])
    assert.deepEqual(keys({ capex_change: null }, { capex_change: 0.2 }), [], 'missing money is not a change')
    const d = changes({ money: money({ capex_change: -0.15 }) }, { money: money() })[0].detail
    assert.equal(d, 'capex +20% → -15%')
})

test('an industry never assessed, or past its expiry, is flagged; reasons carry words and weights', () => {
    const fresh = scanIndustry({ code: '1', name: 'Steel', now: { moved: moved({ excess_12m: -0.4 }) }, assessment: null, at: AT })
    assert.deepEqual(fresh.reasons.map(r => r.key), ['unassessed'])
    assert.equal(fresh.score, REASONS.unassessed.weight)
    assert.equal(fresh.size, 0.4)
    const old = scanIndustry({ code: '1', name: 'Steel', now: { moved: moved() , money: money() }, assessment: assessment({ expires_at: '2026-10-01T00:00:00Z' }), at: AT })
    assert.deepEqual(old.reasons.map(r => [r.key, r.text]), [['expired', 'the assessment expired']])
})

test('a theme flags when a direct or supplier link moved against what ITS assessment froze — not on order 3', () => {
    const theme = { id: 'th_x', name: 'X', links: [{ code: 'A', name: 'Chips', order: 1 }, { code: 'B', name: 'Copper', order: 3 }] }
    const a = { expires_at: '2026-12-01T00:00:00Z',
        moved: { kind: 'theme', links: [{ code: 'A', asof: '2026-10-02', hype: false, ext_percentile: 0.5 }, { code: 'B', asof: '2026-10-02', hype: false }] },
        money: { kind: 'theme', links: [{ code: 'A', capex_change: 0.2 }] } }
    const now = new Map([['A', { moved: moved({ hype: true }), money: money() }], ['B', { moved: moved({ hype: true }) }]])
    const f = scanTheme({ theme, nowByCode: now, assessment: a, at: AT })
    assert.equal(f.reasons[0].key, 'link_moved')
    assert.equal(f.score, REASONS.hype_new.weight, 'the theme weighs as its biggest link change')
    assert.match(f.reasons[0].detail, /^Chips \(the hype flag turned on\)$/)
    assert.equal(scanTheme({ theme, nowByCode: new Map([['B', { moved: moved({ hype: true }) }]]), assessment: a, at: AT }), null)
    const fresh = scanTheme({ theme, nowByCode: now, assessment: null, at: AT })
    assert.deepEqual(fresh.reasons.map(r => r.key), ['unassessed'])
    // Approved but never assessed: ahead of the never-assessed industries, however far they moved.
    const backlog = scanIndustry({ code: '1', name: 'Semis', now: { moved: moved({ excess_12m: 1.5 }) }, assessment: null, at: AT })
    assert.deepEqual(pickForWeek([backlog, fresh], 1).picked.map(x => x.name), ['X'])
})

test('the week picks the biggest change first, the backlog by size, and queues the rest', () => {
    const f = (name, score, size = 0) => ({ name, score, size })
    const { picked, waiting } = pickForWeek([f('backlog-small', 1, 0.1), f('hype', 5), f('backlog-big', 1, 0.9), f('expired', 2)], 3)
    assert.deepEqual(picked.map(x => x.name), ['hype', 'expired', 'backlog-big'])
    assert.deepEqual(waiting.map(x => x.name), ['backlog-small'])
    assert.equal(pickForWeek([f('a', 1)], 0).picked.length, 0)
    assert.equal(pickForWeek([f('a', 1)], 'nonsense').picked.length, 0)
})

// ── the run ──────────────────────────────────────────────────────────────────

let mem, calls
const ROWS = [
    { code: '11111111', name: 'Semis', raw: { ret_12m: 0.9, spy_12m: 0.17, ret_24m: 1.9, spy_24m: 0.4, rel_1m: 0.15, ext_percentile: 0.6, hype: true }, asof: '2026-10-09' },
    { code: '22222222', name: 'Steel', raw: { ret_12m: 0.1, spy_12m: 0.17, rel_1m: 0.0, ext_percentile: 0.5, hype: false }, asof: '2026-10-09' },
    { code: '33333333', name: 'Banks', raw: { ret_12m: 0.2, spy_12m: 0.17, rel_1m: 0.01, ext_percentile: 0.5, hype: false }, asof: '2026-10-09' },
]
function deps(over = {}) {
    return {
        latestRun: async () => ({ asof: '2026-10-09' }),
        readRun: async () => ({ rows: ROWS, regime: { regime: 'yellow' } }),
        readMoney: async () => new Map(),
        // Banks was assessed on this very run: nothing new to see.
        listAssessments: async () => [{ subject: { kind: 'industry', code: '33333333' }, verdict: 'avoid',
            moved: { asof: '2026-10-09', hype: false, ext_percentile: 0.5, excess_12m: 0.03, rel_1m: 0.01 }, money: null, expires_at: '2027-01-01T00:00:00Z' }],
        listThemes: async () => [{ id: 'th_ai', name: 'AI', status: 'approved', links: [{ code: '11111111', name: 'Semis', order: 1 }] }],
        assessIndustry: async (code, opts) => { calls.push({ code, opts }); return { ok: true, outcome: 'published', doc: { verdict: 'watch' }, cost_usd: 0.005 } },
        assessTheme: async (id, opts) => { calls.push({ id, opts }); return { ok: true, outcome: 'published', doc: { verdict: 'interesting_trade' }, cost_usd: 0.006 } },
        bookTo: async () => 'admin1',
        cap: () => 30, maxUsd: () => 1,
        db: async () => mem.db,
        now: () => AT,
        ...over,
    }
}
beforeEach(() => { mem = memDb(); calls = []; _resetActive() })

test('a week: the scan flags what moved, the flagged are assessed biggest first, the week is written', async () => {
    const r = await runWeekly({ deps: deps() })
    assert.equal(r.outcome, 'done')
    // Semis: never assessed (weight 1) — the hype flag counts only against an assessment. Theme and Steel likewise.
    assert.deepEqual(calls.map(c => c.code ?? c.id).sort(), ['11111111', '22222222', 'th_ai'])
    assert.ok(!calls.some(c => c.code === '33333333'), 'Banks was assessed on this run — not flagged')
    assert.equal(calls[0].opts.source, 'weekly')
    assert.equal(calls[0].opts.userId, 'admin1')
    assert.ok(calls.every(c => c.opts.trigger[0].key === 'unassessed'))
    const week = mem.rows(COLLECTION)[0]
    assert.equal(week.id, 'pw_2026-10-09')
    assert.equal(week.status, 'done')
    assert.equal(week.results.length, 3)
    assert.equal(week.waiting_count, 0)
    assert.equal(Number(week.cost_usd.toFixed(3)), 0.016)
    assert.deepEqual(week.scanned, { industries: 3, themes: 1 })
    assert.equal(week.regime, 'yellow', 'the backdrop the week was scanned in')
    assert.equal((await runWeekly({ deps: deps() })).outcome, 'exists', 'one week per run date')
    assert.equal((await latestWeek(deps())).id, 'pw_2026-10-09')
})

test('the cap queues the rest, and the spend ceiling stops the week early', async () => {
    const r = await runWeekly({ deps: deps({ cap: () => 1 }) })
    assert.equal(r.assessed, 1)
    assert.equal(mem.rows(COLLECTION)[0].waiting_count, 2)

    mem = memDb(); calls = []
    const s = await runWeekly({ deps: deps({ maxUsd: () => 0.004 }) })
    assert.equal(s.stopped, 'budget')
    assert.equal(calls.length, 1, 'the first run crossed the ceiling; the next is not started')
    assert.equal(mem.rows(COLLECTION)[0].waiting_count, 2)
})

test('a week that died half-way is resumed: what it already did no longer counts against the cap twice', async () => {
    await mem.db.collection(COLLECTION).updateOne({ id: 'pw_2026-10-09' }, { $setOnInsert: { id: 'pw_2026-10-09', asof: '2026-10-09',
        results: [{ kind: 'industry', code: '99999999', cost_usd: 0.005 }] }, $set: { status: 'running' } }, { upsert: true })
    const r = await runWeekly({ deps: deps({ cap: () => 2 }) })
    assert.equal(r.assessed, 1, 'cap 2, one already done')
    assert.equal(mem.rows(COLLECTION)[0].results.length, 2)
})

test('a failed assessment is recorded with its reason; a second week cannot start while one runs', async () => {
    let release
    const gate = new Promise(r => { release = r })
    const slow = deps({ assessIndustry: async () => { await gate; return { ok: false, outcome: 'refused', detail: 'evidence.news is required', cost_usd: 0.004 } } })
    const first = runWeekly({ deps: slow })
    assert.equal((await runWeekly({ deps: deps() })).outcome, 'already_running')
    release()
    await first
    const refused = mem.rows(COLLECTION)[0].results.find(x => x.outcome === 'refused')
    assert.equal(refused.detail, 'evidence.news is required')
})

test('no complete engine run → nothing is scanned or spent; a throw is reported, never raised', async () => {
    assert.equal((await runWeekly({ deps: deps({ latestRun: async () => null }) })).outcome, 'no_run')
    const r = await runWeekly({ deps: deps({ readRun: async () => { throw new Error('engine down') } }) })
    assert.equal(r.outcome, 'error')
    assert.equal(calls.length, 0)
})

test('old weeks are pruned past the history kept', async () => {
    for (let i = 0; i < KEEP_WEEKS + 2; i++) {
        await mem.db.collection(COLLECTION).insertOne({ id: `pw_old${String(i).padStart(2, '0')}`, asof: `2025-01-${String(i + 1).padStart(2, '0')}`, status: 'done' })
    }
    await runWeekly({ deps: deps() })
    assert.equal(mem.rows(COLLECTION).length, KEEP_WEEKS)
    assert.ok(mem.rows(COLLECTION).some(w => w.id === 'pw_2026-10-09'))
})

test('scanWeek reads the same shapes an assessment freezes', async () => {
    const { flags } = await scanWeek('2026-10-09', deps())
    const semis = flags.find(f => f.code === '11111111')
    assert.equal(semis.previous_verdict, null)
    assert.equal(semis.size, 0.9 - 0.17)
})

// ── around it ────────────────────────────────────────────────────────────────

test('the monitor spends nothing while PYTHIA_WEEKLY is off', async () => {
    let ran = false
    assert.deepEqual(await _tick({ enabled: () => false, run: async () => { ran = true } }), { outcome: 'off' })
    assert.equal(ran, false)
})

test('a trader sees what moved and what was assessed, not the spend', () => {
    const t = weekForTraders({ asof: 'x', cost_usd: 0.2, max_usd: 1, booked_to: 'u', by: 'roy', results: [{ code: '1', cost_usd: 0.1, detail: 'boom', outcome: 'refused' }] })
    assert.deepEqual(t, { asof: 'x', results: [{ code: '1', outcome: 'refused' }] })
})

test('the scan reasons reach the desk turn', () => {
    const s = triggerState([{ key: 'hype_new', text: 'the hype flag turned on', detail: '24m +190%' }, { key: 'expired', text: 'the assessment expired' }])
    assert.equal(s.trigger, 'the hype flag turned on (24m +190%); the assessment expired')
    assert.deepEqual(triggerState(null), {})
    assert.match(_buildTurnContext({ assess: '45301020', ...s }), /weekly change scan flagged it: the hype flag turned on \(24m \+190%\)/)
    assert.doesNotMatch(_buildTurnContext({ assess: '45301020' }), /change scan/)
    assert.match(_buildTurnContext({ assess_theme: 'th_ai', trigger: 'a link moved' }), /flagged it: a link moved/)
})

test('the retired screen: its turn is gone, its tag is still stripped from the reply', () => {
    const r = _parseStrategyResponse('Done.\n<industry_screen>{"industry": "11111111", "q11": 1}</industry_screen>')
    assert.equal(r.reply, 'Done.')
    assert.equal('screens' in r, false)
    assert.equal(_buildTurnContext({ screen: '2026-10-09' }), null)
})

test('the earnings calendar is offered and consult stays last', () => {
    const names = TOOLS.map(t => t.name ?? t.type)
    assert.ok(names.includes('get_earnings_calendar'))
    assert.equal(TOOLS.at(-1).name, 'consult')
})

// ── review fixes (2026-10-11) ────────────────────────────────────────────────

test('a week left running by a dead process reads interrupted; a live one elsewhere still reads running', () => {
    const now = Date.parse(AT)
    const at = (msAgo) => new Date(now - msAgo).toISOString()
    assert.equal(weekStatus({ status: 'running', updated_at: at(STALE_MS + 1) }, { now }), 'interrupted')
    assert.equal(weekStatus({ status: 'running', updated_at: at(60_000) }, { now }), 'running', 'a script or another instance')
    assert.equal(weekStatus({ status: 'running', updated_at: at(STALE_MS * 9) }, { active: true, now }), 'running', 'this process runs it')
    assert.equal(weekStatus({ status: 'running' }, { now }), 'interrupted', 'no timestamp at all')
    assert.equal(weekStatus({ status: 'done' }, { now }), 'done')
    assert.equal(weekStatus(null), null)
})

test('a fresh running week in another process is not started twice; a stale one is resumed', async () => {
    await mem.db.collection(COLLECTION).insertOne({ id: 'pw_2026-10-09', asof: '2026-10-09', status: 'running', updated_at: AT, results: [] })
    assert.equal((await runWeekly({ deps: deps() })).outcome, 'already_running')
    assert.equal(calls.length, 0)
    assert.equal((await latestWeek(deps())).status, 'running')
    mem.rows(COLLECTION)[0].updated_at = new Date(Date.parse(AT) - STALE_MS - 1).toISOString()
    assert.equal((await latestWeek(deps())).status, 'interrupted')
    assert.equal((await runWeekly({ deps: deps() })).outcome, 'done')
})

test('a resumed week keeps what its earlier pass flagged, so its earlier results keep their words', () => {
    const before = [{ kind: 'industry', code: '1', reasons: [{ key: 'hype_new', text: 'the hype flag turned on' }] }, { kind: 'theme', id: 'th_a', reasons: [] }]
    const now = [{ kind: 'theme', id: 'th_a', reasons: [{ key: 'expired' }] }, { kind: 'industry', code: '2', reasons: [] }]
    const m = mergeFlagged(before, now)
    assert.deepEqual(m.map(f => f.code ?? f.id), ['th_a', '2', '1'])
    assert.equal(m[0].reasons[0].key, 'expired', 'the new scan wins for a subject in both')
    assert.deepEqual(mergeFlagged(undefined, now), now)
})

test('refused two weeks running → held back one week, then tried again', async () => {
    const wk = (asof, outcome) => ({ id: `pw_${asof}`, asof, status: 'done', results: [{ kind: 'industry', code: '22222222', outcome }] })
    assert.deepEqual([...refusedTwice([wk('b', 'refused'), wk('a', 'no_block')])], ['industry:22222222'])
    assert.equal(refusedTwice([wk('b', 'refused'), wk('a', 'error')]).size, 0, 'an infrastructure error is not a refusal')
    assert.equal(refusedTwice([wk('b', 'refused')]).size, 0)

    await mem.db.collection(COLLECTION).insertOne(wk('2026-09-25', 'refused'))
    await mem.db.collection(COLLECTION).insertOne(wk('2026-10-02', 'refused'))
    const r = await runWeekly({ deps: deps() })
    assert.equal(r.held_back, 1)
    assert.ok(!calls.some(c => c.code === '22222222'))
    const week = mem.rows(COLLECTION).find(w => w.asof === '2026-10-09')
    assert.deepEqual(week.held_back.map(h => h.code), ['22222222'])
})

test('Roy\'s limits (2026-10-11): every flagged subject, stopping at $3', () => {
    assert.equal(config.pythiaWeeklyCap, Infinity)
    assert.equal(config.pythiaWeeklyMaxUsd, 3)
    assert.equal(pickForWeek(Array.from({ length: 200 }, (_, i) => ({ name: `s${i}`, score: 1, size: 0 })), Infinity).picked.length, 200)
})

test('a week with no count cap stores none, and assesses all it flagged', async () => {
    const r = await runWeekly({ deps: deps({ cap: () => Infinity }) })
    assert.equal(r.assessed, 3)
    assert.equal(mem.rows(COLLECTION)[0].cap, null)
})

test('a sub-industry priced on its parent basket is told the move is the parent\'s', () => {
    const row = { name: 'Copper', basket_name: 'Metals & Mining', asof: '2026-10-09', raw: { ret_12m: 0.3, spy_12m: 0.17 } }
    assert.match(formatFacts(row), /These moves are Metals & Mining's as a whole \(too few Copper names to price on their own\)/)
    assert.doesNotMatch(formatFacts({ ...row, basket_name: 'Copper' }), /as a whole/)
})

test('the move by size rides beside the equal-weight one, and is what the hype flag reads', () => {
    const row = { name: 'Semiconductors', basket_name: 'Semiconductors', asof: '2026-10-07',
        raw: { ret_12m: 0.9, spy_12m: 0.17, ret_24m: 1.88, spy_24m: 0.4, ret_12m_vw: 0.6, ret_24m_vw: 1.41, spy_24m_vw: 0.4, hype: true, hype_basis: 'size_weighted' } }
    const text = formatFacts(row)
    assert.match(text, /BY SIZE \(the big companies count for more — what the hype flag reads\): 12 months \+60%, 24 months \+141% → \+101% over the market/)
    assert.match(text, /weighted by size, as that history was/)
    assert.doesNotMatch(formatFacts({ ...row, raw: { ...row.raw, ret_24m_vw: undefined } }), /BY SIZE/)
})
