import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeActRig, shapeOf, TRADER } from '../helpers/actRig.js'
import { makeMentorActions, mentorApplyEdit } from '../../services/desks/actions/mentor.actions.js'
import { mentorDesk } from '../../services/desks/mentor.desk.js'
import { portfolioDesk, portfolioNextState } from '../../services/desks/portfolio.desk.js'
import { strategyDesk } from '../../services/desks/strategy.desk.js'
import { framePayload } from '../../services/desks/index.js'
import { keepMarkers } from '../../services/desks/markers.js'
import { draftVerdict } from '../../services/setupVerdict.js'
import { makeSetupCommit } from '../../api/setups/setupCommit.service.js'
import { _reasonsFor } from '../../api/sessions/sessions.controller.js'

// Unified-chat phase 8a: a desk's commits read the draft from the SESSION through one route with desk-owned
// actions (K2); direct edits are a validated state patch (K3); the surfaces read agentState, which carries what
// they show, and the live done frame drops what the state already holds (K4). Every press names the revision it
// was made on (CR D2). This file: the pipe, and Mentor.

const user  = TRADER
const DRAFT = {
    asset: 'NVDA', direction: 'long', type: 'swing',
    conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
    entry_legs:  [{ price: 238.6, quantity: 100 }],
    stop_legs:   [{ price: 234.8 }],
    target_legs: [{ price: 246 }],
}
const ACCOUNTS = [{ id: 'a1', broker: 'paper' }]
const EDITING  = { editing: { kind: 'setup', entityId: 'old7' } }

function rig({ commit = {}, state = null, sessions } = {}) {
    const calls = { commit: [], batch: [], arm: [] }
    const fake = {
        commitSetup:    async (draft, opts) => { calls.commit.push({ draft, opts }); return commit.commit?.(draft, opts) ?? { ok: true, doc: { id: opts.updateId ?? 'new1', asset: draft.asset, status: 'waiting' } } },
        generateSetups: async (list, opts) => { calls.batch.push({ list, opts }); return commit.batch?.(list) ?? { saved: list.map((d, i) => ({ id: `s${i}`, asset: d.asset })), failed: [] } },
        armSetup:       async (id, uid) => { calls.arm.push({ id, uid }); return commit.arm?.() ?? { ok: true, doc: { id, status: 'looking' } } },
    }
    const r = makeActRig({ agent: 'mentor', desk: { ...mentorDesk, actions: makeMentorActions({ commit: fake }) }, state, sessions })
    return { ...r, calls }
}

// ─── the pipe ─────────────────────────────────────────────────────────────────

test('the pipe: an unknown or inherited action, an unknown agent, another scope, a missing session', async () => {
    const r = rig({ state: { draft: DRAFT } })
    const { s, press, rev } = await r.start(user)
    for (const action of ['explode', '../../x', 'constructor', 'valueOf', 'toString', 'hasOwnProperty']) {
        assert.deepEqual(await press(action), { reason: 'no_such_action' }, action)
    }
    assert.deepEqual(await r.act({ user, sessionId: s.sessionId, agent: 'analyst', action: 'generate', rev: await rev() }), { reason: 'invalid_agent' })
    const strat = await r.sessions.getActive({ userId: 'u1', scope: 'strategy' })
    assert.deepEqual(await r.act({ user, sessionId: strat.sessionId, agent: 'mentor', action: 'generate', rev: 0 }), { reason: 'forbidden' })
    assert.deepEqual(await r.act({ user, sessionId: 'nope', agent: 'mentor', action: 'generate', rev: 0 }), { reason: 'not_found' })
})

test('D2: a press or an edit made on a state a turn has since replaced is refused, with the current revision', async () => {
    const r = rig({ state: { draft: DRAFT } })
    const { press, edit, rev, setState } = await r.start(user)
    const seen = await rev()
    await setState({ draft: { ...DRAFT, asset: 'AMD' } })   // a turn landed meanwhile
    assert.deepEqual(await press('generate', { accounts: ACCOUNTS }, { rev: seen }), { reason: 'stale_state', extra: { rev: seen + 1 } })
    assert.deepEqual(await edit({ draft: DRAFT }, { rev: seen }), { reason: 'stale_state', extra: { rev: seen + 1 } })
    assert.equal(r.calls.commit.length, 0, 'nothing was saved from the old draft')
    assert.equal((await press('generate', { accounts: ACCOUNTS }, { rev: 'x' })).reason, 'stale_state', 'a press must name its revision')
    const ok = await press('generate', { accounts: ACCOUNTS })
    assert.equal(ok.result.setup.asset, 'AMD')
    assert.equal(ok.rev, await rev(), 'the answer names the revision the next press uses')
})

