import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyIndustryLimits, avoidNames, INDUSTRY_CAP, HYPE_FACTOR, _setDeps as setLimitsDeps } from '../../services/industryLimits.service.js'
import { runHouseScan, pythiaContext } from '../../services/houseScan.service.js'
import { _industryLimitsForAdd } from '../../api/portfolio/portfolioRebalance.service.js'
import { industryAssessmentService, _setAssessmentIO } from '../../api/strategy/industryAssessment.service.js'
import { industryViewService, _setViewIO } from '../../api/strategy/industryView.service.js'
import { formatSymbolViews, verdictLine } from '../../services/tools/industryViews.tools.js'
import { createBatchIdeas } from '../../api/trade-ideas/tradeIdeas.controller.js'
import { memDb } from '../helpers/memDb.js'

// Step 7 (pythia-assessment.md §10; Roy 2026-10-11): Pythia's verdicts reach the desks that act — Atlas's limits and
// review, Axl's and Atlas's industry tool, and the house scan that queues names for Prometheus.

const ind = (code, assessment = null, name = code) => ({ code, name, assessment })
const sum = (w) => w.reduce((a, b) => a + b, 0)

// ── the limits (pure) ────────────────────────────────────────────────────────

test('hype brake halves a name; the book stays fully invested', () => {
    const by = { A: ind('w', { hype: true }), B: ind('x'), C: ind('y'), D: ind('z') }
    const r = applyIndustryLimits(['A', 'B', 'C', 'D'].map(asset => ({ asset, weight: 0.25 })), by)
    assert.ok(Math.abs(r.weights[0] - r.weights[1] / 2) < 1e-9, 'A at half of B')
    assert.ok(Math.abs(sum(r.weights) - 1) < 1e-9)
    assert.deepEqual(r.braked, ['A'])
    assert.deepEqual(r.capped, [])
    assert.equal(HYPE_FACTOR, 0.5)
})

test('no sub-industry above a third; the excess goes to the others, or to cash when it cannot', () => {
    const by = { A: ind('semis'), B: ind('semis'), C: ind('banks'), D: ind('oil'), E: null }
    const r = applyIndustryLimits([{ asset: 'A', weight: 0.4 }, { asset: 'B', weight: 0.3 }, { asset: 'C', weight: 0.1 }, { asset: 'D', weight: 0.1 }, { asset: 'E', weight: 0.1 }], by)
    assert.ok(r.weights[0] + r.weights[1] <= INDUSTRY_CAP + 1e-9)
    assert.ok(Math.abs(sum(r.weights) - 1) < 1e-9, 'fully invested when the others can take it')
    assert.ok(Math.abs(r.weights[0] / r.weights[1] - 4 / 3) < 1e-9, 'inside the capped industry, the proportions hold')
    assert.deepEqual(r.capped, ['semis'])
    const two = applyIndustryLimits([{ asset: 'A', weight: 0.5 }, { asset: 'C', weight: 0.5 }], by)
    assert.ok(Math.abs(two.cash - 1 / 3) < 1e-9, 'two industries cannot hold the whole book under the cap')
    assert.match(two.notes.at(-1), /33% left in cash/)
    const unclassified = applyIndustryLimits([{ asset: 'E', weight: 1 }], by)
    assert.deepEqual(unclassified.weights, [1], 'a name with no industry is never capped')
})

test('a redistribution that pushes another industry over the cap caps it too', () => {
    const by = { A: ind('a'), B: ind('b'), C: ind('c'), D: ind('d') }
    const r = applyIndustryLimits([{ asset: 'A', weight: 0.6 }, { asset: 'B', weight: 0.3 }, { asset: 'C', weight: 0.05 }, { asset: 'D', weight: 0.05 }], by)
    for (const x of r.weights) assert.ok(x <= INDUSTRY_CAP + 1e-9)
    assert.ok(Math.abs(sum(r.weights) - 1) < 1e-9)
})

test('avoid is flagged, never removed; an empty or zero book is left alone', () => {
    const r = applyIndustryLimits([{ asset: 'X', weight: 1 }], { X: ind('oil', { verdict: 'avoid' }, 'Oil & Gas Refining') })
    assert.deepEqual(r.avoid, [{ asset: 'X', industry: 'Oil & Gas Refining' }])
    // Flagged, not removed. One industry is still under the cap: a whole book in it is held to a third, the rest cash.
    assert.ok(Math.abs(r.weights[0] - INDUSTRY_CAP) < 1e-9)
    assert.ok(Math.abs(r.cash - 2 / 3) < 1e-9)
    assert.deepEqual(applyIndustryLimits([], {}).weights, [])
    assert.deepEqual(applyIndustryLimits([{ asset: 'X', weight: 0 }], {}).weights, [0])
})

