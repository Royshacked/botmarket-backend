import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeHorizonView, VIEW_HORIZONS } from '../../api/analyst/coverage.service.js'
import { _parseHorizonView, _buildSystemPrompt, MODES } from '../../services/agents/analyst.agent.service.js'
import { startRun, getRun, researchOpening, isViewItem } from '../../services/researchRun.service.js'
import { readFor, requestRead, mainBookOf, viewRead, _resetPending, VIEW_FRESH_DAYS } from '../../services/mentorReads.service.js'
import { readWaitLine } from '../../services/chain/runner.js'
import { _buildReadSection } from '../../services/agents/mentor.agent.service.js'

// TWO TARGETS, STAGE 1 (docs/design/argus-rework.md step 3; Roy, 2026-11-11): coverage keeps its one MAIN target, and gains
// a view for the OTHER book — written only when a Mentor build on that horizon needs it. And a retired / watchlist coverage
// is re-researched (reinit), not left unanswerable (the CR's #3).

const NOW = Date.parse('2026-11-11T15:00:00Z')
const DAY = 86_400_000
beforeEach(() => _resetPending())

// ─── The view: its shape ─────────────────────────────────────────────────────

test('a view takes its BOOK\'s horizon — a swing view with a 12-month target is coerced to the book, never stored as asked', () => {
    assert.deepEqual(VIEW_HORIZONS, { swing: ['3m', '6m'], long_term: ['12m', '18m', '24m'] })
    const now = '2026-11-11T15:00:00.000Z'
    const v = normalizeHorizonView({ rating: 'buy', target: { value: 54.2, horizon: '6m', low: 51, high: 57 }, why: 'The report.', kill: ['a', '', 'b'] }, 'swing', { now })
    assert.deepEqual(v, { book: 'swing', rating: 'buy', target: { value: 54.2, horizon: '6m', target_date: '2027-05-11', low: 51, high: 57 }, why: 'The report.', kill: ['a', 'b'], set_at: now })
    assert.equal(normalizeHorizonView({ target: { value: 54, horizon: '12m' } }, 'swing', { now }).target.horizon, '3m')
    assert.equal(normalizeHorizonView({ target: { value: 54 } }, 'long_term', { now }).target.horizon, '12m')
    assert.equal(normalizeHorizonView({ target: { value: 54, low: 60, high: 70 } }, 'swing', { now }).target.low, undefined, 'a band that does not hold the target is dropped')
    assert.equal(normalizeHorizonView({ target: { value: 0 } }, 'swing'), null)
    assert.equal(normalizeHorizonView({ target: 54 }, 'nope'), null)
})

test('The analyst\'s <horizon_view> is parsed, checked, and its mode rides as its own cached block', () => {
    const raw = 'My swing view.\n<horizon_view>{ "book": "long term", "rating": "hold", "target": { "value": "260", "horizon": "12m" }, "why": "w", "kill": ["k"] }</horizon_view>'
    assert.deepEqual(_parseHorizonView(raw), { book: 'long_term', rating: 'hold', target: { value: 260, horizon: '12m', low: null, high: null }, why: 'w', kill: ['k'] })
    assert.equal(_parseHorizonView('no block — a pass'), null)
    assert.equal(_parseHorizonView('<horizon_view>{ "book": "swing", "target": { "value": "x" } }</horizon_view>'), null)
    const blocks = _buildSystemPrompt({ existing_coverage: { symbol: 'NVDA' } }, null, null, MODES.HORIZON)
    assert.match(blocks.map(b => b.text).join('\n'), /HORIZON VIEW MODE[\s\S]*EXISTING COVERAGE/)
})

// ─── Mentor's read: main, view, or ask ────────────────────────────────────────

const SWING_COV = { id: 'cov_NVDA', symbol: 'NVDA', status: 'active', rating: 'buy', thesis: 'Demand outruns supply. More.',
    price_target: { value: 210, horizon: '6m', target_date: '2027-05-01' } }
function deps(over = {}) {
    const calls = { enqueue: [], startRun: [] }
    return {
        calls,
        coverage: async () => SWING_COV, liveCatalyst: async () => null, latestCatalyst: async () => null,
        listQueue: async () => [], enqueue: async (row) => { calls.enqueue.push(row); return { ok: true } },
        requeue: async () => ({ ok: true }), startRun: async (a) => { calls.startRun.push(a); return { ok: true } },
        getRun: () => null, now: () => NOW, ...over,
    }
}

test('the main target answers its own book; a build on the OTHER book needs a view', async () => {
    assert.equal(mainBookOf(SWING_COV), 'swing')
    assert.equal(mainBookOf({ price_target: { horizon: '18m' } }), 'long_term')
    assert.equal((await readFor('NVDA', 'swing', deps())).state, 'ready')
    assert.deepEqual(await readFor('NVDA', 'long term', deps()), { kind: 'coverage', state: 'missing', need: 'view' })
})

