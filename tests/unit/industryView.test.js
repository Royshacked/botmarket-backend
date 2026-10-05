import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkDraft, nextReviewAt, pendingDoc, GRADES, nextAfterPass, failureBackoff, PENDING_RETRY_DAYS } from '../../api/strategy/industryView.service.js'
import { forTraders } from '../../api/strategy/strategy.controller.js'
import { formatNode, formatSubIndustry, formatCompanies } from '../../api/strategy/industryData.service.js'
import { buildIndustryChanged, notifyIndustryChanged } from '../../services/industryNotify.service.js'
import { reviewIndustry, _reviewPrompt, _lastParagraph } from '../../services/industryReview.service.js'
import { _triggered, _sync, _reason, TRIGGER_COOLDOWN_DAYS } from '../../monitoring/industryView.monitor.service.js'

// Pythia's industry views (docs/design/pythia-industry-questions.md): the artifact, the evidence
// formatting, the headless review and the monitor's decisions — all through their seams.

const NODE = {
    level: 'sub_industry', code: '45301020', name: 'Semiconductors', asof: '2026-10-05', n_companies: 41, last_fiscal_year: 2025,
    q1: { grade: 'growing', cagr: 0.12, years: 10, universe_cagr: 0.05, relative: 0.07, cagr_recent_3y: 0.15, share_positive_years: 0.8, growth_volatility: 0.1 },
    q2: { grade: 'good', return_measure: 'roic', median_return: 0.18, hurdle: 0.106, hurdle_sources: ['Semiconductor'], spread: 0.074, share_above_hurdle: 0.7, companies_with_returns: 38, op_margin_mean: 0.22, op_margin_stdev: 0.05, top5_share: 0.62, top5_share_5y_ago: 0.55 },
    q3: { grade: 'peak', measure: 'op_margin', ttm_value: 0.31, range_low: 0.12, range_high: 0.29, percentile: 1, normalised_value: 0.22, cyclical: true, cv: 0.3 },
    triggers: ['margin_at_range_edge'],
}
const ANSWER = (over = {}) => ({
    demand:    { grade: 'growing', rationale: 'Revenue 12%/yr vs 5% for the universe.' },
    economics: { grade: 'good',    rationale: 'Median ROIC 18% against a 10.6% hurdle.' },
    cycle:     { grade: 'peak',    rationale: 'Trailing margin 31%, above every year of the range.' },
    reopen_if: ['industry revenue falls two quarters in a row', ''],
    summary: 'A great industry at the top of its cycle.',
    ...over,
})

// ── the draft check ──────────────────────────────────────────────────────────
test('a draft agreeing with the measured grades is accepted, with the code grade kept beside each answer', () => {
    const r = checkDraft(ANSWER(), NODE)
    assert.ok(r.ok)
    assert.equal(r.view.cycle.code_grade, 'peak')
    assert.deepEqual(r.view.reopen_if, ['industry revenue falls two quarters in a row'], 'empty conditions dropped')
})

test('departing from a measured grade needs its argument, which is stored', () => {
    const bare = checkDraft(ANSWER({ cycle: { grade: 'mid', rationale: 'AI capex is structural.' } }), NODE)
    assert.equal(bare.ok, false)
    assert.match(bare.detail, /cycle: grade "mid" differs from the measured "peak" — give override_reason/)
    const argued = checkDraft(ANSWER({ cycle: { grade: 'mid', rationale: 'r', override_reason: 'Data-center demand raised the margin floor; the range is pre-AI.' } }), NODE)
    assert.ok(argued.ok)
    assert.match(argued.view.cycle.override_reason, /margin floor/)
})

test('a grade outside the vocabulary, or no rationale, is refused per question', () => {
    const r = checkDraft(ANSWER({ demand: { grade: 'booming', rationale: 'r' }, economics: { grade: 'good' } }), NODE)
    assert.equal(r.ok, false)
    assert.match(r.detail, /demand: grade must be one of growing\/in_line\/shrinking/)
    assert.match(r.detail, /economics: rationale is missing/)
})

test('with no measured grade (a thin industry) any valid grade stands without an override', () => {
    assert.ok(checkDraft(ANSWER({ cycle: { grade: 'stable', rationale: 'r' } }), { q3: { grade: null } }).ok)
})

test('the vocabulary is the engine\'s', () => {
    assert.deepEqual(GRADES.cycle, ['peak', 'mid', 'trough', 'stable'])
})

