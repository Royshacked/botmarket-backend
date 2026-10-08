import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    bucketFor, needsAgent, checkScreen, composeRows, screenPrompt, formatScreenRow, BUCKETS, CATALYST_WINDOW_DAYS,
} from '../../api/strategy/screenerData.service.js'
import { runScreen } from '../../services/industryScreenRun.service.js'
import { _tick } from '../../monitoring/industryScreen.monitor.service.js'
import { _parseStrategyResponse, _buildTurnContext, TOOLS } from '../../services/agents/strategy.agent.service.js'

// Pythia's weekly industry screen (docs/design/industry-screener.md): the bucket rules, the catalyst
// check, the headless run and its monitor — all through their seams.

const ASOF = '2026-10-07'
const ROW = (code, over = {}) => ({
    asof: ASOF, code, name: `Industry ${code}`, sector: 'Health Care', basket: `sub_industry:${code}`, basket_name: `Industry ${code}`,
    scores: { q6: 2, q7: 2, q8: 1, q9: 2, q10: 2, q12: 'neutral', timing_partial: 9, timing_answered: 5, ...(over.scores ?? {}) },
    quality: { quality: 8, quality_answered: 5, q1: 2, q2: 2, q3: 1, q4: 2, q5: 1, cycle_stage: 'mid', q1_reason: 'ROIC 18%', ...(over.quality ?? {}) },
    raw: { breadth: 0.6, ext_50: 0.03, ret_12_1: 0.4, rel_1m: 0.01, leaders: [{ symbol: 'AAA', ret_6_1: 0.3, from_high: -0.02, ext_50: 0.04 }], na: {}, ...(over.raw ?? {}) },
})

// ── the bucket (spec §Step 5, as amended by Roy on 2026-10-08) ──────────────

test('the five buckets follow quality and timing, with the long-term watchlist widened to timing under 8', () => {
    const b = (quality, timing, q9 = 2, q12 = 'neutral', regime = 'green') => bucketFor({ quality, timing, q9, q12, regime }).bucket
    assert.equal(b(8, 9), 'swing_long')
    assert.equal(b(8, 9, 0), 'extended')
    assert.equal(b(8, 9, 2, 'crowded'), 'extended')
    assert.equal(b(5, 9), 'swing_only')
    assert.equal(b(8, 7), 'long_watch', 'Roy: quality 7+ with timing 6-7 is the watchlist, not a gap')
    assert.equal(b(8, 3), 'long_watch')
    assert.equal(b(5, 7), 'avoid')
})

test('a red regime takes the swing half off every swing bucket', () => {
    const red = (quality, timing, q9 = 2) => bucketFor({ quality, timing, q9, q12: 'neutral', regime: 'red' })
    assert.deepEqual(red(8, 9), { bucket: 'long_watch', downgraded: true })
    assert.deepEqual(red(8, 9, 0), { bucket: 'long_watch', downgraded: true })
    assert.deepEqual(red(5, 9), { bucket: 'avoid', downgraded: true })
    assert.deepEqual(red(8, 5), { bucket: 'long_watch', downgraded: false })
})

test('every bucket carries a trade verdict and a horizon', () => {
    assert.deepEqual(Object.values(BUCKETS).map(b => b.trade), ['yes', 'wait', 'yes', 'wait', 'no'])
    assert.equal(BUCKETS.swing_only.horizon, 'swing')
    assert.equal(BUCKETS.long_watch.horizon, 'long')
})

// ── who the agent looks at ───────────────────────────────────────────────────

test('the agent looks only where Q11 can move the bucket, or a top bucket needs notes', () => {
    assert.equal(needsAgent(ROW('1', { scores: { timing_partial: 6 } })), true)
    assert.equal(needsAgent(ROW('1', { scores: { timing_partial: 7 } })), true)
    assert.equal(needsAgent(ROW('1', { scores: { timing_partial: 5 } })), false, 'two points cannot reach 8')
    assert.equal(needsAgent(ROW('1', { scores: { timing_partial: 9 } })), true, 'swing + long-term: needs notes')
    assert.equal(needsAgent(ROW('1', { scores: { timing_partial: 9 }, quality: { quality: 4 } })), false, 'swing only: already decided, no notes')
    assert.equal(needsAgent(ROW('1', { scores: { timing_answered: 0 } })), false, 'unscored')
})

