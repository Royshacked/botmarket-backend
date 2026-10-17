import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeActRig, shapeOf, ADMIN, TRADER } from '../helpers/actRig.js'
import { makeStrategyActions, STRATEGY_REASONS } from '../../services/desks/actions/strategy.actions.js'
import { strategyDesk } from '../../services/desks/strategy.desk.js'
import { makeIndustryPublish } from '../../api/strategy/industryPublish.service.js'

// Unified-chat phase 8a, Pythia: a draft view is published FROM THE SESSION by its industry code, through the same
// service the route uses; the conversation is sealed onto every view it published once the last draft is out.

const SEMIS  = { industry: '45301020', summary: 'Capex cycle intact', swing: 'long' }
const OIL    = { industry: '10102010', summary: 'Supply discipline holds', swing: 'avoid' }

// ─── the publish service ──────────────────────────────────────────────────────

test('publishIndustry checks the draft, writes it, and posts the card only when the answer changed', async () => {
    const calls = { seed: [], publish: [], notify: [] }
    const make = (r) => makeIndustryPublish({
        readSub: async (code) => (code === '45301020' ? { sub: { code, name: 'Semiconductors' }, answering: { m: 1 } } : null),
        views:   { seedMissing: async (subs) => { calls.seed.push(subs) }, publishView: async (code, draft, answering, o) => { calls.publish.push({ code, draft, answering, o }); return r } },
        notify:  async (doc, changed) => { calls.notify.push({ doc, changed }) },
    })
    assert.deepEqual(await make({ ok: true })('99999999', SEMIS), { ok: false, reason: 'unknown_industry' })

    const out = await make({ ok: true, doc: { id: 'v1' }, changed: ['swing'] })('45301020', SEMIS)
    assert.deepEqual(out, { ok: true, doc: { id: 'v1' }, sub: { code: '45301020', name: 'Semiconductors' } })
    assert.deepEqual(calls.publish[0], { code: '45301020', draft: SEMIS, answering: { m: 1 }, o: { note: 'Capex cycle intact' } })
    assert.equal(calls.notify.length, 1)

    await make({ ok: true, doc: { id: 'v1' }, changed: null })('45301020', SEMIS)
    assert.equal(calls.notify.length, 1, 'an unchanged answer posts no card')
    assert.deepEqual(await make({ ok: false, reason: 'bad_draft', detail: 'q2 departs from the read' })('45301020', SEMIS), { ok: false, reason: 'bad_draft', detail: 'q2 departs from the read' })
})

// ─── the action, through the session route ────────────────────────────────────

function rig({ state = null, publish } = {}) {
    const calls = { publish: [] }
    const names = { '45301020': 'Semiconductors', '10102010': 'Integrated Oil & Gas' }
    const fake = async (code, draft) => { calls.publish.push({ code, draft }); return publish?.(code) ?? { ok: true, doc: { id: `v_${code}` }, sub: { code, name: names[code] } } }
    const r = makeActRig({ agent: 'strategy', scope: 'strategy', desk: { ...strategyDesk, actions: makeStrategyActions({ publish: fake }) }, state })
    return { ...r, calls }
}

test('publish takes the named draft FROM THE SESSION and keeps the rest on the table, unsealed', async () => {
    const r = rig({ state: { industry: '45301020', draftViews: [SEMIS, OIL], assessments: [{ a: 1 }] } })
    const { press, stateOf } = await r.start(ADMIN)
    assert.deepEqual(shapeOf(await press('publish', { industry: '45301020', view: { industry: '45301020', swing: 'short' } })), { result: { view: { id: 'v_45301020' } } })
    assert.deepEqual(r.calls.publish[0].draft, SEMIS, 'the session draft — a view in the args is ignored')
    assert.equal(r.seals.length, 0, 'a draft is still waiting')
    const left = await stateOf()
    assert.deepEqual(left.draftViews, [OIL])
    assert.deepEqual(left.published, ['45301020'])
})

test('the last publish seals the conversation onto EVERY view it published', async () => {
    const r = rig({ state: { draftViews: [OIL], published: ['45301020'] } })
    const { s, press, stateOf } = await r.start(ADMIN)
    await press('publish', { industry: '10102010' })
    assert.deepEqual(r.seals[0], { userId: 'u1', sessionId: s.sessionId, agent: 'strategy', kind: 'industry_view', entityIds: ['45301020', '10102010'], name: null })
    assert.equal(await stateOf(), null)

    const one = rig({ state: { draftViews: [SEMIS] } })
    await (await one.start(ADMIN)).press('publish', { industry: '45301020' })
    assert.equal(one.seals[0].name, 'Semiconductors', 'one view is named')
})

test('a refused draft stays on the table with its detail; an unknown code has nothing to publish', async () => {
    const r = rig({ state: { draftViews: [SEMIS] }, publish: () => ({ ok: false, reason: 'bad_draft', detail: 'q2 departs from the read' }) })
    const { press, stateOf } = await r.start(ADMIN)
    assert.deepEqual(await press('publish', { industry: '45301020' }), { reason: 'bad_draft', extra: { detail: 'q2 departs from the read' } })
    assert.deepEqual((await stateOf()).draftViews, [SEMIS])
    assert.equal((await press('publish', { industry: '10102010' })).reason, 'nothing_to_commit')
    assert.equal((await press('publish', {})).reason, 'nothing_to_commit')
})

test('Pythia is an admin desk: a trader\'s press is refused by the speaker rule and publishes nothing', async () => {
    const r = rig({ state: { draftViews: [SEMIS] } })
    assert.deepEqual(await (await r.start(TRADER)).press('publish', { industry: '45301020' }), { reason: 'forbidden' })
    assert.equal(r.calls.publish.length, 0)
})

test('Pythia answers a refusal in the route\'s words', () => {
    assert.equal(STRATEGY_REASONS.bad_draft[0], 422)
    assert.equal(STRATEGY_REASONS.unknown_industry[0], 404)
    assert.equal(strategyDesk.reasons, STRATEGY_REASONS)
})