// ── cadence ──────────────────────────────────────────────────────────────────
test('a cyclical industry is due in three months, any other in twelve', () => {
    assert.equal(nextReviewAt('2026-10-05T00:00:00.000Z', true),  '2027-01-05T00:00:00.000Z')
    assert.equal(nextReviewAt('2026-10-05T00:00:00.000Z', false), '2027-10-05T00:00:00.000Z')
})

test('an unanswered sub-industry is seeded pending and due now', () => {
    const d = pendingDoc({ code: '45301020', name: 'Semiconductors', sector: 'Information Technology' }, '2026-10-05T00:00:00.000Z')
    assert.equal(d.id, 'iv_45301020')
    assert.equal(d.status, 'pending')
    assert.equal(d.monitor.next_check_at, '2026-10-05T00:00:00.000Z')
})

// ── the evidence, formatted ──────────────────────────────────────────────────
test('a node reads as three lines of numbers, each with its code grade, and its triggers', () => {
    const t = formatNode(NODE)
    assert.match(t, /DEMAND\s+code grade: growing — revenue 12\.0%\/yr over 10y \(universe 5\.0%, relative \+7\.0pp\)/)
    assert.match(t, /ECONOMICS\s+code grade: good — median roic 18\.0% vs hurdle 10\.6%/)
    assert.match(t, /CYCLE\s+code grade: peak — operating margin trailing 12m 31\.0%/)
    assert.match(t, /TRIGGERS\s+margin_at_range_edge/)
})

test('a thin sub-industry says it is answered at its parent', () => {
    const t = formatSubIndustry({ sub: { code: '25102010', name: 'Motorcycle Manufacturers', n_companies: 1, answered_at: { level: 'industry', name: 'Automobiles' } }, answering: { ...NODE, level: 'industry', name: 'Automobiles', code: '251020' }, parents: [] })
    assert.match(t, /too few companies \(1\) to answer on its own — it is answered at its industry, Automobiles/)
})

test('companies are listed largest first, our coverage marked', () => {
    const t = formatCompanies([{ symbol: 'NVDA', name: 'NVIDIA', market_cap: 4.4e12 }, { symbol: 'TXN', name: 'Texas Instruments', market_cap: 1.8e11 }], new Set(['TXN']))
    assert.match(t, /NVDA .*\$4400\.0B$/m)
    assert.match(t, /TXN .*\[OUR COVERAGE\]/)
})

// ── the card ─────────────────────────────────────────────────────────────────
test('a changed answer posts a card per admin naming what moved; an unchanged review posts nothing', async () => {
    const doc = { code: '45301020', id: 'iv_45301020', name: 'Semiconductors', summary: 'Top of the cycle.' }
    const card = buildIndustryChanged(doc, { cycle: { from: 'mid', to: 'peak' } }, 'u1')
    assert.equal(card.content, 'Semiconductors: cycle mid → peak. Top of the cycle.')
    assert.equal(card.payload.name, 'Semiconductors', 'the frontend heading names the industry')
    assert.equal(card.visibility, 'admin')
    assert.equal(buildIndustryChanged(doc, null, 'u1'), null)

    const posted = []
    const n = await notifyIndustryChanged(doc, { demand: { from: null, to: 'growing' } }, { adminUserIds: async () => ['a', 'b'], post: async c => { posted.push(c); return c } })
    assert.equal(n, 2)
    assert.match(posted[0].content, /demand unanswered → growing/)
})

// ── the headless review ──────────────────────────────────────────────────────
function deps(over = {}) {
    const calls = { published: [], passes: [], notified: [], failures: [] }
    return {
        calls,
        read: async () => ({ sub: { code: '45301020', name: 'Semiconductors' }, answering: NODE }),
        run: async () => ({ reply: 'done', views: [{ industry: '45301020', ...ANSWER() }] }),
        publish: async (code, draft, node) => { calls.published.push({ code, draft, node }); return { ok: true, doc: { code }, changed: { cycle: { from: null, to: 'peak' } } } },
        pass: async (code, reason, cyclical) => { calls.passes.push({ code, reason, cyclical }) },
        notify: async (doc, changed) => { calls.notified.push(changed) },
        fail: async (code, reason) => { calls.failures.push({ code, reason }) },
        ...over,
    }
}

test('a review that answers is published against the answering node, and a change is announced', async () => {
    const d = deps()
    const r = await reviewIndustry('45301020', 'scheduled review', d)
    assert.equal(r.outcome, 'published')
    assert.equal(d.calls.published[0].node, NODE)
    assert.equal(d.calls.notified.length, 1)
})