test('the session\'s refusals mean the same on every desk; a desk\'s own words come after', () => {
    assert.deepEqual(_reasonsFor('mentor')('invalid_edit'), [400, 'That change is not valid'], 'not swallowed by the setup table\'s invalid_* rule')
    assert.equal(_reasonsFor('mentor')('nothing_saved')[0], 409)
    assert.equal(_reasonsFor('mentor')('stale_state')[0], 409)
    assert.equal(_reasonsFor('mentor')('missing_target')[1], 'missing_target', 'Mentor\'s own lookup')
    assert.equal(_reasonsFor('portfolio')('book_live')[0], 409, 'a desk table')
    assert.equal(_reasonsFor('analyst')('rating_contradicts_target')[0], 422)
    assert.equal(_reasonsFor('axl')('whatever'), null)
})

test('keepMarkers carries what the desk\'s fold knows nothing about', () => {
    assert.deepEqual(keepMarkers({ a: 1 }, { editing: { kind: 'scan', entityId: 's' }, chainId: 'c1', b: 2 }), { a: 1, editing: { kind: 'scan', entityId: 's' }, chainId: 'c1' })
    assert.equal(keepMarkers(null, { editing: {} }), null, 'cleared work stays cleared')
})

test('once the entity is saved, a failed state write is said — never answered as a failure', async () => {
    const base = rig({ state: { active_asset: 'NVDA', draft: DRAFT } })
    const { s, rev } = await base.start(user)
    const flaky = { ...base.sessions, setAgentState: async () => { throw new Error('mongo down') } }
    const r = rig({ sessions: flaky })
    const out = await r.act({ user, sessionId: s.sessionId, agent: 'mentor', action: 'generate', args: { accounts: ACCOUNTS }, rev: await rev() })
    assert.deepEqual(out, { result: { setup: { id: 'new1', asset: 'NVDA', status: 'waiting' } }, rev: null, stateWritten: false })
})

// ─── Mentor: commits from the session ─────────────────────────────────────────

test('generate saves the draft FROM THE SESSION with the marked accounts, seals onto the new setup, then waits on Arm', async () => {
    const r = rig({ state: { active_asset: 'NVDA', draft: DRAFT, coverage: ['direction'] } })
    const { s, press, stateOf } = await r.start(user)
    const out = await press('generate', { accounts: ACCOUNTS, mainAccountId: 'a1', draft: { asset: 'EVIL' } })
    assert.deepEqual(shapeOf(out), { result: { setup: { id: 'new1', asset: 'NVDA', status: 'waiting' } } })
    assert.deepEqual(r.calls.commit[0].draft, DRAFT, 'the session draft — a draft in the args is ignored')
    assert.deepEqual(r.calls.commit[0].opts, { userId: 'u1', accounts: ACCOUNTS, mainAccountId: 'a1', updateId: null, chatState: { draft: DRAFT, coverage: ['direction'] } })
    assert.deepEqual(r.seals[0], { userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['new1'], name: 'NVDA setup' })
    assert.deepEqual((await stateOf()).generated, { id: 'new1', asset: 'NVDA', status: 'waiting' })
})

test('update saves onto the setup being edited, seals only while editing it, and ends the edit; generate refuses there', async () => {
    const r = rig({ state: { draft: DRAFT, coverage: [], ...EDITING } })
    const { press, stateOf } = await r.start(user)
    assert.deepEqual(await press('generate', { accounts: ACCOUNTS }), { reason: 'not_new' })
    await press('update', { accounts: ACCOUNTS })
    assert.equal(r.calls.commit[0].opts.updateId, 'old7', 'setupCommit resolves the cards it satisfies')
    assert.equal(r.seals[0].onlyIfEditing, true)
    assert.equal(await stateOf(), null)
    assert.deepEqual(await (await rig({ state: { draft: DRAFT } }).start(user)).press('update', { accounts: ACCOUNTS }), { reason: 'nothing_to_commit' })
})

test('refusals: no draft, no account, the service\'s own reason — and a refused save keeps the draft', async () => {
    assert.deepEqual(await (await rig({ state: { draft: null } }).start(user)).press('generate', { accounts: ACCOUNTS }), { reason: 'nothing_to_commit' })
    assert.deepEqual(await (await rig({ state: { draft: DRAFT } }).start(user)).press('generate', {}), { reason: 'no_venue' })
    const r = rig({ state: { draft: DRAFT }, commit: { commit: () => ({ ok: false, reason: 'missing_target' }) } })
    const { press, stateOf } = await r.start(user)
    assert.deepEqual(await press('generate', { accounts: ACCOUNTS }), { reason: 'missing_target' })
    assert.equal(r.seals.length, 0, 'a refused save seals nothing')
    assert.deepEqual((await stateOf()).draft, DRAFT)
})

