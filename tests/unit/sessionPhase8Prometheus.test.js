import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAct } from '../../services/desks/act.js'
import { makeAnalystActions, analystReason } from '../../services/desks/actions/analyst.actions.js'
import { analystDesk, analystNextState } from '../../services/desks/analyst.desk.js'
import { makeCoverageCommit } from '../../api/analyst/coverageCommit.service.js'

// Unified-chat phase 8a, Prometheus: a STANDING draft is committed FROM THE SESSION through the same service the
// coverage routes use (coverageCommit), and only by an admin — the routes' requireAdmin, held by the action.

const admin  = { _id: 'u1', role: 'admin' }
const trader = { _id: 'u1', role: 'trader' }
const DRAFT  = { symbol: 'NVDA', rating: 'buy', price_target: 260, thesis: 'AI capex runs longer than the Street thinks' }

// ─── the commit service ───────────────────────────────────────────────────────

function commitRig({ initiate, update } = {}) {
    const calls = { initiate: [], update: [], cards: [] }
    const commit = makeCoverageCommit({
        coverage: {
            initiateCoverage: async (d) => { calls.initiate.push(d); return initiate?.(d) ?? { ok: true, doc: { id: 'cov_1', ...d } } },
            updateCoverage:   async (id, p) => { calls.update.push({ id, p }); return update?.(id, p) ?? { ok: true, doc: { id, ...p, revisions: [{ kind: 'remodel', changed: ['price_target'] }] } } },
        },
        resolveCards: async (subject, o) => { calls.cards.push({ subject, o }) },
    })
    return { commit, calls }
}

test('revise writes the revision, then closes the cards asking for it; a refused write closes nothing', async () => {
    const { commit, calls } = commitRig()
    assert.equal((await commit.revise('cov_1', { price_target: 270 })).ok, true)
    assert.deepEqual(calls.cards[0].subject, { kind: 'coverage', id: 'cov_1' })
    assert.equal(calls.cards[0].o.outcome, 'revised')

    const bad = commitRig({ update: () => ({ ok: false, reason: 'rating_contradicts_target', detail: 'sell with a target above' }) })
    assert.equal((await bad.commit.revise('cov_1', {})).reason, 'rating_contradicts_target')
    assert.equal(bad.calls.cards.length, 0)
})

test('initiateOrRevise initiates a new name, and revises one already covered as a remodel', async () => {
    const fresh = commitRig()
    assert.deepEqual(await fresh.commit.initiateOrRevise(DRAFT), { ok: true, doc: { id: 'cov_1', ...DRAFT }, revised: false })

    const covered = commitRig({ initiate: () => ({ ok: false, reason: 'already_covered', id: 'cov_9' }) })
    const out = await covered.commit.initiateOrRevise(DRAFT)
    assert.equal(out.revised, true)
    assert.deepEqual(covered.calls.update[0], { id: 'cov_9', p: { ...DRAFT, revision_kind: 'remodel', revision_note: 'Coverage updated via Prometheus' } })

    // A race with no id to revise is the refusal, not a guess.
    const race = commitRig({ initiate: () => ({ ok: false, reason: 'already_covered' }) })
    assert.equal((await race.commit.initiateOrRevise(DRAFT)).reason, 'already_covered')
    assert.equal(race.calls.update.length, 0)
})

// ─── the standing rule ────────────────────────────────────────────────────────

test('only the latest turn\'s draft stands; a reopened thesis is the subject, not a proposal', () => {
    const drafted = analystNextState(null, { coverage: DRAFT })
    assert.equal(drafted.standing, true)
    const asked = analystNextState(drafted, { reply: 'what horizon?' })
    assert.deepEqual(asked.draft, DRAFT, 'the draft stays — it is the subject')
    assert.equal(asked.standing, false, 'but it can no longer be saved')

    const reopened = analystDesk.stateFromEntity({ id: 'cov_9', symbol: 'AAPL', rating: 'hold' })
    assert.equal(reopened.standing, false)
    assert.equal(reopened.editingSymbol, 'AAPL')
    assert.equal(analystNextState(reopened, { coverage: { symbol: 'AAPL' } }).editingSymbol, 'AAPL', 'carried across turns')
})

// ─── the actions, through the session route ───────────────────────────────────