test('a review that answers nothing is a pass with its last paragraph as the reason, and the cycle clock', async () => {
    const d = deps({ run: async () => ({ reply: 'Read everything.\n\nNothing moved since the last answer.', views: [] }) })
    const r = await reviewIndustry('45301020', null, d)
    assert.equal(r.outcome, 'pass')
    assert.deepEqual(d.calls.passes[0], { code: '45301020', reason: 'Nothing moved since the last answer.', cyclical: true })
})

test('an answer refused at publish is recorded, so the next review sees why', async () => {
    const d = deps({ publish: async () => ({ ok: false, reason: 'bad_draft', detail: 'cycle: give override_reason' }) })
    const r = await reviewIndustry('45301020', null, d)
    assert.equal(r.outcome, 'refused')
    assert.match(d.calls.passes[0].reason, /answer refused at publish — cycle: give override_reason/)
})

test('a review never throws; an unknown industry or a crash is RECORDED as a failure, so it backs off', async () => {
    const unknown = deps({ read: async () => null })
    assert.equal((await reviewIndustry('x', null, unknown)).outcome, 'unknown')
    assert.equal(unknown.calls.failures.length, 1)
    const crash = deps({ run: async () => { throw new Error('boom') } })
    assert.equal((await reviewIndustry('x', null, crash)).outcome, 'error')
    assert.deepEqual(crash.calls.failures, [{ code: 'x', reason: 'boom' }])
})

test('a review past its timeout is CANCELLED, not left spending tokens', async () => {
    let seen
    const slow = deps({ run: ({ signal }) => new Promise((_, reject) => { seen = signal; signal.addEventListener('abort', () => reject(new Error('aborted'))) }) })
    const r = await reviewIndustry('45301020', null, slow, { timeoutMs: 20 })
    assert.equal(r.outcome, 'error')
    assert.equal(seen.aborted, true)
    assert.equal(slow.calls.failures.length, 1)
})

test('a pending industry whose review produced nothing comes back in days; an answered one keeps its cadence', () => {
    const now = '2026-10-05T00:00:00.000Z'
    assert.equal(nextAfterPass('pending', now, false), new Date(Date.parse(now) + PENDING_RETRY_DAYS * 86_400_000).toISOString())
    assert.equal(nextAfterPass('answered', now, true), '2027-01-05T00:00:00.000Z')
})

test('failed reviews back off 1, 3, 7 days, then park for 30 and say so', () => {
    const now = '2026-10-05T00:00:00.000Z'
    const days = (iso) => Math.round((Date.parse(iso) - Date.parse(now)) / 86_400_000)
    assert.deepEqual([1, 2, 3].map(n => days(failureBackoff(n, now).next_check_at)), [1, 3, 7])
    const parked = failureBackoff(4, now)
    assert.equal(days(parked.next_check_at), 30)
    assert.equal(parked.failing, true)
})

test('a trader reads the answers without the revision trail or the monitor', () => {
    const v = forTraders({ code: 'x', demand: { grade: 'growing' }, revisions: [{ note: 'answer refused at publish' }], monitor: { next_check_at: '2027-01-01', failures: 2 } })
    assert.equal(v.revisions, undefined)
    assert.equal(v.monitor, undefined)
    assert.equal(v.next_review, '2027-01-01')
    assert.equal(forTraders(null), null)
})

test('the headless prompt names the industry, why it is due, and the one block expected', () => {
    const p = _reviewPrompt({ code: '45301020', name: 'Semiconductors' }, 'first answer for this sub-industry')
    assert.match(p, /Review GICS sub-industry 45301020 \(Semiconductors\)/)
    assert.match(p, /due because: first answer for this sub-industry/)
    assert.match(p, /exactly one <industry_view> block for 45301020/)
    assert.equal(_lastParagraph(''), null)
})

// ── the monitor's decisions ──────────────────────────────────────────────────
const NOW = Date.parse('2026-10-05T00:00:00Z')
const answered = (code, lastChecked, lastTriggers = []) => ({ code, status: 'answered', monitor: { last_checked: lastChecked, last_triggers: lastTriggers } })