test('generateAll: partial success saves the good ones and keeps the refused plans; all refused is a refusal', async () => {
    const AMD = { ...DRAFT, asset: 'AMD' }, TSM = { ...DRAFT, asset: 'TSM' }
    const r = rig({
        state: { draft: DRAFT, drafts: { AMD, TSM }, coverage: [] },
        commit: { batch: (list) => ({ saved: list.filter(d => d.asset !== 'TSM').map(d => ({ id: `id_${d.asset}`, asset: d.asset })), failed: [{ index: 2, asset: 'TSM', reason: 'missing_target' }] }) },
    })
    const { press, stateOf } = await r.start(user)
    const out = await press('generateAll', { accounts: ACCOUNTS })
    assert.equal(out.result.setups.length, 2)
    assert.deepEqual(r.calls.batch[0].list.map(d => d.asset).sort(), ['AMD', 'NVDA', 'TSM'])
    assert.deepEqual(r.seals[0].entityIds.sort(), ['id_AMD', 'id_NVDA'])
    const left = await stateOf()
    assert.equal(left.draft.asset, 'TSM')
    assert.ok(left.generated)

    const none = rig({ state: { draft: DRAFT, drafts: { AMD } }, commit: { batch: () => ({ saved: [], failed: [{ index: 0, asset: 'NVDA', reason: 'missing_target' }] }) } })
    assert.deepEqual(await (await none.start(user)).press('generateAll', { accounts: ACCOUNTS }), { reason: 'nothing_saved', extra: { failed: [{ index: 0, asset: 'NVDA', reason: 'missing_target' }] } })
    const many = rig({ state: { draft: DRAFT, drafts: { AMD } }, commit: { batch: () => ({ saved: [], failed: [], reason: 'too_many', max: 10 }) } })
    assert.deepEqual(await (await many.start(user)).press('generateAll', { accounts: ACCOUNTS }), { reason: 'too_many', extra: { max: 10 } })
})

test('arm arms the generated setup and ends the build; leave ends it too', async () => {
    const r = rig({ state: { generated: { id: 'new1', asset: 'NVDA' } } })
    const { press, stateOf } = await r.start(user)
    assert.deepEqual(shapeOf(await press('arm')), { result: { setup: { id: 'new1', status: 'looking' } } })
    assert.deepEqual(r.calls.arm[0], { id: 'new1', uid: 'u1' })
    assert.equal(await stateOf(), null)
    assert.deepEqual(await press('leave'), { reason: 'nothing_to_commit' })
})

test('setupCommit closes the cards an update or an arm satisfies — after the write, never on a refusal or a new setup', async () => {
    const resolved = []
    const commit = makeSetupCommit({
        setups: {
            generateSetup: async (d, o) => (d.bad ? { ok: false, reason: 'missing_target' } : { ok: true, doc: { id: o.updateId ?? 'n1' } }),
            patchSetup:    async (id) => (id === 'bad' ? { ok: false, reason: 'cannot_arm_venue' } : { ok: true, doc: { id } }),
            generateSetups: async () => ({ saved: [], failed: [] }),
        },
        resolveCards: async (subject, o) => { resolved.push({ subject, o }) },
    })
    await commit.commitSetup(DRAFT, { updateId: null })
    await commit.commitSetup({ bad: true }, { updateId: 'old7' })
    assert.equal(resolved.length, 0)
    await commit.commitSetup(DRAFT, { updateId: 'old7' })
    await commit.armSetup('s1', 'u1')
    await commit.armSetup('bad', 'u1')
    assert.deepEqual(resolved, [{ subject: { kind: 'setup', id: 'old7' }, o: { outcome: 'completed' } }, { subject: { kind: 'setup', id: 's1' }, o: { outcome: 'completed' } }])
})

// ─── Mentor: direct edits ─────────────────────────────────────────────────────

test('a hand edit to the draft is re-judged — readiness and gate recomputed — and keeps what it is editing', async () => {
    const r = rig({ state: { draft: { ...DRAFT, target_legs: [] }, coverage: [], view: { gate: null, readiness: { ready: false } }, ...EDITING } })
    const { edit, stateOf, rev } = await r.start(user)
    const out = await edit({ draft: DRAFT, accounts: ACCOUNTS })
    assert.deepEqual(out, { ok: true, rev: await rev() })
    const st = await stateOf()
    assert.deepEqual(st.draft.target_legs, [{ price: 246 }])
    assert.equal(st.view.readiness.ready, true)
    assert.deepEqual(st.editing, EDITING.editing)
    assert.deepEqual(await edit({ draft: 'nonsense' }), { reason: 'invalid_setup' })
    assert.deepEqual(await edit({}), { reason: 'invalid_edit' })
})