function rig({ prom = null, commit: over = {} } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const calls = { initiate: [], revise: [], seal: [] }
    const commit = {
        REMODEL: { revision_kind: 'remodel', revision_note: 'Coverage updated via Prometheus' },
        initiateOrRevise: async (d) => { calls.initiate.push(d); return over.initiateOrRevise?.(d) ?? { ok: true, doc: { id: 'cov_1', symbol: d.symbol }, revised: false } },
        revise:           async (id, p) => { calls.revise.push({ id, p }); return over.revise?.() ?? { ok: true, doc: { id, symbol: p.symbol } } },
    }
    const desks = { analyst: { ...analystDesk, actions: makeAnalystActions({ commit }) } }
    const sealing = { sealFromSession: async (args) => { calls.seal.push(args); await sessions.setAgentState({ sessionId: args.sessionId, userId: args.userId, agent: args.agent, state: null }); return { sealed: 1 } } }
    const { act } = makeAct({ sessions, desks, sealing, lock: (_id, fn) => fn() })
    return { sessions, calls, async start(user = admin) {
        const s = await sessions.getActive({ userId: 'u1', scope: 'main' })
        if (prom) await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst', state: prom })
        return { s, press: (action, args) => act({ user, sessionId: s.sessionId, agent: 'analyst', action, args }) }
    } }
}
const stateOf = async (r, s) => (await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState?.analyst ?? null
const EDITING = { editing: { kind: 'coverage', entityId: 'cov_9' }, editingSymbol: 'NVDA' }

test('initiate saves the standing draft FROM THE SESSION and seals onto the coverage', async () => {
    const r = rig({ prom: { active_symbol: 'NVDA', draft: DRAFT, standing: true } })
    const { s, press } = await r.start()
    const out = await press('initiate', { coverage: { symbol: 'EVIL' } })
    assert.deepEqual(out.result, { coverage: { id: 'cov_1', symbol: 'NVDA' }, revised: false })
    assert.deepEqual(r.calls.initiate[0], DRAFT, 'the session draft — a draft in the args is ignored')
    assert.deepEqual(r.calls.seal[0], { userId: 'u1', sessionId: s.sessionId, agent: 'analyst', kind: 'coverage', entityIds: ['cov_1'], name: 'NVDA' })
    assert.equal(await stateOf(r, s), null)
})

test('coverage is an admin write — a trader\'s press is refused and writes nothing', async () => {
    const r = rig({ prom: { draft: DRAFT, standing: true, ...EDITING } })
    const { s, press } = await r.start(trader)
    assert.deepEqual(await press('initiate'), { reason: 'forbidden' })
    assert.deepEqual(await press('update'), { reason: 'forbidden' })
    assert.equal(r.calls.initiate.length + r.calls.revise.length, 0)
    assert.deepEqual((await stateOf(r, s)).draft, DRAFT)
})

test('a withdrawn draft cannot be saved; a refusal keeps the draft and carries its detail', async () => {
    assert.equal((await (await rig({ prom: { draft: DRAFT, standing: false } }).start()).press('initiate')).reason, 'nothing_to_commit')
    const r = rig({ prom: { draft: DRAFT, standing: true }, commit: { initiateOrRevise: () => ({ ok: false, reason: 'rating_contradicts_target', detail: 'buy with a target below the price' }) } })
    const { s, press } = await r.start()
    assert.deepEqual(await press('initiate'), { reason: 'rating_contradicts_target', extra: { detail: 'buy with a target below the price' } })
    assert.deepEqual((await stateOf(r, s)).draft, DRAFT)
})

test('update revises the thesis being edited as a remodel, and seals only onto it', async () => {
    const r = rig({ prom: { draft: DRAFT, standing: true, ...EDITING } })
    const { press } = await r.start()
    assert.equal((await press('update')).result.revised, true)
    assert.deepEqual(r.calls.revise[0], { id: 'cov_9', p: { ...DRAFT, revision_kind: 'remodel', revision_note: 'Coverage updated via Prometheus' } })
    assert.equal(r.calls.seal[0].onlyIfEditing, true)
    assert.equal((await (await rig({ prom: { draft: DRAFT, standing: true, ...EDITING } }).start()).press('initiate')).reason, 'not_new_coverage')
})

test('update refuses a draft about ANOTHER company than the thesis being revised', async () => {
    const r = rig({ prom: { draft: { ...DRAFT, symbol: 'MSFT' }, standing: true, ...EDITING } })
    const { press } = await r.start()
    assert.deepEqual(await press('update'), { reason: 'wrong_symbol' })
    assert.equal(r.calls.revise.length, 0)
})

test('Later leaves a thesis without saving; Prometheus answers in the coverage routes\' words', async () => {
    const r = rig({ prom: { draft: DRAFT, standing: true, ...EDITING } })
    const { s, press } = await r.start()
    assert.deepEqual(await press('later'), { result: {} })
    assert.equal(await stateOf(r, s), null)
    assert.equal(analystReason('rating_contradicts_target')[0], 422)
    assert.equal(analystReason('wrong_symbol')[0], 409)
    assert.equal(analystDesk.reasons, analystReason)
})
