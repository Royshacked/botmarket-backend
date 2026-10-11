import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkThemeProposal, themeId, themeService, _setThemeIO } from '../../api/strategy/theme.service.js'
import { themeFacts, checkAssessment, industryAssessmentService, _setAssessmentIO } from '../../api/strategy/industryAssessment.service.js'
import { pythiaCallsService, _setCallsIO } from '../../api/strategy/pythiaCalls.service.js'
import { formatTheme, themeBasket, _setThemeDataIO } from '../../api/strategy/themeData.service.js'
import { assessTheme, proposeThemes } from '../../services/industryAssessmentRun.service.js'
import { _parseStrategyResponse, _buildTurnContext, TOOLS } from '../../services/agents/strategy.agent.service.js'
import { memDb } from '../helpers/memDb.js'

// Pythia's themes (docs/design/pythia-assessment.md §3, build step 3): a value chain of GICS sub-industries
// in order, proposed by Pythia and approved by an admin, assessed like an industry over its whole chain.

const NOW = '2026-10-10T12:00:00.000Z'
const SUBS = new Map([
    ['55105010', { name: 'Independent Power Producers & Energy Traders', sector: 'Utilities' }],
    ['20104010', { name: 'Electrical Components & Equipment', sector: 'Industrials' }],
    ['15104020', { name: 'Diversified Metals & Mining', sector: 'Materials' }],
])
const PROPOSAL = (over = {}) => ({
    name: 'Data center power', thesis: 'Hyperscaler capex needs power and grid equipment.',
    terms: ['data center', 'power demand'],
    links: [
        { industry: '20104010', order: 2, why: 'transformers and switchgear' },
        { industry: '55105010', order: 1, why: 'sells the power' },
        { industry: '15104020', order: 3, why: 'copper for the grid' },
    ],
    basket: [{ symbol: 'VST', why: 'contracts' }, { symbol: 'NOPE', why: 'not in the universe' }],
    ...over,
})

test('a theme id is a slug of its name', () => {
    assert.equal(themeId('Data center power'), 'th_data_center_power')
    assert.equal(themeId('  '), null)
})

test('a proposal is a value chain: measured links in order, each with a reason, one direct at least', () => {
    const c = checkThemeProposal(PROPOSAL(), SUBS, new Set(['VST']))
    assert.equal(c.ok, true)
    assert.deepEqual(c.theme.links.map(l => [l.code, l.order]), [['55105010', 1], ['20104010', 2], ['15104020', 3]], 'sorted by order')
    assert.deepEqual(c.theme.basket.map(b => b.symbol), ['VST'])
    assert.deepEqual(c.dropped, ['NOPE'], 'a ticker outside the universe is dropped and listed')
    const bad = checkThemeProposal(PROPOSAL({ terms: [], links: [{ industry: '99999999', order: 1, why: 'x' }, { industry: '20104010', order: 4, why: 'y' }] }), SUBS)
    assert.equal(bad.ok, false)
    assert.match(bad.detail, /terms/)
    assert.match(bad.detail, /99999999: not a measured/)
    assert.match(bad.detail, /order must be 1, 2 or 3/)
    assert.match(checkThemeProposal(PROPOSAL({ links: PROPOSAL().links.map(l => ({ ...l, order: 2 })) }), SUBS).detail, /at least one direct/)
})

test('Pythia proposes, the admin approves — and a proposal never overwrites an approved theme', async () => {
    const m = memDb()
    _setThemeIO({ db: async () => m.db })
    const { theme } = checkThemeProposal(PROPOSAL(), SUBS, new Set(['VST']))
    const p = await themeService.proposeTheme(theme, { now: NOW })
    assert.equal(p.ok, true)
    assert.equal(p.doc.status, 'proposed')
    assert.equal(p.doc.revisions[0].kind, 'proposed')
    const a = await themeService.setStatus(theme.id, 'approved', { by: 'roy', now: NOW })
    assert.equal(a.doc.status, 'approved')
    assert.deepEqual(a.doc.revisions[0].changed, { status: { from: 'proposed', to: 'approved' } })
    assert.equal((await themeService.proposeTheme(theme, { now: NOW })).reason, 'already_approved')
    assert.equal((await themeService.setStatus(theme.id, 'deleted')).reason, 'bad_status')
    assert.equal((await themeService.setStatus('th_none', 'approved')).reason, 'not_found')
    assert.deepEqual((await themeService.listThemes({ statuses: ['approved'] })).map(t => t.id), [theme.id])
})

const THEME = { id: 'th_data_center_power', name: 'Data center power', status: 'approved', thesis: 't', terms: ['data center'],
    links: [{ code: '55105010', name: 'IPPs', order: 1, why: 'power' }, { code: '20104010', name: 'Electrical', order: 2, why: 'gear' }], basket: [] }
const ROWS = new Map([
    ['55105010', { asof: '2026-10-07', raw: { ret_12m: 0.8, spy_12m: 0.17, ret_24m: 2.4, spy_24m: 0.4, ext_percentile: 0.9, hype: true } }],
    ['20104010', { asof: '2026-10-07', raw: { ret_12m: 0.3, spy_12m: 0.17, ret_24m: 0.6, spy_24m: 0.4, hype: false } }],
])