test('the server reads Avoid from the symbols itself; an unreadable industry list blocks nothing', async () => {
    setLimitsDeps({ views: async () => ({ XOM: ind('oil', { verdict: 'avoid' }, 'Integrated Oil'), MSFT: ind('sw', { verdict: 'swing' }) }) })
    assert.deepEqual(await avoidNames(['xom', 'MSFT', 'XOM']), [{ asset: 'XOM', industry: 'Integrated Oil' }])
    setLimitsDeps({ views: async () => { throw new Error('db down') } })
    assert.deepEqual(await avoidNames(['XOM']), [])
})

test('a book with an AVOID name is refused at save without the user\'s OK', async () => {
    setLimitsDeps({ views: async () => ({ XOM: ind('oil', { verdict: 'avoid' }, 'Integrated Oil') }) })
    let status, body
    const res = { status: (s) => { status = s; return res }, send: (b) => { body = b; return res }, json: (b) => { body = b; return res } }
    await createBatchIdeas({ body: { plan: { ideas: [{ asset: 'XOM' }] } }, user: { _id: 'u1' } }, res, () => {})
    assert.equal(status, 409)
    assert.equal(body.outcome, 'avoid_needs_ok')
    assert.deepEqual(body.avoid.map(a => a.asset), ['XOM'])
})

// ── adding a name in a review ────────────────────────────────────────────────

test('a review add: avoid refused without avoid_ok, hype halves the weight, the cap counts what is held', async () => {
    const quote = async (s) => ({ price: { NEW: 10, OLD: 100 }[s] })
    const views = (o = {}) => async () => ({ NEW: ind('semis', o), OLD: ind('semis') })
    const sib = [{ asset: 'OLD', status: 'long', quantity: 30 }]      // $3,000 of a $10,000 book in semis already
    const spec = { asset: 'NEW', allocationRatio: 0.1 }

    const avoid = await _industryLimitsForAdd(spec, sib, 10_000, { quote, industries: views({ verdict: 'avoid' }) })
    assert.equal(avoid.reason, 'avoid_industry')
    assert.equal((await _industryLimitsForAdd({ ...spec, avoid_ok: true }, [], 10_000, { quote, industries: views({ verdict: 'avoid' }) })).ok, true)

    const hype = await _industryLimitsForAdd({ ...spec, allocationRatio: 0.02 }, [], 10_000, { quote, industries: views({ hype: true }) })
    assert.equal(hype.spec.allocationRatio, 0.01)
    assert.equal(hype.quantity, undefined, 'under the cap: sized as usual from the braked weight')

    const capped = await _industryLimitsForAdd(spec, sib, 10_000, { quote, industries: views() })
    assert.equal(capped.quantity, 33, 'room is $3,333 − $3,000: 33 shares at $10')
    const full = await _industryLimitsForAdd(spec, [{ asset: 'OLD', status: 'long', quantity: 34 }], 10_000, { quote, industries: views() })
    assert.equal(full.reason, 'industry_cap')
    const closed = await _industryLimitsForAdd(spec, [{ asset: 'OLD', status: 'closed', quantity: 34 }], 10_000, { quote, industries: views() })
    assert.equal(closed.ok, true, 'a closed holding holds nothing')
    const explicit = await _industryLimitsForAdd({ asset: 'NEW', quantity: 5 }, [], 10_000, { quote, industries: views({ hype: true }) })
    assert.equal(explicit.spec.quantity, 5, "the user's own size is not braked")
    const unknown = await _industryLimitsForAdd(spec, sib, 10_000, { quote, industries: async () => ({}) })
    assert.deepEqual(unknown, { ok: true, spec })
})

// ── what the desks read ──────────────────────────────────────────────────────

test('the industry join carries Pythia\'s verdict per name; a failed verdict read leaves the views standing', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    await m.db.collection('industry_assessment').insertOne({ id: 'ia_ind_1', subject: { kind: 'industry', code: '1' }, verdict: 'interesting_trade', horizon: 'months', moved: { hype: true }, thesis: 't' })
    const v = await industryAssessmentService.verdictsForCodes(['1', '2'])
    assert.equal(v.get('1').verdict, 'swing', 'an old word read as the new')
    assert.equal(v.get('1').hype, true)
    assert.equal(v.has('2'), false)

    const vm = memDb()
    _setViewIO({ db: async () => vm.db })
    const companies = async () => ({ NVDA: { symbol: 'NVDA', sub_code: '1', sub_industry: 'Semis', sector: 'IT' } })
    const out = await industryViewService.viewsForSymbols(['NVDA'], { companies, verdicts: async (codes) => industryAssessmentService.verdictsForCodes(codes) })
    assert.equal(out.NVDA.assessment.verdict, 'swing')
    const broken = await industryViewService.viewsForSymbols(['NVDA'], { companies, verdicts: async () => { throw new Error('x') } })
    assert.equal(broken.NVDA.assessment, null)
    assert.equal(broken.NVDA.status, 'pending')
})

