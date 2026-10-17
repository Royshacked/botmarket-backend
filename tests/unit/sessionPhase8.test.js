import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAct } from '../../services/desks/act.js'
import { makeMentorActions, mentorApplyEdit } from '../../services/desks/actions/mentor.actions.js'
import { mentorDesk } from '../../services/desks/mentor.desk.js'
import { portfolioDesk, portfolioNextState } from '../../services/desks/portfolio.desk.js'
import { strategyDesk } from '../../services/desks/strategy.desk.js'
import { framePayload } from '../../services/desks/index.js'
import { draftVerdict } from '../../services/setupVerdict.js'

// Unified-chat phase 8a: a desk's commits read the draft from the SESSION through one route with desk-owned
// actions (K2); direct edits are a validated state patch (K3); the surfaces read agentState, which carries what
// they show, and the live done frame drops what the state already holds (K4).

const user  = { _id: 'u1', role: 'trader' }
const DRAFT = {
    asset: 'NVDA', direction: 'long', type: 'swing',
    conditions:  [{ id: 'c1', text: 'CHoCH up on the 15m' }],
    entry_legs:  [{ price: 238.6, quantity: 100 }],
    stop_legs:   [{ price: 234.8 }],
    target_legs: [{ price: 246 }],
}
const ACCOUNTS = [{ id: 'a1', broker: 'paper' }]

function rig({ setups = {}, mentorState = null, scope = 'main' } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const calls = { generate: [], batch: [], patch: [], resolve: [], seal: [] }
    const fakeSetups = {
        generateSetup:  async (draft, opts) => { calls.generate.push({ draft, opts }); return setups.generate?.(draft, opts) ?? { ok: true, doc: { id: 'new1', asset: draft.asset, status: 'waiting' } } },
        generateSetups: async (list, opts) => { calls.batch.push({ list, opts }); return setups.batch?.(list) ?? { saved: list.map((d, i) => ({ id: `s${i}`, asset: d.asset })), failed: [] } },
        patchSetup:     async (id, patch, uid) => { calls.patch.push({ id, patch, uid }); return setups.patch?.() ?? { ok: true, doc: { id, status: 'looking' } } },
    }
    const actions = makeMentorActions({ setups: fakeSetups, resolveCards: async (subject, o) => { calls.resolve.push({ subject, o }) } })
    const desks = { mentor: { ...mentorDesk, actions } }
    const sealing = { sealFromSession: async (args) => { calls.seal.push(args); await sessions.setAgentState({ sessionId: args.sessionId, userId: args.userId, agent: args.agent, state: null }); return { sealed: 1 } } }
    const { act, editState } = makeAct({ sessions, desks, sealing, lock: (_id, fn) => fn() })
    return { sessions, act, editState, calls, async start() {
        const s = await sessions.getActive({ userId: 'u1', scope })
        if (mentorState) await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: mentorState })
        return s
    } }
}
const stateOf = async (r, s, agent = 'mentor') => (await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState?.[agent] ?? null

// ─── K2: commits from the session ─────────────────────────────────────────────

test('Generate saves the draft FROM THE SESSION with the marked accounts, seals onto the new setup, then waits on Arm', async () => {
    const r = rig({ mentorState: { active_asset: 'NVDA', draft: DRAFT, coverage: ['direction'] } })
    const s = await r.start()
    const out = await r.act({ user, sessionId: s.sessionId, agent: 'mentor', action: 'generate', args: { accounts: ACCOUNTS, mainAccountId: 'a1', draft: { asset: 'EVIL' } } })
    assert.deepEqual(out, { result: { setup: { id: 'new1', asset: 'NVDA', status: 'waiting' } } })
    assert.deepEqual(r.calls.generate[0].draft, DRAFT, 'the session draft — a draft in the args is ignored')
    assert.deepEqual(r.calls.generate[0].opts, { userId: 'u1', accounts: ACCOUNTS, mainAccountId: 'a1', updateId: null, chatState: { draft: DRAFT, coverage: ['direction'] } })
    assert.deepEqual(r.calls.seal[0], { userId: 'u1', sessionId: s.sessionId, agent: 'mentor', kind: 'setup', entityIds: ['new1'], name: 'NVDA setup', onlyIfEditing: false })
    assert.deepEqual((await stateOf(r, s)).generated, { id: 'new1', asset: 'NVDA', status: 'waiting' })
    assert.equal(r.calls.resolve.length, 0, 'a new setup satisfies no card')
})

test('Update (editing a saved setup) passes its id, resolves its cards, seals only while editing it, and ends the edit', async () => {
    const r = rig({ mentorState: { draft: DRAFT, coverage: [], editing: { kind: 'setup', entityId: 'old7' } } })
    const s = await r.start()
    await r.act({ user, sessionId: s.sessionId, agent: 'mentor', action: 'generate', args: { accounts: ACCOUNTS } })
    assert.equal(r.calls.generate[0].opts.updateId, 'old7')
    assert.deepEqual(r.calls.resolve[0], { subject: { kind: 'setup', id: 'old7' }, o: { outcome: 'completed' } })
    assert.equal(r.calls.seal[0].onlyIfEditing, true)
    assert.equal(await stateOf(r, s), null)
})

test('refusals: no draft, no account, the service’s own reason, an unknown action, a desk with no actions', async () => {
    const r = rig({ mentorState: { draft: null } })
    const s = await r.start()
    const go = (action, args = { accounts: ACCOUNTS }, agent = 'mentor') => r.act({ user, sessionId: s.sessionId, agent, action, args })
    assert.deepEqual(await go('generate'), { reason: 'nothing_to_commit' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: DRAFT } })
    assert.deepEqual(await go('generate', {}), { reason: 'no_venue' })
    assert.deepEqual(await go('explode'), { reason: 'no_such_action' })
    assert.deepEqual(await go('../../x'), { reason: 'no_such_action' })
    assert.deepEqual(await go('generate', {}, 'analyst'), { reason: 'invalid_agent' }, 'no analyst desk in this rig')
    const refused = rig({ mentorState: { draft: DRAFT }, setups: { generate: () => ({ ok: false, reason: 'missing_target' }) } })
    const s2 = await refused.start()
    assert.deepEqual(await refused.act({ user, sessionId: s2.sessionId, agent: 'mentor', action: 'generate', args: { accounts: ACCOUNTS } }), { reason: 'missing_target' })
    assert.equal(refused.calls.seal.length, 0, 'a refused save seals nothing')
    assert.deepEqual((await stateOf(refused, s2)).draft, DRAFT, 'and leaves the draft')
})

