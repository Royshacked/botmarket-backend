import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coverageVerdict, formatCompanyView, makeCompanyView } from '../../services/companyView.service.js'

// Axl's company view (docs/design/axl-one-voice.md §2–§4, Roy 2026-11-21): the house's coverage, technical profile and
// events, each with a verdict code decides, and the background work a missing or invalid coverage needs.

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-21T12:00:00Z')
const ago = (days) => new Date(NOW - days * DAY).toISOString()

// NVDA as it stands on 2026-11-21: strong buy $332.50 set Sep 3, then a re-model that withdrew the target.
const NVDA = {
    id: 'cov_NVDA', symbol: 'NVDA', status: 'active', rating: 'strong_buy', created_at: '2026-09-03T07:30:46Z', updated_at: ago(1),
    price_target: { value: 332.5, set_at: '2026-09-03T07:30:46Z', horizon: '12m', basis: '35x FY27 EPS' },
    thesis: 'Blackwell is sold out.', conviction: { level: 'medium', rationale: 'revision trend' },
    monitor: { last_remodel_at: ago(1) },
    revisions: [{ at: ago(1), kind: 'remodel_pass', note: 'I cannot defend a current target… I withdraw the prior target.' }],
}
const fresh = (over = {}) => ({
    id: 'cov_AMD', symbol: 'AMD', status: 'active', rating: 'buy', created_at: ago(5), updated_at: ago(5),
    price_target: { value: 210, set_at: ago(5) }, monitor: { last_remodel_at: ago(5) }, revisions: [{ at: ago(5), kind: 'initiate' }], ...over,
})

test('verdict: none (and retired / watched → re-research), withdrawn, stale by the monitor\'s rule, valid', () => {
    assert.deepEqual(coverageVerdict(null, NOW), { state: 'none', rerun: true, reinit: false })
    assert.deepEqual(coverageVerdict(fresh({ status: 'retired' }), NOW), { state: 'none', rerun: true, reinit: true })
    const w = coverageVerdict(NVDA, NOW)
    assert.equal(w.state, 'withdrawn')
    assert.equal(w.rerun, false, 'a pass a day old is the answer — not re-run inside the cooldown')
    assert.equal(coverageVerdict({ ...NVDA, revisions: [{ ...NVDA.revisions[0], at: ago(4) }] }, NOW).rerun, true, 'past the cooldown it is re-run')
    assert.equal(coverageVerdict({ ...NVDA, price_target: { ...NVDA.price_target, set_at: ago(0.5) } }, NOW).state, 'valid', 'a target set AFTER the pass stands')
    // A catalyst (earnings) passed since the last model, past the 14-day cooldown → stale.
    const s = coverageVerdict(fresh({ monitor: { last_remodel_at: ago(30) }, catalysts: [{ date: ago(10).slice(0, 10), note: 'Q3 print' }] }), NOW)
    assert.equal(s.state, 'stale'); assert.match(s.reason, /catalyst passed/)
    assert.deepEqual(coverageVerdict(fresh(), NOW), { state: 'valid', rerun: false })
})

function rig({ cov = null, claim = true, refresh = async () => ({ ok: true }), enqueue = async () => ({ ok: true }) } = {}) {
    const calls = { claim: [], refresh: [], enqueue: [], run: [], said: [] }
    let settle = null
    let refreshed = null
    const cv = makeCompanyView({
        coverageOf: async () => cov,
        claimRemodel: async (id, o) => { calls.claim.push({ id, ...o }); return claim },
        refresh: (a) => { calls.refresh.push(a); refreshed = refresh(a); return refreshed },
        enqueue: async (a) => { calls.enqueue.push(a); return enqueue(a) },
        waiting: async () => [],
        startRun: async (a) => { calls.run.push(a); return { ok: true } },
        onRunSettled: (fn) => { settle = fn },
        profile: async () => ({ symbol: 'X', version: 1, scales: {}, built: { swing: ago(1) } }),
        events: async () => [],
        say: async (a) => { calls.said.push(a) },
        now: () => NOW,
    })
    return { cv, calls, settle: () => settle?.(), settleWith: (run) => settle?.(run), done: () => refreshed, setCov: (c) => { cov = c } }
}