test('a fresh view is the read — the view first, the main coverage after it as context; a stale one is asked again', async () => {
    const view = { book: 'long_term', rating: 'buy', target: { value: 260, horizon: '12m', target_date: '2027-11-11' }, why: 'The platform keeps compounding. More.', kill: ['capex cut'], set_at: new Date(NOW - 3 * DAY).toISOString() }
    const r = await readFor('NVDA', 'long term', deps({ coverage: async () => ({ ...SWING_COV, horizon_views: { long_term: view } }) }))
    assert.equal(r.state, 'ready')
    assert.equal(r.view, true)
    assert.equal(r.against, false)
    assert.match(r.facts, /^the analyst's long-term view: buy, target 260\.00 by 2027-11-11 \(a 12m target\); why: The platform keeps compounding\.; what breaks it: capex cut; his coverage \(the main target\): the analyst buy/)
    const stale = { ...view, set_at: new Date(NOW - (VIEW_FRESH_DAYS + 1) * DAY).toISOString() }
    assert.equal((await readFor('NVDA', 'long term', deps({ coverage: async () => ({ ...SWING_COV, horizon_views: { long_term: stale } }) }))).need, 'view')
    // A hold view is against the trade, whatever the main target says.
    assert.equal(viewRead(SWING_COV, { ...view, rating: 'hold' }).against, true)
})

test('retired or watchlist coverage is not a read — it is re-researched (reinit)', async () => {
    for (const status of ['retired', 'watchlist']) {
        const r = await readFor('NVDA', 'swing', deps({ coverage: async () => ({ ...SWING_COV, status }) }))
        assert.deepEqual(r, { kind: 'coverage', state: 'missing', need: 'reinit' }, status)
    }
    assert.equal((await readFor('NVDA', 'swing', deps({ coverage: async () => null }))).need, 'new')
})

test('the ask carries what is needed: a view names its book, a reinit says so — and only a matching row answers it', async () => {
    const d = deps()
    await requestRead({ symbol: 'NVDA', horizon: 'long term', sessionId: 's1', userId: 'u1' }, d)
    assert.deepEqual(d.calls.enqueue[0].context, { mentor: true, horizon: 'long term', sessionId: 's1', view: 'long_term' })
    const re = deps({ coverage: async () => ({ ...SWING_COV, status: 'retired' }) })
    await requestRead({ symbol: 'NVDA', horizon: 'swing', sessionId: 's1', userId: 'u1' }, re)
    assert.deepEqual(re.calls.enqueue[0].context, { mentor: true, horizon: 'swing', sessionId: 's1', reinit: true })
    // A plain coverage row (Pythia's) waiting on the name does not answer a VIEW question.
    const plain = [{ symbol: 'NVDA', status: 'queued', created_at: 'x', context: { pythia: true } }]
    assert.equal((await readFor('NVDA', 'long term', deps({ listQueue: async () => plain }))).state, 'missing')
    const viewRow = [{ symbol: 'NVDA', status: 'queued', created_at: 'x', context: { mentor: true, view: 'long_term' } }]
    assert.equal((await readFor('NVDA', 'long term', deps({ listQueue: async () => viewRow }))).state, 'waiting')
})

test('the words: the trader and the chat say it is a VIEW, not a full coverage', () => {
    assert.match(readWaitLine({ symbol: 'NVDA', horizon: 'long term' }, { kind: 'coverage', need: 'view', ahead: 0 }), /I'm reading the business first — the long term view \(the coverage is on the other horizon\)\./)
    assert.match(readWaitLine({ symbol: 'NVDA', horizon: 'swing' }, { kind: 'coverage', need: 'reinit', ahead: 0 }), /the coverage again \(it was not live\)/)
    assert.match(_buildReadSection({ symbol: 'NVDA', horizon: 'long term', kind: 'coverage', state: 'ready', view: true, facts: 'f', against: false }), /\(his long term view\): f/)
})

// ─── The run: a view, a reinit ────────────────────────────────────────────────

async function settled() {
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setImmediate(r))
        if (getRun()?.status !== 'running') return getRun()
    }
    throw new Error('run never settled')
}
function runDeps({ queued, research, existing = SWING_COV, setView, update } = {}) {
    const calls = { done: [], rejected: [], researched: [], views: [], updates: [], initiated: [], annotated: [] }
    return {
        calls,
        listQueue: async () => queued,
        coveredSymbols: async () => new Set(['NVDA']),
        startResearch: async () => ({ ok: true }),
        markDone: async (id) => { calls.done.push(id); return { ok: true } },
        reject: async (id, reason) => { calls.rejected.push([id, reason]); return { ok: true } },
        annotate: async (id, o) => { calls.annotated.push([id, o?.reason ?? null]); return { ok: true } },
        requeue: async () => ({ ok: true }),
        research: async (args) => { calls.researched.push(args); return research(args) },
        coverageOf: async () => existing,
        setView: setView ?? (async (id, book, view) => { calls.views.push([id, book, view.target.value]); return { ok: true } }),
        update: update ?? (async (id, patch) => { calls.updates.push([id, patch.status, patch.revision_kind, 'id' in patch, 'symbol' in patch]); return { ok: true, doc: { id } } }),
        initiate: async (c) => { calls.initiated.push(c.symbol); return { ok: true, doc: { id: 'new' } } },
    }
}
const viewRow = { id: 'rq_NVDA_v', symbol: 'NVDA', status: 'queued', source: 'mentor', context: { mentor: true, horizon: 'long term', view: 'long_term' } }