test('a NEW trigger brings an answered view forward; one already seen, or a pending view, does not', () => {
    const measured = [
        { code: 'A', triggers: ['margin_at_range_edge'] },
        { code: 'B', triggers: ['margin_at_range_edge'] },
        { code: 'C', triggers: ['returns_below_hurdle'] },
        { code: 'D', triggers: [] },
    ]
    const views = [
        answered('A', '2026-06-01T00:00:00Z'),
        answered('B', '2026-06-01T00:00:00Z', ['margin_at_range_edge']),
        { code: 'C', status: 'pending', monitor: {} },
        answered('D', '2026-06-01T00:00:00Z'),
    ]
    assert.deepEqual(_triggered(measured, views, NOW).map(d => d.code), ['A'])
})

test('a view reviewed within the cooldown is not brought forward again', () => {
    const recent = new Date(NOW - (TRIGGER_COOLDOWN_DAYS - 1) * 86_400_000).toISOString()
    assert.deepEqual(_triggered([{ code: 'A', triggers: ['revenue_down_two_quarters'] }], [answered('A', recent)], NOW), [])
})

test('a sync seeds what is missing and marks what triggered; a failure never throws', async () => {
    const marked = []
    const r = await _sync({
        measured: async () => [{ code: 'A', triggers: ['x'] }],
        seed: async (subs) => subs.length,
        views: async () => [answered('A', '2026-01-01T00:00:00Z')],
        markDue: async (code, t) => { marked.push([code, t]) },
    })
    assert.deepEqual(r, { seeded: 1, triggered: 1 })
    assert.deepEqual(marked, [['A', ['x']]])
    assert.deepEqual(await _sync({ measured: async () => { throw new Error('db down') } }), { seeded: 0, triggered: 0 })
})

test('the review is told why it is due', () => {
    assert.equal(_reason({ status: 'pending' }), 'first answer for this sub-industry')
    assert.equal(_reason({ status: 'answered', monitor: { early_reason: 'margin_at_range_edge' } }), 'early-review trigger: margin_at_range_edge')
    assert.equal(_reason({ status: 'answered', monitor: {} }), 'scheduled review')
})

// ── the read tool (Axl + Atlas) ──────────────────────────────────────────────
import { makeIndustryViewsHandlers, formatSymbolViews } from '../../services/tools/industryViews.tools.js'
import { industryChanges } from '../../services/portfolioReview.util.js'

test('the read tool answers by symbol, marking pending industries and unclassified names', async () => {
    const h = makeIndustryViewsHandlers({
        forSymbols: async () => ({
            NVDA: { code: '45301020', name: 'Semiconductors', sector: 'Information Technology', status: 'answered', demand: 'growing', economics: 'good', cycle: 'peak', summary: 'Top of the cycle.' },
            HOG:  { code: '25102010', name: 'Motorcycle Manufacturers', sector: 'Consumer Discretionary', status: 'pending' },
        }),
    })
    const out = await h.get_industry_views({ symbols: ['nvda', 'HOG', 'ZZZZ'] })
    assert.match(out, /NVDA\s+Semiconductors \[Information Technology\] — demand growing · economics good · cycle peak/)
    assert.match(out, /HOG\s+Motorcycle Manufacturers .* no house answer yet \(pending\)/)
    assert.match(out, /ZZZZ\s+not classified/)
    assert.match(out, /not forecasts/)
})

test('the read tool lists a sector, and asks for a filter rather than dumping 163 rows', async () => {
    const h = makeIndustryViewsHandlers({
        measured: async () => [{ code: '45301020', name: 'Semiconductors', sector: 'Information Technology' }, { code: '10102010', name: 'Integrated Oil & Gas', sector: 'Energy' }],
        views: async () => [{ code: '45301020', status: 'answered', demand: { grade: 'growing' }, economics: { grade: 'good' }, cycle: { grade: 'peak' } }],
    })
    assert.match(await h.get_industry_views({ sector: 'information technology' }), /Semiconductors\s+demand growing/)
    assert.match(await h.get_industry_views({}), /Pass `symbols`/)
    assert.match(await h.get_industry_views({ sector: 'Tech' }), /No GICS sector named "Tech"/)
})

test('industry changes group held names by industry and ignore a changed classification', () => {
    const v = (code, cycle) => ({ code, name: code, demand: 'growing', economics: 'good', cycle })
    assert.deepEqual(industryChanges({ A: v('X', 'mid'), B: v('X', 'mid'), C: v('Y', 'mid') }, { A: v('X', 'peak'), B: v('X', 'peak'), C: v('Z', 'peak') }),
        [{ code: 'X', name: 'X', symbols: ['A', 'B'], changes: ['cycle mid→peak'] }])
    assert.equal(formatSymbolViews({}, []).split('\n')[0], 'HOUSE INDUSTRY VIEWS for the names asked:')
})
