import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { applyIndustryLimits, capFor, limitAddByRatio, avoidOkCovers, INDUSTRY_CAP, SINGLE_INDUSTRY_MIN, _setDeps as setLimitsDeps } from '../../services/industryLimits.service.js'
import { _industryLimitsForAdd, _industryLimitsForScaleIn } from '../../api/portfolio/portfolioRebalance.service.js'
import { industryAssessmentService, _setAssessmentIO } from '../../api/strategy/industryAssessment.service.js'
import { verdictTurns, buildFingerprint } from '../../services/portfolioReview.util.js'
import { memDb } from '../helpers/memDb.js'

// The second step-7 review (2026-10-11): the limits can no longer be switched off by fields the model writes, scale-ins
// and edit-mode adds are limited too, a failed verdict read raises no false alarm, and an expired verdict gates nothing.

const ind = (code, assessment = null, name = code) => ({ code, name, assessment })
after(() => setLimitsDeps({ views: async () => ({}) }))

test('the single-industry mandate lifts the cap only for a book that is one industry', async () => {
    const by = { A: ind('semis'), B: ind('semis'), C: ind('banks') }
    const single = { concentration: 'single_industry' }
    assert.equal(capFor(single, [{ asset: 'A', weight: 0.5 }, { asset: 'B', weight: 0.4 }, { asset: 'C', weight: 0.1 }], by).cap, Infinity)
    const ordinary = capFor(single, [{ asset: 'A', weight: 0.4 }, { asset: 'C', weight: 0.6 }], by)
    assert.equal(ordinary.cap, INDUSTRY_CAP, 'the model wrote the flag; the book does not bear it out')
    assert.match(ordinary.note, /no industry holds 80% of this book/)
    assert.equal(capFor(null, [], by).cap, INDUSTRY_CAP)
    assert.equal(SINGLE_INDUSTRY_MIN, 0.8)
    const quote = async () => ({ price: 10 })
    const r = await _industryLimitsForAdd({ asset: 'NEW', allocationRatio: 0.5 }, [{ asset: 'OLD', status: 'long', quantity: 300 }], 10_000,
        { quote, industries: async () => ({ NEW: ind('semis'), OLD: ind('semis') }), mandate: single })
    assert.equal(r.quantity, 33, 'a book 30% in semis is no single-industry book: the cap holds')
})

test('every name hyped: the brake says it changes nothing instead of "at half weight"', () => {
    const r = applyIndustryLimits([{ asset: 'A', weight: 0.5 }, { asset: 'B', weight: 0.5 }], { A: ind('x', { hype: true }), B: ind('y', { hype: true }) }, { cap: Infinity })
    assert.deepEqual(r.weights, [0.5, 0.5])
    assert.match(r.notes[0], /nothing to shift weight to/)
    assert.ok(!r.notes.some(n => /at half weight/.test(n)))
})

test("construction keeps the user's count for THAT idea; the rest are still limited", async () => {
    const { _sizePlan } = await import('../../services/agents/portfolio.agent.service.js')
    setLimitsDeps({ views: async () => ({ A: ind('semis', { hype: true }), B: ind('banks'), C: ind('oil') }) })
    const p = await _sizePlan({ ideas: [{ asset: 'A', allocationRatio: 0.4, quantity: 10 }, { asset: 'B', allocationRatio: 0.3 }, { asset: 'C', allocationRatio: 0.3 }] })
    assert.equal(p.ideas[0].allocationRatio, 0.4, "the user's own-sized idea stands")
    assert.match(p.limits.notes[0], /Your own share counts are kept \(A\)/)
})

test('a review add drops a model-written share count; a refusal names the Avoid industry for the card', async () => {
    const { _markAvoidAdds } = await import('../../services/agents/portfolio.agent.service.js')
    const u = await _markAvoidAdds({ changes: [{ action: 'add_item', item: { asset: 'MSFT', allocationRatio: 0.05, quantity: 500 } }] }, { avoid: async () => [] })
    assert.equal('quantity' in u.changes[0].item, false, 'the platform sizes a review add, never the model')
    const refused = await _industryLimitsForAdd({ asset: 'XOM', allocationRatio: 0.1 }, [], 10_000,
        { quote: async () => ({ price: 10 }), industries: async () => ({ XOM: ind('oil', { verdict: 'avoid' }, 'Integrated Oil') }) })
    assert.deepEqual(refused.avoid, [{ asset: 'XOM', industry: 'Integrated Oil' }])
})