test('a hand edit never rewrites the build ledger — the session\'s is kept, the client\'s dropped', () => {
    const ledger = { stage: 'entries', confirmed: ['direction'] }
    const forged = { ...DRAFT, build: { stage: 'ready', confirmed: ['direction', 'entries', 'size'] } }
    assert.deepEqual(mentorApplyEdit({ draft: { ...DRAFT, build: ledger } }, { draft: forged }).state.draft.build, ledger)
    assert.equal('build' in mentorApplyEdit({ draft: DRAFT }, { draft: forged }).state.draft, false, 'no ledger on the server → none from the client')
    assert.equal(mentorApplyEdit({ draft: DRAFT }, { draft: 'x' }).reason, 'invalid_setup')
    assert.equal(mentorApplyEdit(null, { draft: DRAFT }).reason, 'nothing_to_edit')
})

test('a FRESH plan (a shared setup) clears the table and the markers — it is never written onto the setup being edited', async () => {
    const r = rig({ state: { draft: DRAFT, drafts: { AMD: DRAFT }, coverage: ['direction'], ...EDITING, chainId: 'c1' } })
    const { edit, stateOf } = await r.start(user)
    const shared = { ...DRAFT, asset: 'TSLA', build: { stage: 'ready' } }
    assert.equal((await edit({ draft: shared, fresh: true })).ok, true)
    const st = await stateOf()
    assert.equal(st.draft.asset, 'TSLA')
    assert.equal('build' in st.draft, false, 'no ledger arrives with someone else\'s plan')
    assert.deepEqual(st.drafts, {})
    assert.deepEqual(st.coverage, [])
    assert.equal(st.editing, undefined, 'an Update now has nothing to write it onto')
    assert.equal(st.chainId, undefined)
    // Opened with nothing on Mentor's table at all — allowed for a fresh plan only.
    assert.equal(mentorApplyEdit(null, { draft: DRAFT, fresh: true }).state.draft.asset, 'NVDA')
    assert.equal(mentorApplyEdit(null, { draft: DRAFT }).reason, 'nothing_to_edit')
})

test('applyEdit and the validate route share ONE verdict', () => {
    assert.equal(draftVerdict(null, true), null)
    assert.equal(draftVerdict(DRAFT, true).readiness.ready, true)
})

// ─── K4: what the surfaces read ───────────────────────────────────────────────

test('the live done frame drops what the state already holds; the chain still has the full payload', () => {
    const payload = { reply: 'x', setup: DRAFT, gate: { stage: 'spans' }, readiness: {}, coverage: [], build: {}, route: null }
    assert.deepEqual(framePayload('mentor', payload), { reply: 'x', route: null })
    assert.deepEqual(framePayload('axl', { reply: 'y', suggestions: ['a'] }), { reply: 'y', suggestions: ['a'] })
    assert.equal(framePayload('mentor', null), null)
})

test('Atlas: a review card opens it in review mode; Axl\'s adopt opens the adopt grid; the notices are kept', () => {
    assert.equal(portfolioDesk.stateFromEntity({ portfolioId: 'p1' }, { reviewMode: true }).reviewMode, true)
    assert.equal(portfolioDesk.stateFromEntity({ portfolioId: 'p1' }).reviewMode, false)
    const landed = portfolioDesk.onRouted({ portfolioId: null, pendingPlan: { ideas: [1] } }, { adopt: true })
    assert.equal(landed.adopt, true)
    assert.deepEqual(landed.pendingPlan, { ideas: [1] }, 'a second route does not throw away the plan')
    assert.equal(portfolioDesk.onRouted(null, undefined).adopt, false)
    const next = portfolioNextState({ adopt: true }, { screenRequests: [{ sector: 'Energy' }], coverageRequest: { symbol: 'XOM' } })
    assert.deepEqual(next.notices, { screenRequests: [{ sector: 'Energy' }], coverageRequest: { symbol: 'XOM' } })
    assert.equal(next.adopt, true)
})

test('Pythia keeps the assessments its drafts came with', () => {
    const s1 = strategyDesk.nextState(null, { views: [{ code: '1' }], assessments: [{ q: 'demand' }] })
    assert.deepEqual(s1.assessments, [{ q: 'demand' }])
    assert.deepEqual(strategyDesk.nextState(s1, { views: [] }).assessments, [{ q: 'demand' }])
})
