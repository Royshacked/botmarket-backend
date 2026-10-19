import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeActRig, shapeOf, ADMIN, TRADER } from '../helpers/actRig.js'
import { makeAnalystActions, ANALYST_REASONS } from '../../services/desks/actions/analyst.actions.js'
import { analystDesk, analystNextState } from '../../services/desks/analyst.desk.js'
import { makeCoverageCommit } from '../../api/analyst/coverageCommit.service.js'

// Unified-chat phase 8a, Prometheus: a STANDING draft is committed FROM THE SESSION through the same service the
// coverage routes use (coverageCommit), and only by an admin — the routes' requireAdmin, held by the action.

const DRAFT  = { symbol: 'NVDA', rating: 'buy', price_target: 260, thesis: 'AI capex runs longer than the Street thinks' }
const REMODEL = { revision_kind: 'remodel', revision_note: 'Coverage updated via Prometheus' }

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
    assert.equal((await covered.commit.initiateOrRevise(DRAFT)).revised, true)
    assert.deepEqual(covered.calls.update[0], { id: 'cov_9', p: { ...DRAFT, ...REMODEL } })

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

function rig({ state = null, commit: over = {} } = {}) {
    const calls = { initiate: [], revise: [] }
    const commit = {
        initiateOrRevise: async (d) => { calls.initiate.push(d); return over.initiateOrRevise?.(d) ?? { ok: true, doc: { id: 'cov_1', symbol: d.symbol }, revised: false } },
        revise:           async (id, p) => { calls.revise.push({ id, p }); return over.revise?.() ?? { ok: true, doc: { id, symbol: p.symbol } } },
    }
    const r = makeActRig({ agent: 'analyst', desk: { ...analystDesk, actions: makeAnalystActions({ commit }) }, state })
    return { ...r, calls }
}
const EDITING = { editing: { kind: 'coverage', entityId: 'cov_9' }, editingSymbol: 'NVDA' }

test('generate saves the standing draft FROM THE SESSION and seals onto the coverage', async () => {
    const r = rig({ state: { active_symbol: 'NVDA', draft: DRAFT, standing: true } })
    const { s, press, stateOf } = await r.start(ADMIN)
    assert.deepEqual(shapeOf(await press('generate', { coverage: { symbol: 'EVIL' } })), { result: { coverage: { id: 'cov_1', symbol: 'NVDA' }, revised: false } })
    assert.deepEqual(r.calls.initiate[0], DRAFT, 'the session draft — a draft in the args is ignored')
    assert.deepEqual(r.seals[0], { userId: 'u1', sessionId: s.sessionId, agent: 'analyst', kind: 'coverage', entityIds: ['cov_1'], name: 'NVDA' })
    assert.equal(await stateOf(), null)
})

test('coverage is an admin write — a trader\'s press is refused and writes nothing', async () => {
    const r = rig({ state: { draft: DRAFT, standing: true, ...EDITING } })
    const { press, stateOf } = await r.start(TRADER)
    assert.deepEqual(await press('generate'), { reason: 'forbidden' })
    assert.deepEqual(await press('update'), { reason: 'forbidden' })
    assert.equal(r.calls.initiate.length + r.calls.revise.length, 0)
    assert.deepEqual((await stateOf()).draft, DRAFT)
})

test('a withdrawn draft cannot be saved; a refusal keeps the draft and carries its detail', async () => {
    assert.equal((await (await rig({ state: { draft: DRAFT, standing: false } }).start(ADMIN)).press('generate')).reason, 'nothing_to_commit')
    const r = rig({ state: { draft: DRAFT, standing: true }, commit: { initiateOrRevise: () => ({ ok: false, reason: 'rating_contradicts_target', detail: 'buy with a target below the price' }) } })
    const { press, stateOf } = await r.start(ADMIN)
    assert.deepEqual(await press('generate'), { reason: 'rating_contradicts_target', extra: { detail: 'buy with a target below the price' } })
    assert.deepEqual((await stateOf()).draft, DRAFT)
})

test('update revises the thesis being edited as a remodel, and seals only onto it; generate refuses there', async () => {
    const r = rig({ state: { draft: DRAFT, standing: true, ...EDITING } })
    const { press } = await r.start(ADMIN)
    assert.equal((await press('generate')).reason, 'not_new')
    assert.equal((await press('update')).result.revised, true)
    assert.deepEqual(r.calls.revise[0], { id: 'cov_9', p: { ...DRAFT, ...REMODEL } })
    assert.equal(r.seals[0].onlyIfEditing, true)
})

test('update refuses a draft about ANOTHER company than the thesis being revised', async () => {
    const r = rig({ state: { draft: { ...DRAFT, symbol: 'MSFT' }, standing: true, ...EDITING } })
    assert.deepEqual(await (await r.start(ADMIN)).press('update'), { reason: 'wrong_symbol' })
    assert.equal(r.calls.revise.length, 0)
})

test('later leaves a thesis without saving; Prometheus answers in the coverage routes\' words', async () => {
    const r = rig({ state: { draft: DRAFT, standing: true, ...EDITING } })
    const { press, stateOf } = await r.start(ADMIN)
    assert.deepEqual(shapeOf(await press('later')), { result: {} })
    assert.equal(await stateOf(), null)
    assert.equal(ANALYST_REASONS.rating_contradicts_target[0], 422)
    assert.equal(ANALYST_REASONS.wrong_symbol[0], 409)
    assert.equal(analystDesk.reasons, ANALYST_REASONS)
})

test('8d CR: a draft about another company while revising is NEW work — Initiate takes it, Later keeps it', async () => {
    const MSFT = { ...DRAFT, symbol: 'MSFT' }
    const r = rig({ state: { draft: MSFT, standing: true, ...EDITING } })
    const { press } = await r.start(ADMIN)
    assert.equal((await press('generate')).result.coverage.symbol, 'MSFT')
    assert.deepEqual(r.calls.initiate[0], MSFT)

    const kept = rig({ state: { draft: MSFT, standing: true, ...EDITING } })
    const k = await kept.start(ADMIN)
    assert.deepEqual(shapeOf(await k.press('later')), { result: {} })
    const st = await k.stateOf()
    assert.deepEqual(st, { active_symbol: 'MSFT', draft: MSFT, standing: true }, 'out of the edit, the draft still on the table')
})