test('a desk in another scope cannot be pressed; nor can a missing session', async () => {
    const r = rig()
    const strat = await r.sessions.getActive({ userId: 'u1', scope: 'strategy' })
    assert.deepEqual(await r.act({ user, sessionId: strat.sessionId, agent: 'mentor', action: 'generate', args: {} }), { reason: 'forbidden' })
    assert.deepEqual(await r.act({ user, sessionId: 'nope', agent: 'mentor', action: 'generate', args: {} }), { reason: 'not_found' })
})

test('Generate all: partial success saves the good ones and keeps the refused plans on the table', async () => {
    const AMD = { ...DRAFT, asset: 'AMD' }, TSM = { ...DRAFT, asset: 'TSM' }
    const r = rig({
        mentorState: { draft: DRAFT, drafts: { AMD, TSM }, coverage: [] },
        setups: { batch: (list) => ({ saved: list.filter(d => d.asset !== 'TSM').map(d => ({ id: `id_${d.asset}`, asset: d.asset })), failed: [{ index: 2, asset: 'TSM', reason: 'missing_target' }] }) },
    })
    const s = await r.start()
    const out = await r.act({ user, sessionId: s.sessionId, agent: 'mentor', action: 'generateAll', args: { accounts: ACCOUNTS } })
    assert.equal(out.result.saved.length, 2)
    assert.deepEqual(r.calls.batch[0].list.map(d => d.asset).sort(), ['AMD', 'NVDA', 'TSM'])
    assert.deepEqual(r.calls.seal[0].entityIds.sort(), ['id_AMD', 'id_NVDA'])
    const left = await stateOf(r, s)
    assert.equal(left.draft.asset, 'TSM')
    assert.ok(left.generated)
})

test('Arm arms the generated setup (the service re-runs the gate) and ends the build; Leave waiting ends it too', async () => {
    const r = rig({ mentorState: { generated: { id: 'new1', asset: 'NVDA' } } })
    const s = await r.start()
    assert.deepEqual(await r.act({ user, sessionId: s.sessionId, agent: 'mentor', action: 'arm' }), { result: { setup: { id: 'new1', status: 'looking' } } })
    assert.deepEqual(r.calls.patch[0], { id: 'new1', patch: { status: 'looking' }, uid: 'u1' })
    assert.equal(await stateOf(r, s), null)
    assert.deepEqual(await r.act({ user, sessionId: s.sessionId, agent: 'mentor', action: 'leave' }), { reason: 'nothing_to_commit' })
})

