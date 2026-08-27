import { test } from 'node:test'
import assert from 'node:assert/strict'

import { refreshCoverage, _buildRefreshPrompt } from '../../services/coverageRefresh.service.js'
import { buildCoverageRefreshed } from '../../services/coverageNotify.service.js'
import { _parseCoverageRefresh } from '../../services/agents/portfolio.agent.service.js'

// G1 — the async Atlas → Prometheus refresh-by-hop: the emit parser, the "ready" card builder, and
// the headless refresh orchestration (research → persist → notify) with injected deps.

// ─── _parseCoverageRefresh (pure) ───────────────────────────────────────────────
test('_parseCoverageRefresh: pulls ticker + question, uppercases, tolerates missing question', () => {
    const a = _parseCoverageRefresh('bla <coverage_refresh>{"ticker":"nvda","question":"moat intact?"}</coverage_refresh> end')
    assert.deepEqual(a, { ticker: 'NVDA', question: 'moat intact?' })
    const b = _parseCoverageRefresh('<coverage_refresh>{"ticker":"aapl"}</coverage_refresh>')
    assert.deepEqual(b, { ticker: 'AAPL', question: null })
})
test('_parseCoverageRefresh: no block / no ticker / malformed → null', () => {
    assert.equal(_parseCoverageRefresh('nothing here'), null)
    assert.equal(_parseCoverageRefresh('<coverage_refresh>{"question":"x"}</coverage_refresh>'), null)
    assert.equal(_parseCoverageRefresh('<coverage_refresh>{bad json}</coverage_refresh>'), null)
})