test('no coverage: queued for the house as Axl\'s ask, the run started, and the asking session told when it lands', async () => {
    const r = rig()
    const v = await r.cv.view({ symbol: 'pltr', userId: 'u1', sessionId: 's1' })
    assert.equal(v.coverage.building, true)
    assert.deepEqual(r.calls.enqueue[0], { symbol: 'PLTR', source: 'axl', requestedBy: 'u1', context: { axl: true } })
    assert.deepEqual(r.calls.run[0], { userId: null, symbols: ['PLTR'] })
    assert.match(formatCompanyView(v), /none\. The analyst is building it now/)
    r.setCov(fresh({ symbol: 'PLTR', rating: 'buy', price_target: { value: 31, set_at: ago(0) } }))
    await r.settle(); await new Promise(res => setImmediate(res))
    assert.deepEqual(r.calls.said.map(s => [s.sessionId, s.content]), [['s1', "The analyst's coverage on PLTR is ready — buy, target 31.00. Ask me about it."]])
})

test('withdrawn past the cooldown / stale: the monitor\'s claim, then one re-model; a lost claim is "being re-modelled", nothing run', async () => {
    const old = { ...NVDA, revisions: [{ ...NVDA.revisions[0], at: ago(4) }] }
    let release
    const r = rig({ cov: old, refresh: () => new Promise(res => { release = () => res({ ok: true }) }) })
    const v = await r.cv.view({ symbol: 'NVDA', userId: 'u1', sessionId: 's1' })
    assert.equal(v.coverage.building, true)
    assert.equal(r.calls.claim[0].id, 'cov_NVDA')
    assert.deepEqual(r.calls.refresh[0], { userId: null, ticker: 'NVDA', trigger: 'axl' })
    // A second ask while it runs: no second claim, no second run.
    await r.cv.view({ symbol: 'NVDA', userId: 'u2', sessionId: 's2' })
    assert.equal(r.calls.claim.length, 1)
    release(); await r.done(); await new Promise(res => setImmediate(res))
    assert.match(r.calls.said[0].content, /^The analyst re-modelled NVDA/)

    const lost = rig({ cov: old, claim: false })
    const l = await lost.cv.view({ symbol: 'NVDA' })
    assert.equal(l.coverage.building, true)
    assert.equal(lost.calls.refresh.length, 0)
})

test('withdrawn inside the cooldown: read, said withdrawn, NOT re-run; valid: read as is', async () => {
    const r = rig({ cov: NVDA })
    const v = await r.cv.view({ symbol: 'NVDA', sessionId: 's1' })
    assert.equal(r.calls.claim.length, 0)
    const text = formatCompanyView(v)
    assert.match(text, /WITHDRAWN — the analyst could not stand behind a target/)
    assert.match(text, /Not re-run: the pass is under 3 days old/)
    assert.match(text, /our price target: 332\.50 \(set 2026-09-03\)/)
    const ok = rig({ cov: fresh() })
    assert.match(formatCompanyView(await ok.cv.view({ symbol: 'AMD' })), /VALID — the analyst's current view/)
    assert.equal(ok.calls.claim.length + ok.calls.enqueue.length, 0)
})

test('a part that cannot be read says so; a bad symbol is refused; kick:false only reads', async () => {
    const r = rig()
    const v = await makeCompanyView({ coverageOf: async () => { throw new Error('db down') }, profile: async () => { throw new Error('DAILY_UNAVAILABLE') }, events: async () => [], now: () => NOW }).view({ symbol: 'NVDA' })
    assert.match(v.coverage.error, /db down/)
    assert.equal(v.technicals.error, 'DAILY_UNAVAILABLE')
    assert.match(formatCompanyView(v), /OUR TECHNICAL PROFILE: not available \(DAILY_UNAVAILABLE\)/)
    assert.equal((await r.cv.view({ symbol: 'not a ticker' })).invalid, true)
    await r.cv.view({ symbol: 'PLTR', kick: false })
    assert.equal(r.calls.enqueue.length, 0)
})

test('no coverage after the run: Axl says WHY — a pass, or the model failing (prod 2026-11-21: TSLA said "could not build" and nothing else)', async () => {
    for (const [reason, re] of [['no_edge', /passed: no edge/], ['model_failed', /failed twice .* not a judgment on the stock/]]) {
        const r = rig()

        await r.cv.view({ symbol: 'TSLA', userId: 'u1', sessionId: 's1' })

        await r.settleWith({ results: [{ symbol: 'TSLA', outcome: 'failed', reason }] }); await new Promise(res => setImmediate(res))
        assert.match(r.calls.said.at(-1).content, re, reason)
        assert.match(r.calls.said.at(-1).content, /^The analyst could not build coverage on TSLA this time/)
    }
})