test('a view row on a COVERED name is researched in horizon mode against its coverage, and saved beside it', async () => {
    assert.equal(isViewItem(viewRow), true)
    const d = runDeps({ queued: [viewRow], research: () => ({ reply: 'x', horizonView: { book: 'long_term', target: { value: 260 } } }) })
    await startRun({ userId: null }, d)
    const run = await settled()
    assert.equal(d.calls.researched[0].mode, 'horizon')
    assert.equal(d.calls.researched[0].existing, SWING_COV, 'his coverage, read as EXISTING COVERAGE')
    assert.match(d.calls.researched[0].opening, /^Your LONG TERM view on NVDA — .* Give your LONG TERM view \(book "long_term", a 12m or 18m or 24m target\)\. Do not rewrite the coverage\./)
    assert.deepEqual(d.calls.views, [['cov_NVDA', 'long_term', 260]])
    assert.deepEqual(d.calls.done, ['rq_NVDA_v'])
    assert.deepEqual(d.calls.initiated, [], 'the coverage is not rewritten')
    assert.equal(run.results[0].outcome, 'read')
})

test('no view block is his pass (no_read); a failed save leaves the claim with its reason; coverage gone is decided', async () => {
    const pass = runDeps({ queued: [viewRow], research: () => ({ reply: 'nothing in the window' }) })
    await startRun({ userId: null }, pass)
    await settled()
    assert.deepEqual(pass.calls.rejected, [['rq_NVDA_v', 'no_read']])
    const broken = runDeps({ queued: [viewRow], research: () => ({ reply: 'x', horizonView: { book: 'long_term', target: { value: 260 } } }), setView: async () => ({ ok: false, reason: 'main_book' }) })
    await startRun({ userId: null }, broken)
    await settled()
    assert.ok(broken.calls.annotated.some(([, r]) => r === 'main_book'))
    const gone = runDeps({ queued: [viewRow], existing: null, research: () => { throw new Error('must not research blind') } })
    await startRun({ userId: null }, gone)
    await settled()
    assert.ok(gone.calls.annotated.some(([, r]) => r === 'no_coverage'))
})

test('a reinit row re-researches a retired coverage and UPDATES it live — not initiate, which refuses a covered name', async () => {
    const row = { id: 'rq_NVDA_r', symbol: 'NVDA', status: 'queued', source: 'mentor', context: { mentor: true, horizon: 'swing', reinit: true } }
    const d = runDeps({ queued: [row], existing: { ...SWING_COV, status: 'retired' }, research: () => ({ reply: 'x', coverage: { symbol: 'NVDA', id: 'cov_draft', thesis: 't' } }) })
    await startRun({ userId: null }, d)
    await settled()
    assert.equal(d.calls.researched[0].mode, null)
    assert.match(d.calls.researched[0].opening, /^Re-research NVDA — your coverage on it is not live/)
    assert.deepEqual(d.calls.updates, [['cov_NVDA', 'active', 'reinitiate', false, false]], 'live again; the draft\'s own id and symbol never overwrite the doc\'s')
    assert.deepEqual(d.calls.initiated, [])
    assert.deepEqual(d.calls.done, ['rq_NVDA_r'])
})

test('a plain mentor row on a covered name is still skipped as covered — only a view or a reinit is for a covered name', async () => {
    const row = { id: 'rq_NVDA_p', symbol: 'NVDA', status: 'queued', source: 'mentor', context: { mentor: true, horizon: 'swing' } }
    const d = runDeps({ queued: [row], research: () => { throw new Error('must not research') } })
    await startRun({ userId: null }, d)
    await settled()
    assert.deepEqual(d.calls.rejected, [['rq_NVDA_p', 'already_covered']])
    assert.equal(researchOpening({ symbol: 'X', context: { mentor: true, view: 'nope' } }).startsWith('Research X for coverage'), true)
})

test('every tool the horizon mode names is one the analyst carries (the drift test reads only the base prompts)', async () => {
    const { readFileSync } = await import('fs')
    const { TOOLS } = await import('../../services/agents/analyst.agent.service.js')
    const text = readFileSync(new URL('../../prompts/analyst_mode_horizon.md', import.meta.url), 'utf8')
    const named = [...new Set([...text.matchAll(/`(get_[a-z_]+|web_search|compute_[a-z_]+)`/g)].map(m => m[1]))]
    const carried = new Set(TOOLS.map(t => t.name))
    assert.ok(named.length > 3)
    assert.deepEqual(named.filter(n => !carried.has(n)), [])
})