// ─── buildCoverageRefreshed (pure) ──────────────────────────────────────────────
test('buildCoverageRefreshed: ok card routes back to the review when a portfolioId is present', () => {
    const card = buildCoverageRefreshed({ userId: 'u1', ticker: 'nvda', portfolioId: 'p1', portfolioName: 'Core', coverageId: 'cov1', summary: 'AI capex intact' })
    assert.equal(card.type, 'coverage_refreshed')
    assert.equal(card.botId, 'analyst')
    assert.match(card.content, /Fresh research on NVDA is ready for "Core"/)
    assert.equal(card.payload.portfolioId, 'p1')
    assert.equal(card.payload.ok, true)
})
test('buildCoverageRefreshed: failure card is honest and still lets the user resume', () => {
    const card = buildCoverageRefreshed({ userId: 'u1', ticker: 'NVDA', portfolioId: 'p1', ok: false })
    assert.match(card.content, /Couldn't refresh research on NVDA/)
    assert.equal(card.payload.ok, false)
})
test('buildCoverageRefreshed: no user or ticker → null', () => {
    assert.equal(buildCoverageRefreshed({ userId: '', ticker: 'NVDA' }), null)
    assert.equal(buildCoverageRefreshed({ userId: 'u1', ticker: '' }), null)
})

test('coverage_refreshed is own-only — it is the reply to the specific user who triggered the Atlas review', () => {
    const card = buildCoverageRefreshed({ userId: 'u1', ticker: 'NVDA' })
    assert.equal(card.visibility, 'own')
    assert.equal(card.forUserId, 'u1')
})

// ─── refreshCoverage orchestration (injected deps) ──────────────────────────────
function harness({ draft, initResult, existing = null, updResult = { ok: true } }) {
    const calls = { research: [], initiate: [], update: [], notify: [], existing: [] }
    const deps = {
        research: async (args) => { calls.research.push(args); return draft ? { coverage: draft } : {} },
        initiate: async (d, userId) => { calls.initiate.push({ d, userId }); return initResult },
        update:   async (id, patch, userId) => { calls.update.push({ id, patch, userId }); return updResult },
        notify:   async (a) => { calls.notify.push(a) },
        existing: async (sym) => { calls.existing.push(sym); return existing },
    }
    return { deps, calls }
}

test('new name → initiate + ok ping with the new coverage id', async () => {
    const h = harness({ draft: { symbol: 'NVDA', thesis: 'edge' }, initResult: { ok: true, doc: { id: 'covNEW' } } })
    const r = await refreshCoverage({ userId: 'u1', ticker: 'nvda', portfolioId: 'p1', portfolioName: 'Core' }, h.deps)
    assert.deepEqual(r, { ok: true, coverageId: 'covNEW' })
    assert.equal(h.calls.initiate.length, 1)
    assert.equal(h.calls.update.length, 0)
    assert.equal(h.calls.notify[0].ok, true)
    assert.equal(h.calls.notify[0].coverageId, 'covNEW')
})

test('already-covered name → update the existing thesis, ping with its id', async () => {
    const h = harness({ draft: { symbol: 'NVDA', thesis: 'edge v2' }, initResult: { ok: false, reason: 'already_covered', id: 'covOLD' } })
    const r = await refreshCoverage({ userId: 'u1', ticker: 'NVDA' }, h.deps)
    assert.deepEqual(r, { ok: true, coverageId: 'covOLD' })
    assert.equal(h.calls.update.length, 1)
    assert.equal(h.calls.update[0].id, 'covOLD')
    assert.equal(h.calls.notify[0].ok, true)
})

test('no draft produced → failure ping, no persistence', async () => {
    const h = harness({ draft: null, initResult: { ok: true } })
    const r = await refreshCoverage({ userId: 'u1', ticker: 'NVDA' }, h.deps)
    assert.equal(r.ok, false)
    assert.equal(h.calls.initiate.length, 0)
    assert.equal(h.calls.notify[0].ok, false)
})

test('wrong-symbol draft is rejected (guards against a drifted research run)', async () => {
    const h = harness({ draft: { symbol: 'AMD', thesis: 'oops' }, initResult: { ok: true } })
    const r = await refreshCoverage({ userId: 'u1', ticker: 'NVDA' }, h.deps)
    assert.equal(r.ok, false)
    assert.equal(h.calls.initiate.length, 0)
    assert.equal(h.calls.notify[0].ok, false)
})

// A re-model the coverage service REFUSES (e.g. the rating contradicts the target) leaves the old
// thesis in place — so the ping has to say so. Reporting "fresh research is ready" would send the user
// back to a review that reads the unchanged artifact, with nothing to explain why.
test('a rejected initiate → failure ping carrying the service reason, not a false all-clear', async () => {
    const h = harness({ draft: { symbol: 'ZTS', thesis: 'sell at a target above spot' }, initResult: { ok: false, reason: 'rating_contradicts_target', detail: 'A sell rating needs downside…' } })
    const r = await refreshCoverage({ userId: 'u1', ticker: 'ZTS' }, h.deps)
    assert.deepEqual(r, { ok: false, reason: 'rating_contradicts_target' })
    assert.equal(h.calls.notify[0].ok, false)
})

test('a rejected update on an already-covered name → failure ping too', async () => {
    const h = harness({
        draft: { symbol: 'ZTS', thesis: 'v2' },
        initResult: { ok: false, reason: 'already_covered', id: 'covOLD' },
        updResult:  { ok: false, reason: 'rating_contradicts_target' },
    })
    const r = await refreshCoverage({ userId: 'u1', ticker: 'ZTS' }, h.deps)
    assert.deepEqual(r, { ok: false, reason: 'rating_contradicts_target' })
    assert.equal(h.calls.notify[0].ok, false)
    assert.equal(h.calls.notify[0].coverageId, 'covOLD')   // still routes to the thesis that stayed
})

test('bad args (no ticker) → no research, no notify', async () => {
    const h = harness({ draft: { symbol: 'NVDA' }, initResult: { ok: true } })
    const r = await refreshCoverage({ userId: 'u1', ticker: '' }, h.deps)
    assert.equal(r.ok, false)
    assert.equal(h.calls.research.length, 0)
    assert.equal(h.calls.notify.length, 0)
})

test('_buildRefreshPrompt: includes ticker always, question only when given', () => {
    assert.match(_buildRefreshPrompt('NVDA', 'guide?'), /Re-research NVDA/)
    assert.match(_buildRefreshPrompt('NVDA', 'guide?'), /Focus especially on: guide\?/)
    assert.doesNotMatch(_buildRefreshPrompt('NVDA', null), /Focus especially on/)
})

// ─── update mode: a refresh REVISES, it does not start over ────────────────────
// The prompt always claimed "this is a refresh of an existing thesis" while showing the agent
// nothing. Harmless when a refresh was an occasional Atlas request; once the coverage monitor
// schedules re-models off earnings dates, every one would discard the prior view.

test('an existing thesis is handed to the agent as update-mode context', async () => {
    const prior = { id: 'covOLD', symbol: 'NVDA', thesis: 'la tesis anterior', price_target: { value: 200 } }
    const h = harness({ draft: { symbol: 'NVDA', thesis: 'v2' }, initResult: { ok: false, reason: 'already_covered', id: 'covOLD' }, existing: prior })
    await refreshCoverage({ userId: 'u1', ticker: 'nvda' }, h.deps)

    assert.equal(h.calls.existing[0], 'NVDA')
    const sent = h.calls.research[0]
    assert.deepEqual(sent.chatState.existing_coverage, prior)
    assert.equal(sent.chatState.active_symbol, 'NVDA')
})

test('an uncovered name carries no update-mode context — there is nothing to revise', async () => {
    const h = harness({ draft: { symbol: 'NVDA' }, initResult: { ok: true, doc: { id: 'covNEW' } }, existing: null })
    await refreshCoverage({ userId: 'u1', ticker: 'NVDA' }, h.deps)
    assert.equal(h.calls.research[0].chatState, undefined)
})

// The refresh prompt says NOTHING about language on purpose — see _buildRefreshPrompt. Mirroring the
// existing doc is what let a headless re-model rewrite an English thesis in Portuguese; the one rule
// now rides on every agent's base prompt (LANGUAGE_RULE) and a headless run has no user to have asked
// for anything else. A second instruction here would only compete with it.
test('the refresh prompt carries no language instruction of its own', () => {
    const p = _buildRefreshPrompt('NVDA', null)
    assert.doesNotMatch(p, /language/i)
})