test('a scale-in: Avoid needs the OK, hype halves it, the cap cuts it', async () => {
    const quote = async () => ({ price: 10 })
    const item = { asset: 'NVDA', quantity: 100 }, legs = [{ quantity: 100 }]
    const ctx = (o = {}, sib = [{ asset: 'NVDA', status: 'long', quantity: 100 }]) => ({ bookValue: 10_000, siblings: sib, quote, industries: async () => ({ NVDA: ind('semis', o) }) })
    assert.equal((await _industryLimitsForScaleIn(item, legs, { addFraction: 1 }, ctx({ verdict: 'avoid' }))).reason, 'avoid_industry')
    assert.equal((await _industryLimitsForScaleIn(item, legs, { addFraction: 1, avoid_ok: true }, ctx({ verdict: 'avoid' }))).ok, true)
    assert.equal((await _industryLimitsForScaleIn(item, legs, { addFraction: 0.5 }, ctx({ hype: true }))).addFraction, 0.25)
    // $1,000 held of a $10,000 book: room $2,333 → at most +233% of a $1,000 holding.
    const big = await _industryLimitsForScaleIn(item, legs, { addFraction: 5 }, ctx())
    assert.ok(Math.abs(big.addFraction - 7 / 3) < 1e-3)
    const full = await _industryLimitsForScaleIn(item, legs, { addFraction: 1 }, ctx({}, [{ asset: 'NVDA', status: 'long', quantity: 340 }]))
    assert.equal(full.reason, 'industry_cap')
})

test('an edit-mode add, by weight: Avoid needs the named OK, hype halves, the cap trims', () => {
    const by = { XOM: ind('oil', { verdict: 'avoid' }, 'Oil'), NVDA: ind('semis', { hype: true }), AMD: ind('semis'), MSFT: ind('sw') }
    assert.equal(limitAddByRatio({ asset: 'XOM', allocationRatio: 0.1 }, [], by).reason, 'avoid_industry')
    assert.equal(limitAddByRatio({ asset: 'XOM', allocationRatio: 0.1 }, [], by, { avoidOk: ['xom'] }).ok, true)
    assert.equal(limitAddByRatio({ asset: 'NVDA', allocationRatio: 0.2 }, [{ asset: 'MSFT', allocationRatio: 0.8 }], by).allocationRatio, 0.1)
    // The book with AMD: 0.3 + 0.4 + 0.3 = 1.0; semis may hold a third → AMD gets 0.333 − 0.3.
    const cut = limitAddByRatio({ asset: 'AMD', allocationRatio: 0.3 }, [{ asset: 'NVDA', allocationRatio: 0.3 }, { asset: 'MSFT', allocationRatio: 0.4 }], by)
    assert.ok(Math.abs(cut.allocationRatio - (1 / 3 - 0.3)) < 1e-9)
    assert.equal(limitAddByRatio({ asset: 'AMD', allocationRatio: 0.3 }, [{ asset: 'NVDA', allocationRatio: 0.5 }], by).reason, 'industry_cap')
    assert.equal(avoidOkCovers([{ asset: 'XOM' }, { asset: 'BP' }], ['XOM']), false, 'an OK covers only the names it names')
    assert.equal(avoidOkCovers([], []), true)
})

test('a fingerprint keeps the previous verdict where the read failed; an unread verdict raises no trigger', () => {
    const unread = { NVDA: { code: '1', name: 'Semis', assessment: null, assessment_unread: true } }
    assert.deepEqual(verdictTurns({ NVDA: { code: '1', verdict: null, hype: false } }, unread), [])
    const fp = buildFingerprint({ reason: 'r', state: { ideas: [] }, industries: { NVDA: { ...unread.NVDA, verdict: 'avoid', hype: true } }, now: 1 })
    assert.equal(fp.industries.NVDA.verdict, 'avoid')
    assert.equal(fp.industries.NVDA.hype, true)
    const flat = buildFingerprint({ reason: 'r', state: { ideas: [] }, industries: { NVDA: { code: '1', name: 'Semis', verdict: 'avoid', hype: true } }, now: 1 })
    assert.equal(flat.industries.NVDA.verdict, 'avoid', 'a carried-over (flat) row keeps its verdict')
})

test('expired verdicts are left out of the gate', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    await m.db.collection('industry_assessment').insertOne({ id: 'a', subject: { kind: 'industry', code: '9' }, verdict: 'avoid', expires_at: '2020-01-01T00:00:00Z' })
    await m.db.collection('industry_assessment').insertOne({ id: 'b', subject: { kind: 'industry', code: '8' }, verdict: 'avoid', expires_at: '2099-01-01T00:00:00Z' })
    const v = await industryAssessmentService.verdictsForCodes(['9', '8'])
    assert.equal(v.has('9'), false)
    assert.equal(v.get('8').verdict, 'avoid')
})