// ── the catalyst claim ───────────────────────────────────────────────────────

test('a 2 stands only with a date inside four weeks and a mechanism', () => {
    const ok = checkScreen({ industry: '35102030', q11: 2, event_date: '2026-10-20', mechanism: 'UNH reports', q11_reason: 'Q3 season' }, ASOF)
    assert.equal(ok.screen.q11, 2)
    assert.equal(ok.screen.event_date, '2026-10-20')
    const late = checkScreen({ industry: '35102030', q11: 2, event_date: '2026-12-01', mechanism: 'x', q11_reason: 'a theme' }, ASOF)
    assert.equal(late.screen.q11, 1)
    assert.match(late.screen.q11_corrected, new RegExp(`within ${CATALYST_WINDOW_DAYS} days`))
    assert.equal(late.screen.q11_claimed, 2)
    const undated = checkScreen({ industry: '35102030', q11: 2, mechanism: 'x' }, ASOF)
    assert.equal(undated.screen.q11, 0, 'no date and no reason: nothing stands')
    const past = checkScreen({ industry: '35102030', q11: 2, event_date: '2026-10-01', mechanism: 'x', q11_reason: 'r' }, ASOF)
    assert.equal(past.screen.q11, 1, 'an event before the run is not ahead of it')
})

test('a 1 needs a named driver, and malformed blocks are refused', () => {
    assert.equal(checkScreen({ industry: '35102030', q11: 1 }, ASOF).screen.q11, 0)
    assert.equal(checkScreen({ industry: '35102030', q11: 1, q11_reason: 'rate path' }, ASOF).screen.q11, 1)
    assert.equal(checkScreen({ industry: 'Semis', q11: 1 }, ASOF).ok, false)
    assert.equal(checkScreen({ industry: '35102030', q11: 3 }, ASOF).ok, false)
})

// ── composing the published rows ─────────────────────────────────────────────

test('Q11 adds to the engine timing, the bucket follows, and a change since last week is marked', () => {
    const rows = [ROW('11111111', { scores: { timing_partial: 7 } }), ROW('22222222', { scores: { timing_partial: 3 }, quality: { quality: 4 } })]
    const agent = new Map([['11111111', { code: '11111111', q11: 1, q11_reason: 'rate path', notes: null }]])
    const prev = new Map([['11111111', { bucket: 'long_watch' }], ['22222222', { bucket: 'avoid' }]])
    const out = composeRows(rows, agent, 'green', prev)
    const a = out.find(r => r.code === '11111111')
    assert.equal(a.timing, 8)
    assert.equal(a.bucket, 'swing_long')
    assert.equal(a.trade, 'yes')
    assert.equal(a.changed, true)
    assert.equal(a.previous_bucket, 'long_watch')
    const b = out.find(r => r.code === '22222222')
    assert.equal(b.q11, null)
    assert.match(b.q11_reason, /could not change/)
    assert.equal(b.changed, false)
    assert.deepEqual(out.map(r => r.code), ['11111111', '22222222'], 'best bucket first')
})

test('an unscored industry has no verdict and sorts last', () => {
    const out = composeRows([ROW('3', { scores: { timing_answered: 0, timing_partial: 0 } }), ROW('4')], new Map(), 'green')
    assert.equal(out.at(-1).code, '3')
    assert.equal(out.at(-1).bucket, null)
    assert.equal(out.at(-1).trade, null)
})

test('the batch prompt says why each industry is there and keeps the verdict with the code', () => {
    const txt = screenPrompt([ROW('11111111', { scores: { timing_partial: 6 } })], ASOF, { regime: 'green' })
    assert.match(txt, /between 2026-10-07 and 2026-11-04/)
    assert.match(txt, /needs 2 catalyst points/)
    assert.match(txt, /you do not choose it/)
    assert.match(formatScreenRow(ROW('1')), /leaders: AAA/)
})

