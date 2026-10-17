import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mentorNextState } from '../../services/desks/mentor.desk.js'
import { analystNextState } from '../../services/desks/analyst.desk.js'
import { scannerNextState } from '../../services/desks/scanner.desk.js'
import { portfolioNextState } from '../../services/desks/portfolio.desk.js'
import { strategyDesk } from '../../services/desks/strategy.desk.js'
import { buildConversation } from '../../services/desks/context.js'

// The working state each desk keeps on the server after a turn (unified-chat plan phase 4) — the fold
// the browser used to do on every `done` — and the conversation one agent reads from the session.

// ── nextState ───────────────────────────────────────────────────────────────

test('Mentor: a new draft replaces the old; coverage and multi-name drafts are the turn’s; ops never stored', () => {
    const prev = { active_asset: 'AMD', draft: { asset: 'AMD', v: 1 }, coverage: ['chart'], drafts: { AMD: {} }, ops: [{ op: 'x' }] }
    const next = mentorNextState(prev, { setup: { asset: 'NVDA', v: 2 }, readiness: { ready: true }, coverage: ['chart', 'news'], drafts: { NVDA: {}, AMD: {} }, gate: { stage: 'spans' } })
    assert.equal(next.active_asset, 'NVDA')
    assert.deepEqual(next.draft, { asset: 'NVDA', v: 2 })
    assert.deepEqual(next.coverage, ['chart', 'news'])
    assert.deepEqual(Object.keys(next.drafts), ['NVDA', 'AMD'])
    assert.deepEqual(next.view, { gate: { stage: 'spans' }, readiness: { ready: true }, setups: null })
    assert.equal('ops' in next, false)
})

test('Mentor: a turn with no setup keeps the draft and its readiness; the seed names the asset before any draft', () => {
    const kept = mentorNextState({ draft: { asset: 'AMD' }, view: { readiness: { ready: false } } }, { coverage: [] })
    assert.deepEqual(kept.draft, { asset: 'AMD' })
    assert.deepEqual(kept.view.readiness, { ready: false })
    assert.deepEqual(kept.drafts, {})
    assert.equal(mentorNextState(null, { coverage: [] }, { seed: { ticker: 'TSLA' } }).active_asset, 'TSLA')
})

test('Prometheus: the newest coverage draft and its symbol; the seed names it before a draft exists', () => {
    assert.deepEqual(analystNextState({ draft: null }, { coverage: { symbol: 'NVDA' } }), { active_symbol: 'NVDA', draft: { symbol: 'NVDA' }, standing: true })
    assert.deepEqual(analystNextState(null, {}, { seed: { ticker: 'CVX' } }), { active_symbol: 'CVX', draft: null, standing: false })
})

test('Argus: the mode carries over; the newest list is pending; while editing it is what the next turn refines', () => {
    const prev = { profile: 'investing', handoff: false, editingScanId: 'sc1', pendingScan: { candidates: [1] } }
    const next = scannerNextState(prev, { scan: { candidates: [1, 2] } })
    assert.equal(next.profile, 'investing')
    assert.deepEqual(next.pendingScan, { candidates: [1, 2] })
    assert.deepEqual(next.editList, { candidates: [1, 2] })
    assert.equal(scannerNextState({ profile: 'trading' }, { scan: { candidates: [9] } }).editList, null)
})

test('Atlas: the book and mode carry over; the stated mandate, thesis and plan are the latest', () => {
    const prev = { portfolioId: 'p1', reviewMode: true, mandate: { a: 1 }, thesis: null, adoptDraftId: 'd1' }
    const next = portfolioNextState(prev, { mandate: { a: 2 }, thesis: { t: 1 }, plan: { ideas: [] } })
    assert.deepEqual(next, { portfolioId: 'p1', reviewMode: true, adopt: false, adoptDraftId: 'd1', mandate: { a: 2 }, thesis: { t: 1 }, pendingPlan: { ideas: [] }, reviewUpdate: null, notices: { screenRequests: null, coverageRequest: null } })
    assert.deepEqual(portfolioNextState(prev, {}).mandate, { a: 1 })
})

test('Pythia: the focus carries over; the latest drafts are kept, an empty turn keeps the old ones', () => {
    const prev = { industry: '45301020', draftViews: [{ v: 1 }] }
    assert.deepEqual(strategyDesk.nextState(prev, { views: [{ v: 2 }] }), { industry: '45301020', draftViews: [{ v: 2 }], assessments: [] })
    assert.deepEqual(strategyDesk.nextState(prev, { views: [] }).draftViews, [{ v: 1 }])
})

// ── the conversation one agent reads ────────────────────────────────────────

const row = (seq, agent, role, content, extra = {}) => ({ seq, agent, role, kind: 'msg', content, ...extra })

test('an agent reads only its own turns and the hand-offs addressed to it — a hand-off TO it reads as the user', () => {
    const messages = [
        row(1, 'axl', 'user', 'I want to invest'),
        row(2, 'portfolio', 'user', 'growth, mid-cap'),
        row(3, 'portfolio', 'assistant', 'mandate drafted'),
        { seq: 4, agent: 'portfolio', role: 'assistant', kind: 'handoff', content: 'Scan semis', to: 'scanner' },
        row(5, 'scanner', 'assistant', 'eight names'),
    ]
    assert.deepEqual(buildConversation({ messages, agent: 'scanner' }), [
        { role: 'user', content: 'Scan semis' },
        { role: 'assistant', content: 'eight names' },
    ])
    assert.deepEqual(buildConversation({ messages, agent: 'portfolio' }).map(m => m.role), ['user', 'assistant', 'assistant'])
})

test('the summary leads, and turns it already covers are not repeated', () => {
    const messages = [row(1, 'mentor', 'user', 'old'), row(2, 'mentor', 'assistant', 'old reply'), row(3, 'mentor', 'user', 'new')]
    const out = buildConversation({ messages, agent: 'mentor', summary: { text: 'long AMD, size under 2%', throughSeq: 2 } })
    assert.deepEqual(out, [
        { role: 'user', content: 'Earlier in this conversation (summary): long AMD, size under 2%' },
        { role: 'user', content: 'new' },
    ])
})

test('when editing, the sealed context comes first — its summary, then its turns', () => {
    const out = buildConversation({
        messages: [row(7, 'mentor', 'user', 'move the stop')],
        agent: 'mentor',
        sealed: { summary: 'built Oct 3', messages: [{ role: 'user', content: 'long AMD' }, { role: 'assistant', content: 'two legs' }] },
    })
    assert.deepEqual(out.map(m => m.content), ['Earlier, on this item (summary): built Oct 3', 'long AMD', 'two legs', 'move the stop'])
})