// ─── K3: direct edits ─────────────────────────────────────────────────────────

test('a hand edit to the draft is re-judged — readiness and gate recomputed — and keeps what it is editing', async () => {
    const r = rig({ mentorState: { draft: { ...DRAFT, target_legs: [] }, coverage: [], view: { gate: null, readiness: { ready: false } }, editing: { kind: 'setup', entityId: 'old7' } } })
    const s = await r.start()
    assert.deepEqual(await r.editState({ user, sessionId: s.sessionId, agent: 'mentor', edit: { draft: DRAFT, accounts: ACCOUNTS } }), { ok: true })
    const st = await stateOf(r, s)
    assert.deepEqual(st.draft.target_legs, [{ price: 246 }])
    assert.equal(st.view.readiness.ready, true)
    assert.deepEqual(st.editing, { kind: 'setup', entityId: 'old7' })
    assert.deepEqual(await r.editState({ user, sessionId: s.sessionId, agent: 'mentor', edit: { draft: 'nonsense' } }), { reason: 'invalid_setup' })
    assert.deepEqual(await r.editState({ user, sessionId: s.sessionId, agent: 'mentor', edit: {} }), { reason: 'invalid_edit' })
})

test('applyEdit and the validate route share ONE verdict', () => {
    assert.equal(draftVerdict(null, true), null)
    const v = draftVerdict(DRAFT, true)
    assert.equal(v.readiness.ready, true)
    assert.equal(mentorApplyEdit(null, { draft: DRAFT }).reason, 'nothing_to_edit')
})

// ─── K4: what the surfaces read ───────────────────────────────────────────────

test('the live done frame drops what the state already holds; the chain still has the full payload', () => {
    const payload = { reply: 'x', setup: DRAFT, gate: { stage: 'spans' }, readiness: {}, coverage: [], build: {}, route: null }
    assert.deepEqual(framePayload('mentor', payload), { reply: 'x', route: null })
    assert.deepEqual(framePayload('axl', { reply: 'y', suggestions: ['a'] }), { reply: 'y', suggestions: ['a'] })
    assert.equal(framePayload('mentor', null), null)
})

test('Atlas: a review card opens it in review mode; Axl’s adopt opens the adopt grid; the notices are kept', () => {
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

// ─── phase 8a bug hunt ────────────────────────────────────────────────────────

test("#1: a hand edit never rewrites the build ledger — the session's is kept, the client's dropped", () => {
    const ledger = { stage: 'entries', confirmed: ['direction'] }
    const forged = { ...DRAFT, build: { stage: 'ready', confirmed: ['direction', 'entries', 'size'] } }
    assert.deepEqual(mentorApplyEdit({ draft: { ...DRAFT, build: ledger } }, { draft: forged }).state.draft.build, ledger)
    assert.equal('build' in mentorApplyEdit({ draft: DRAFT }, { draft: forged }).state.draft, false, 'no ledger on the server → none from the client')
    assert.equal(mentorApplyEdit({ draft: DRAFT }, { draft: 'x' }).reason, 'invalid_setup')
})

test("#2: only a desk's OWN actions run — inherited names are no action at all", async () => {
    const r = rig({ mentorState: { draft: DRAFT } })
    const s = await r.start()
    for (const action of ['constructor', 'valueOf', 'toString', 'hasOwnProperty']) {
        assert.deepEqual(await r.act({ user, sessionId: s.sessionId, agent: 'mentor', action }), { reason: 'no_such_action' }, action)
    }
})

test('#4: once the entity is saved, a failed state write is said — never answered as a failure', async () => {
    const r = rig({ mentorState: { active_asset: 'NVDA', draft: DRAFT } })
    const s = await r.start()
    const flaky = { ...r.sessions, setAgentState: async () => { throw new Error('mongo down') } }
    const { act } = makeAct({ sessions: flaky, desks: { mentor: { ...mentorDesk, actions: makeMentorActions({ setups: { generateSetup: async (d) => ({ ok: true, doc: { id: 'n1', asset: d.asset } }) }, resolveCards: async () => {} }) } }, sealing: { sealFromSession: async () => ({ sealed: 0 }) }, lock: (_id, fn) => fn() })
    const out = await act({ user, sessionId: s.sessionId, agent: 'mentor', action: 'generate', args: { accounts: ACCOUNTS } })
    assert.deepEqual(out, { result: { setup: { id: 'n1', asset: 'NVDA' } }, stateWritten: false })
})