// ── the weekly run ───────────────────────────────────────────────────────────

function deps(over = {}) {
    const saved = []
    return {
        saved,
        latestRun: async () => ({ asof: ASOF }),
        readRun: async () => ({ rows: [ROW('11111111', { scores: { timing_partial: 7 } }), ROW('22222222', { scores: { timing_partial: 3 } })], regime: { regime: 'green' } }),
        getScreen: async () => null,
        previous: async () => null,
        save: async (doc) => { saved.push(doc); return doc },
        run: async () => ({ screens: [{ industry: '11111111', q11: 2, event_date: '2026-10-20', mechanism: 'leaders report', q11_reason: 'season', notes: 'Strong.' }] }),
        now: () => '2026-10-08T00:00:00Z',
        ...over,
    }
}

test('a new engine run is screened once: only the industries that need the agent are asked', async () => {
    const asked = []
    const d = deps({ run: async (args) => { asked.push(args.userPrompt); return deps().run() } })
    const r = await runScreen(d)
    assert.equal(r.outcome, 'published')
    assert.equal(asked.length, 1)
    assert.match(asked[0], /11111111/)
    assert.doesNotMatch(asked[0], /22222222/, 'timing 3 with long-term quality: Q11 cannot move it')
    const doc = d.saved[0]
    assert.equal(doc.rows.find(x => x.code === '11111111').bucket, 'swing_long')
    assert.equal(doc.agent.asked, 1)
    assert.equal(doc.agent.answered, 1)
    assert.equal((await runScreen({ ...d, getScreen: async () => ({ asof: ASOF }) })).outcome, 'exists')
})

test('a failed batch still publishes, with Q11 at 0 and the failure counted', async () => {
    const d = deps({ run: async () => { throw new Error('model down') } })
    const r = await runScreen(d)
    assert.equal(r.outcome, 'published')
    const row = d.saved[0].rows.find(x => x.code === '11111111')
    assert.equal(row.q11, 0)
    assert.match(row.q11_reason, /failed/)
    assert.equal(d.saved[0].agent.failed_batches, 1)
    assert.equal(row.bucket, 'long_watch')
})

test('an industry the agent skipped is marked, and nothing to screen is said plainly', async () => {
    const d = deps({ run: async () => ({ screens: [] }) })
    await runScreen(d)
    assert.match(d.saved[0].rows.find(x => x.code === '11111111').q11_reason, /no answer/)
    assert.equal((await runScreen(deps({ latestRun: async () => null }))).outcome, 'no_run')
    assert.equal((await runScreen(deps({ latestRun: async () => { throw new Error('db') } }))).outcome, 'error')
})

test('the monitor spends nothing while the screen is off', async () => {
    let ran = 0
    assert.deepEqual(await _tick({ enabled: () => false, run: async () => { ran++ } }), { outcome: 'off' })
    assert.equal(ran, 0)
    await _tick({ enabled: () => true, run: async () => { ran++; return { outcome: 'exists' } } })
    assert.equal(ran, 1)
})

// ── the desk ─────────────────────────────────────────────────────────────────

test('the desk returns screen blocks beside views, and never shows either tag', () => {
    const raw = 'Done.\n<industry_screen>{"industry": "11111111", "q11": 1, "q11_reason": "x"}</industry_screen>'
    const r = _parseStrategyResponse(raw)
    assert.equal(r.screens.length, 1)
    assert.equal(r.views.length, 0)
    assert.equal(r.reply, 'Done.')
    assert.match(_buildTurnContext({ screen: ASOF }), /WEEKLY INDUSTRY SCREEN/)
})

test('the earnings calendar is offered and consult stays last', () => {
    const names = TOOLS.map(t => t.name ?? t.type)
    assert.ok(names.includes('get_earnings_calendar'))
    assert.equal(TOOLS.at(-1).name, 'consult')
})