test('Atlas and Axl read the verdict on each name\'s line', () => {
    assert.equal(verdictLine(null), '')
    assert.match(verdictLine({ verdict: 'avoid', hype: true }), /Pythia's verdict: AVOID · HYPE/)
    assert.match(verdictLine({ verdict: 'watch', decides_by: '2026-10-28', question: 'Do hyperscalers hold capex?' }), /WATCH — decides by 2026-10-28: Do hyperscalers hold capex\?/)
    const text = formatSymbolViews({ NVDA: { name: 'Semis', sector: 'IT', status: 'pending', assessment: { verdict: 'swing' } } }, ['NVDA'])
    assert.match(text, /Pythia's verdict: FOR SWING/)
})

// ── the house scan ───────────────────────────────────────────────────────────

function houseDeps(over = {}) {
    const queued = []
    const assessments = {
        'industry:11': { id: 'ia_ind_11', subject: { kind: 'industry', name: 'Steel' }, verdict: 'swing', horizon: 'months', thesis: 'Tariffs lift prices.', risks: ['demand', 'imports', 'a', 'b'] },
        'theme:th_ai': { id: 'ia_th_ai', subject: { kind: 'theme', name: 'AI compute' }, verdict: 'long_term', horizon: 'years', thesis: 'Capex.', risks: [] },
        'industry:22': { id: 'ia_ind_22', subject: { kind: 'industry', name: 'Coal' }, verdict: 'avoid' },
    }
    const largest = { 11: ['NUE', 'STLD', 'CLF', 'X', 'CMC'], 31: ['NVDA', 'AVGO', 'AMD', 'MU'], 32: ['LRCX', 'AMAT', 'KLAC', 'TER'] }
    return {
        queued,
        deps: {
            covered: async () => new Set(['NUE']),
            largest: async (code) => largest[code] ?? [],
            theme: async () => ({ links: [{ code: '31', name: 'Semis', order: 1 }, { code: '32', name: 'Chip equipment', order: 2 }, { code: '33', name: 'Copper', order: 3 }] }),
            assessment: async (r) => assessments[`${r.kind}:${r.code ?? r.id}`],
            enqueue: async (row) => { queued.push(row); return { ok: true, id: 'x' } },
            perIndustry: () => 3, weeklyMax: () => 30,
            ...over,
        },
    }
}

test('the house scan queues the largest uncovered names of this week\'s swing and long-term verdicts, and nothing else', async () => {
    const { queued, deps } = houseDeps()
    const results = [
        { kind: 'industry', code: '11', name: 'Steel', outcome: 'published', verdict: 'swing' },
        { kind: 'industry', code: '22', name: 'Coal', outcome: 'published', verdict: 'avoid' },
        { kind: 'theme', id: 'th_ai', name: 'AI compute', outcome: 'published', verdict: 'long_term' },
        { kind: 'industry', code: '44', name: 'X', outcome: 'refused', verdict: null },
    ]
    const r = await runHouseScan(results, deps)
    assert.deepEqual(queued.map(q => q.symbol), ['STLD', 'CLF', 'X', 'LRCX', 'AMAT', 'KLAC', 'NVDA', 'AVGO', 'AMD'],
        'Steel minus the covered NUE; the theme\'s SUPPLIERS first, then its direct link; never order 3, never Avoid')
    assert.equal(r.queued.length, 9)
    assert.equal(queued[0].source, 'pythia', "Pythia's verdict picked it, not Argus")
    assert.equal(queued[0].context.reason, 'Pythia: Steel for swing')
    assert.equal(queued[0].requestedBy, 'house')
    assert.deepEqual(queued[0].context, pythiaContext({ id: 'ia_ind_11', subject: { kind: 'industry', name: 'Steel' }, verdict: 'swing', horizon: 'months', thesis: 'Tariffs lift prices.', risks: ['demand', 'imports', 'a', 'b'] }))
    assert.equal(queued[0].context.risks.length, 3)
    assert.equal(queued[3].context.link, 'Chip equipment')
})

test('the weekly ceiling holds, a duplicate does not count, and a verdict changed since sends nothing', async () => {
    const capped = houseDeps({ weeklyMax: () => 4 })
    const r = await runHouseScan([
        { kind: 'industry', code: '11', name: 'Steel', outcome: 'published', verdict: 'swing' },
        { kind: 'theme', id: 'th_ai', name: 'AI compute', outcome: 'published', verdict: 'long_term' },
    ], capped.deps)
    assert.equal(r.queued.length, 4)

    const dup = houseDeps({ enqueue: async (row) => ({ ok: true, duplicate: row.symbol === 'STLD' }) })
    const d = await runHouseScan([{ kind: 'industry', code: '11', name: 'Steel', outcome: 'published', verdict: 'swing' }], dup.deps)
    assert.deepEqual(d.queued.map(q => q.symbol), ['CLF', 'X', 'CMC'], 'STLD was already queued — the next name takes its place')

    const changed = houseDeps({ assessment: async () => ({ verdict: 'watch' }) })
    assert.equal((await runHouseScan([{ kind: 'industry', code: '11', outcome: 'published', verdict: 'swing' }], changed.deps)).queued.length, 0)

    const broken = houseDeps({ covered: async () => { throw new Error('coverage down') } })
    assert.deepEqual((await runHouseScan([{ kind: 'industry', code: '11', outcome: 'published', verdict: 'swing' }], broken.deps)).queued, [], 'never throws')
})

// ── the fixes of 2026-10-11 (Roy: fix 1-3; a single-industry mandate overrides the cap) ─

test('a single-industry mandate lifts the cap — the brake and the Avoid flag still apply', async () => {
    const { isSingleIndustry } = await import('../../services/industryLimits.service.js')
    assert.equal(isSingleIndustry({ concentration: 'single_industry' }), true)
    assert.equal(isSingleIndustry({ concentration: 'diversified' }), false)
    assert.equal(isSingleIndustry(null), false)
    const r = applyIndustryLimits([{ asset: 'A', weight: 0.5 }, { asset: 'B', weight: 0.5 }], { A: ind('semis', { hype: true }), B: ind('semis', { verdict: 'avoid' }) }, { cap: Infinity })
    assert.ok(Math.abs(sum(r.weights) - 1) < 1e-9, 'all invested in the one industry')
    assert.ok(Math.abs(r.weights[0] - r.weights[1] / 2) < 1e-9, 'the hype brake still halves')
    assert.equal(r.avoid.length, 1)
    assert.deepEqual(r.capped, [])

    const quote = async () => ({ price: 10 })
    const add = await _industryLimitsForAdd({ asset: 'NEW', allocationRatio: 0.5 }, [{ asset: 'OLD', status: 'long', quantity: 900 }], 10_000,
        { quote, industries: async () => ({ NEW: ind('semis'), OLD: ind('semis') }), mandate: { concentration: 'single_industry' } })
    assert.deepEqual(add, { ok: true, spec: { asset: 'NEW', allocationRatio: 0.5 } }, 'no cap on a single-industry book')
})

test('construction: the user\'s own share counts are kept; a single-industry mandate keeps the whole book invested', async () => {
    const { _sizePlan } = await import('../../services/agents/portfolio.agent.service.js')
    setLimitsDeps({ views: async () => ({ A: ind('semis', { hype: true }), B: ind('semis') }) })
    const own = await _sizePlan({ ideas: [{ asset: 'A', allocationRatio: 0.5, quantity: 10 }, { asset: 'B', allocationRatio: 0.5, quantity: 10 }] })
    assert.deepEqual(own.ideas.map(i => [i.allocationRatio, i.quantity]), [[0.5, 10], [0.5, 10]], 'neither braked nor capped')
    assert.match(own.limits.notes[0], /Your own share counts are kept/)
    const single = await _sizePlan({ ideas: [{ asset: 'A', allocationRatio: 0.5 }, { asset: 'B', allocationRatio: 0.5 }] }, { mandate: { concentration: 'single_industry' } })
    assert.equal(single.limits.cash, 0)
    assert.equal(single.limits.single_industry, true)
    assert.ok(Math.abs(single.ideas[0].allocationRatio - 1 / 3) < 1e-3, 'braked, not capped')
    assert.match(single.limits.notes[0], /Industry cap off/)
})

test('a review update: Atlas cannot write the user\'s OK; adds in an AVOID industry are marked for the card', async () => {
    const { _markAvoidAdds } = await import('../../services/agents/portfolio.agent.service.js')
    const update = { changes: [
        { action: 'add_item', item: { asset: 'XOM', allocationRatio: 0.05, avoid_ok: true } },
        { action: 'add_item', item: { asset: 'MSFT', allocationRatio: 0.05 } },
        { action: 'trim_item', itemId: 'i1' },
    ] }
    const out = await _markAvoidAdds(update, { avoid: async () => [{ asset: 'XOM', industry: 'Integrated Oil' }] })
    assert.equal('avoid_ok' in out.changes[0].item, false, 'only the user\'s yes on the card may set it')
    assert.deepEqual(out.changes[0].avoid, { industry: 'Integrated Oil' })
    assert.equal(out.changes[1].avoid, undefined)
    assert.deepEqual(await _markAvoidAdds({ changes: [] }), { changes: [] })
})