test('a theme\'s facts are its links\' moves and money; the hype flag follows a direct link', () => {
    const f = themeFacts(THEME, ROWS, new Map([['20104010', { capex_change: 0.4 }]]))
    assert.equal(f.moved.kind, 'theme')
    assert.equal(f.moved.hype, true)
    assert.ok(Math.abs(f.moved.links[0].excess_24m - 2.0) < 1e-12)
    assert.equal(f.base_rates[0].key, 'hype')
    assert.equal(f.money.links[1].capex_change, 0.4)
    assert.equal(themeFacts({ ...THEME, links: [{ ...THEME.links[1], order: 1 }] }, ROWS).moved.hype, false)
    const t = formatTheme(THEME, f, { regime: 'green' })
    assert.match(t, /\[1 direct\] IPPs \(55105010\) — power/)
    assert.match(t, /moved: 12m \+63% and 24m \+200% over SPY, stretched 90th percentile, HYPE/)
    assert.match(t, /\[2 suppliers\] Electrical/)
    assert.match(t, /capex \+40%/)
})

test('an assessment can be of a theme — only an approved one — and is graded on the theme\'s basket', async () => {
    assert.equal(checkAssessment({ theme: 'th_data_center_power', verdict: 'watch', horizon: 'months', thesis: 't',
        evidence: { news: 'n', price: 'p' }, cause: { kind: 'money', text: 'c' }, second_order: 's', risks: ['r'],
        change_view_if: ['x'], confidence: 'low' }).ok, true)
    assert.match(checkAssessment({ theme: 'Data center' }).detail, /th_ id/)
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    const block = { theme: THEME.id, verdict: 'watch', horizon: 'months', thesis: 'Direct links stretched; suppliers not yet.',
        evidence: { news: 'n', price: 'p' }, cause: { kind: 'money', text: 'capex' }, second_order: 's', risks: ['r'],
        change_view_if: ['x'], confidence: 'medium' }
    const baskets = []
    const r = await industryAssessmentService.publishAssessment(block, { theme: THEME, facts: themeFacts(THEME, ROWS), basket: ['VST', 'ETN', 'NRG'],
        recordCall: async (doc, opts) => { baskets.push(opts.basket); return { logged: true } }, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.doc.id, 'ia_th_data_center_power')
    assert.deepEqual(r.doc.subject, { kind: 'theme', id: THEME.id, name: THEME.name, sector: null })
    assert.equal(r.doc.moved.hype, true)
    assert.deepEqual(baskets, [['VST', 'ETN', 'NRG']])
    assert.equal((await industryAssessmentService.publishAssessment(block, { theme: { ...THEME, status: 'proposed' }, now: NOW })).reason, 'unknown_theme')
    assert.equal((await industryAssessmentService.getThemeAssessment(THEME.id)).verdict, 'watch')
})

test('a theme call is keyed by the theme and priced on the basket it was given', async () => {
    const m = memDb()
    const prices = { VST: 150, ETN: 300, NRG: 90, SPY: 600, QQQ: 500, RSP: 180 }
    _setCallsIO({ db: async () => m.db, companies: async () => { throw new Error('a theme does not read companies') }, price: async (s) => prices[s] ?? null })
    const doc = { subject: { kind: 'theme', id: THEME.id, name: THEME.name }, verdict: 'watch', horizon: 'months', assessed_at: NOW }
    const r = await pythiaCallsService.recordCall(doc, { now: NOW, basket: ['vst', 'ETN', 'NRG'] })
    assert.equal(r.logged, true)
    assert.equal(r.call.id, `pc_${THEME.id}_20261010T1200`, 'the minute in the id: a same-day flip is a second call')
    assert.deepEqual(r.call.basket, ['VST', 'ETN', 'NRG'])
    assert.equal((await pythiaCallsService.recordCall(doc, { now: NOW, basket: ['VST', 'ETN', 'NRG'] })).logged, false, 'same verdict, same window')
})

test('a theme is graded on its named companies first, then its direct and supplier links\' largest', async () => {
    _setThemeDataIO({
        sub: async (code) => ({ sub: { code } }),
        largest: async (sub) => (sub.code === '55105010' ? [{ symbol: 'VST' }, { symbol: 'NRG' }] : [{ symbol: 'ETN' }, { symbol: 'VST' }]),
    })
    assert.deepEqual(await themeBasket(THEME), ['VST', 'NRG', 'ETN'])
    assert.deepEqual(await themeBasket({ ...THEME, basket: [{ symbol: 'CEG' }] }), ['CEG', 'VST', 'NRG', 'ETN'], 'one named company is kept, not dropped')
})

test('a theme\'s facts come from one screen run for all its links', async () => {
    const { readThemeFacts } = await import('../../api/strategy/themeData.service.js')
    const asked = []
    _setThemeDataIO({
        rows: async (codes) => { asked.push(codes); return { rows: ROWS, regime: { regime: 'green' } } },
        asof: async () => '2026-10-10',
        sub: async (code, asof) => ({ answering: { name: code, asof, money: { companies: 3, capex: { change: 0.2 } } } }),
    })
    const r = await readThemeFacts(THEME)
    assert.deepEqual(asked, [['55105010', '20104010']], 'one read for every link')
    assert.equal(r.regime.regime, 'green')
    assert.equal(r.money.get('20104010').capex_change, 0.2)
    assert.equal(r.facts.moved.hype, true)
})

test('the desk emits theme proposals and theme assessments, and the turns say which', () => {
    const raw = `x<theme_proposal>${JSON.stringify(PROPOSAL())}</theme_proposal><industry_assessment>${JSON.stringify({ theme: ' th_x ' })}</industry_assessment>`
    const p = _parseStrategyResponse(raw)
    assert.equal(p.theme_proposals.length, 1)
    assert.equal(p.assessments[0].theme, 'th_x')
    assert.doesNotMatch(p.reply, /theme_proposal/)
    assert.match(_buildTurnContext({ propose_themes: 3 }), /PROPOSE THEMES — .* up to 3 <theme_proposal>/)
    assert.match(_buildTurnContext({ assess_theme: 'th_data_center_power' }), /ASSESSMENT of the theme th_data_center_power/)
    for (const t of ['list_themes', 'get_theme']) assert.ok(TOOLS.some(x => x.name === t))
})

const RUN_DEPS = (over = {}) => {
    let spend = 0
    return {
        getTheme: async (id) => (id === THEME.id ? THEME : null),
        themeFacts: async () => ({ facts: themeFacts(THEME, ROWS) }),
        themeBasket: async () => ['VST', 'ETN', 'NRG'],
        run: async () => { spend += 0.01; return { reply: 'ok', assessments: [{ theme: THEME.id }], theme_proposals: [PROPOSAL(), PROPOSAL({ name: 'Bad', terms: [] })] } },
        publish: async (block, opts) => ({ ok: true, doc: { verdict: 'watch', subject: { id: opts.theme.id } }, call: { logged: true } }),
        recordCall: async () => ({ logged: true }),
        measuredSubs: async () => SUBS, universeSymbols: async () => new Set(['VST']),
        proposeTheme: async (theme) => ({ ok: true, doc: theme }),
        spend: async () => spend, settle: async () => {}, now: () => NOW,
        ...over,
    }
}

test('Assess a theme now: approved only, published with its cost', async () => {
    const r = await assessTheme(THEME.id, { userId: 'admin', deps: RUN_DEPS() })
    assert.equal(r.outcome, 'published')
    assert.ok(Math.abs(r.cost_usd - 0.01) < 1e-12)
    assert.equal((await assessTheme('th_none', { deps: RUN_DEPS() })).outcome, 'unknown_theme')
    assert.equal((await assessTheme(THEME.id, { deps: RUN_DEPS({ getTheme: async () => ({ ...THEME, status: 'proposed' }) }) })).outcome, 'unknown_theme')
})

test('Propose themes now: checked proposals stored, a bad one refused with its reasons', async () => {
    const r = await proposeThemes({ userId: 'admin', deps: RUN_DEPS() })
    assert.equal(r.ok, true)
    assert.deepEqual(r.proposed.map(p => p.id), ['th_data_center_power'])
    assert.deepEqual(r.proposed[0].dropped, ['NOPE'])
    assert.equal(r.refused.length, 1)
    assert.match(r.refused[0], /terms/)
})

test('a theme assessment that also names a direct link\'s industry is still checked as the theme', () => {
    const block = { theme: ' th_data_center_power ', industry: '55105010', verdict: 'watch', horizon: 'months', thesis: 't',
        evidence: { news: 'n', price: 'p' }, cause: { kind: 'money', text: 'c' }, second_order: 's', risks: ['r'], change_view_if: ['x'], confidence: 'low' }
    const parsed = _parseStrategyResponse(`<industry_assessment>${JSON.stringify(block)}</industry_assessment>`).assessments[0]
    assert.equal(parsed.theme, 'th_data_center_power', 'both fields trimmed')
    const c = checkAssessment(parsed, { expect: 'theme' })
    assert.equal(c.ok, true)
    assert.equal(c.assessment.theme, 'th_data_center_power')
    assert.equal(c.assessment.code, null)
    assert.equal(checkAssessment(parsed).assessment.code, '55105010', 'without an expectation the industry wins, as before')
})

test('a proposal cannot drop an approved theme back to proposed, even racing the approval', async () => {
    const m = memDb()
    _setThemeIO({ db: async () => m.db })
    const { theme } = checkThemeProposal(PROPOSAL(), SUBS, new Set(['VST']))
    // the approval lands between the proposal's create and its revise: the conditional write must refuse
    m.rows('theme').push({ id: theme.id, status: 'approved', revisions: [], created_at: NOW })
    const r = await themeService.proposeTheme(theme, { now: NOW })
    assert.equal(r.reason, 'already_approved')
    assert.equal(m.rows('theme')[0].status, 'approved')
    assert.equal(m.rows('theme').length, 1, 'no duplicate document')
})
