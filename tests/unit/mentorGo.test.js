import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeChainRunner } from '../../services/chain/runner.js'
import { makeActRig, TRADER } from '../helpers/actRig.js'
import { _parseGo } from '../../services/agents/mentor.agent.service.js'
import { mentorNextState } from '../../services/desks/mentor.desk.js'
import { makeMentorActions } from '../../services/desks/actions/mentor.actions.js'
import { setupReason } from '../../api/setups/setupReasons.js'

// ONE ANSWER, THEN BUILT, GENERATED AND ARMED (docs/design/argus-rework.md §2.2, Roy 2026-11-12): Mentor asks position
// size, risk and R:R once; when he is done he says <go> with the three numbers; CODE generates and arms through the
// same pipe a press takes, with the same gates. Nothing reaches a broker — an armed setup's entry is still a card.

const user = TRADER

test('<go>: the three numbers, all positive, or no go at all', () => {
    assert.deepEqual(_parseGo('Done.\n<go>{"position_size": 5000, "risk": 100, "rr": 2}</go>'), { position_size: 5000, risk: 100, rr: 2 })
    assert.deepEqual(_parseGo('<go>{"position_size": "5000", "risk": "100", "rr": "2.5"}</go>'), { position_size: 5000, risk: 100, rr: 2.5 })
    assert.equal(_parseGo('<go>{"position_size": 5000, "risk": 100}</go>'), null, 'no R:R — the runner never acts on a guess')
    assert.equal(_parseGo('<go>{"position_size": 5000, "risk": -1, "rr": 2}</go>'), null)
    assert.equal(_parseGo('no tag here'), null)
})

test("the numbers are KEPT on Mentor's state — a later turn without a go keeps them; a held go's accounts survive a turn ON ITS NAME", () => {
    const s1 = mentorNextState({ active_asset: 'TSLA' }, { reply: 'x', go: { position_size: 5000, risk: 100, rr: 2 } })
    assert.deepEqual(s1.risk_plan, { position_size: 5000, risk: 100, rr: 2 })
    const held = { accounts: [{ id: 'a1' }], mainAccountId: 'a1', symbol: 'TSLA' }
    const s2 = mentorNextState({ ...s1, go_pending: held }, { reply: 'y' })
    assert.deepEqual(s2.risk_plan, s1.risk_plan)
    assert.deepEqual(s2.go_pending, held)
    assert.equal(mentorNextState(null, { reply: 'z' }).risk_plan, undefined)
    // CR 2026-11-12: the user moved to NVDA — TSLA's accounts are not NVDA's.
    assert.equal(mentorNextState({ ...s1, go_pending: held }, { reply: 'n', taggedAsset: 'NVDA' }).go_pending, undefined)
})

// ─── the action: save, then arm ──────────────────────────────────────────────
const draftState = { draft: { asset: 'NVDA' }, risk_plan: { position_size: 5000, risk: 100, rr: 2 } }
function commitFake({ arm = { ok: true } } = {}) {
    const calls = []
    return {
        calls,
        commitSetup: async (draft, o) => { calls.push(['commit', draft.asset, o.accounts.length]); return { ok: true, doc: { id: 's1', asset: draft.asset, status: 'waiting' } } },
        armSetup: async (id) => { calls.push(['arm', id]); return arm.ok ? { ok: true, doc: { id, asset: 'NVDA', status: 'looking' } } : { ok: false, reason: arm.reason } },
    }
}
const ctx = (state = draftState, accounts = [{ id: 'a1' }]) => ({ user, sessionId: 'x', state, args: { accounts, mainAccountId: 'a1' } })

test('generateArmed: saved, then armed — one action, the seal on the saved setup', async () => {
    const commit = commitFake()
    const { generateArmed } = makeMentorActions({ commit, readPending: async () => false })
    const out = await generateArmed(ctx())   // detached, as the pipe calls it
    assert.deepEqual(commit.calls, [['commit', 'NVDA', 1], ['arm', 's1']])
    assert.equal(out.result.armed, true)
    assert.equal(out.result.setup.status, 'looking')
    assert.deepEqual(out.seal, { kind: 'setup', entityIds: ['s1'], name: 'NVDA setup' })
})

test("generateArmed: an arm the gate refuses leaves the setup SAVED and says why; generate's own gates refuse first", async () => {
    const commit = commitFake({ arm: { ok: false, reason: 'cannot_arm_no_broker' } })
    const out = await makeMentorActions({ commit, readPending: async () => false }).generateArmed(ctx())
    assert.equal(out.result.armed, false)
    assert.equal(out.result.armReason, 'cannot_arm_no_broker')
    assert.ok(out.seal, 'still saved, still sealed')
    const held = await makeMentorActions({ commit: commitFake(), readPending: async () => true }).generateArmed(ctx())
    assert.deepEqual(held, { reason: 'read_pending' })
    const noVenue = await makeMentorActions({ commit: commitFake(), readPending: async () => false }).generateArmed(ctx(draftState, []))
    assert.deepEqual(noVenue, { reason: 'no_venue' })
})

// ─── the pipe: a held press, and the line saying it was armed ────────────────
test("a held press acts on the state as it is (no revision to name), and the session ends 'saved and armed'", async () => {
    const desk = { hasWork: (s) => !!s?.draft, actions: { generateArmed: async () => ({ result: { setup: { id: 's1' }, armed: true }, seal: { kind: 'setup', entityIds: ['s1'], name: 'NVDA setup' }, after: null }) } }
    const r = makeActRig({ agent: 'mentor', desk, state: draftState, midChain: false })
    const { s } = await r.start(user)
    const out = await r.actHeld({ user, sessionId: s.sessionId, agent: 'mentor', action: 'generateArmed', args: {} })
    assert.ok(out.result.nextSessionId)
    const [line] = await r.sessions.messagesSince({ sessionId: out.result.nextSessionId, userId: 'u1' })
    assert.equal(line.content, "✓ Built NVDA setup — saved and armed to your Setups, watching. You're back with Axl.")
    // A client press still names its revision — a stale one is still refused.
    const r2 = makeActRig({ agent: 'mentor', desk, state: draftState, midChain: false })
    const { s: s2 } = await r2.start(user)
    assert.equal((await r2.act({ user, sessionId: s2.sessionId, agent: 'mentor', action: 'generateArmed', args: {}, rev: 99 })).reason, 'stale_state')
})

// ─── the runner's go step ────────────────────────────────────────────────────
function rig({ act } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const reads = { target: () => null, request: async () => ({ asked: false }) }
    const runner = makeChainRunner({ sessions, loadUser: async (id) => ({ _id: id, role: 'trader' }), reads, desks: { mentor: { reasons: setupReason } } })
    const pressed = [], queued = []
    runner.bindRunQueued(async (a) => { queued.push(a); return {} })
    runner.bindAct(async (p) => { pressed.push(p); return act ? act(p) : { result: { armed: true, nextSessionId: 'n1' } } })
    return { sessions, runner, pressed, queued }
}
const go = { position_size: 5000, risk: 100, rr: 2 }
const accounts = [{ id: 'a1' }]
const rows = (sessions, s) => sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })

test("a go with the turn's marked accounts: generate-and-arm is pressed through the held pipe, and nothing else runs", async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: draftState })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Done.', go } }, input: { accounts, mainAccountId: 'a1' } })
    assert.deepEqual(r.pressed, [{ user, sessionId: s.sessionId, agent: 'mentor', action: 'generateArmed', args: { accounts, mainAccountId: 'a1' } }])
})

test('no go tag → no press; no account marked → one line asking for it, nothing pressed', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: draftState })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Size?' } }, input: { accounts } })
    assert.equal(r.pressed.length, 0)
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Done.', go } }, input: { accounts: [] } })
    assert.equal(r.pressed.length, 0)
    const [line] = await rows(r.sessions, s)
    assert.match(line.content, /no account is marked/)
})

test("a go held by Prometheus's read keeps the accounts; the chain turn after the read lands goes with them", async () => {
    let first = true
    const r = rig({ act: async () => (first ? (first = false, { reason: 'read_pending' }) : { result: { armed: true } }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: draftState })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Done.', go } }, input: { accounts, mainAccountId: 'a1' } })
    const kept = (await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState.mentor
    assert.deepEqual(kept.go_pending, { accounts, mainAccountId: 'a1', symbol: 'NVDA' })
    // The read landed: Mentor's chain turn (no accounts of its own) says go again.
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { payload: { reply: 'Read is for it. Done.', go } }, input: {} })
    assert.deepEqual(r.pressed[1].args, { accounts, mainAccountId: 'a1' })
})

test("a held go never generates ANOTHER name on its accounts (CR 2026-11-12)", async () => {
    const r = rig({ act: async () => ({ result: { armed: true } }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor',
        state: { ...draftState, active_asset: 'AMD', draft: { asset: 'AMD' }, go_pending: { accounts, mainAccountId: 'a1', symbol: 'NVDA' } } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { payload: { reply: 'Done.', go } }, input: {} })
    assert.equal(r.pressed.length, 0)
    assert.match((await rows(r.sessions, s)).at(-1).content, /mark one in the account picker/)
})

test('a go that throws says so in the chat; nothing is reported as generated', async () => {
    const r = rig({ act: async () => { throw new Error('db down') } })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: draftState })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Done.', go } }, input: { accounts } })
    assert.match((await rows(r.sessions, s)).at(-1).content, /Something went wrong generating it — nothing was saved/)
})

test('any other refusal: one line in the setup routes\' own words, nothing saved', async () => {
    const r = rig({ act: async () => ({ reason: 'missing_stop' }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: draftState })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Done.', go } }, input: { accounts } })
    const [line, hand] = await rows(r.sessions, s)
    assert.equal(line.content, 'Not generated yet — missing_stop.')
    // …and the build goes back to Mentor to fix it and say go again (the TSLA drive, 2026-11-12) — nobody else will.
    assert.equal(hand.kind, 'handoff')
    assert.equal(r.queued.length, 1)
    assert.equal(r.queued[0].agent, 'mentor')
})

// ─── Atlas's go: the book generated, no accounts needed, activation stays the user's ─────────────────────────────
const SIZED = { pendingPlan: { ideas: [{ asset: 'MA', quantity: 10 }], positionSize: 50000 } }
function atlasRig(act) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const runner = makeChainRunner({ sessions, loadUser: async (id) => ({ _id: id, role: 'trader' }), reads: { target: () => null, request: async () => ({}) },
        desks: { portfolio: { reasons: { plan_not_ready: [409, 'The plan is not sized yet — every holding needs a share count'] } } } })
    const pressed = []
    runner.bindRunQueued(async () => ({}))
    runner.bindAct(async (p) => { pressed.push(p); return act ? act(p) : { result: {} } })
    return { sessions, runner, pressed }
}

test("Atlas's go presses generate with the marked accounts — no arm (activating the book stays the user's press)", async () => {
    const r = atlasRig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'portfolio', state: SIZED })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'portfolio', origin: 'user', out: { payload: { reply: 'Built.', go: true } }, input: { accounts, mainAccountId: 'a1' } })
    assert.deepEqual(r.pressed, [{ user, sessionId: s.sessionId, agent: 'portfolio', action: 'generate', args: { accounts, mainAccountId: 'a1' } }])
    // None marked: one line, nothing pressed — a book with no venue saves nothing (the Atlas drive, 2026-11-12: nothing_saved).
    const r2 = atlasRig()
    const s2 = await r2.sessions.getActive({ userId: 'u1' })
    await r2.runner.afterTurn({ user, sessionId: s2.sessionId, agent: 'portfolio', origin: 'user', out: { payload: { reply: 'Built.', go: true } }, input: {} })
    assert.equal(r2.pressed.length, 0)
    assert.match((await rows(r2.sessions, s2))[0].content, /no account is marked to put the book in/)
})

test("Atlas's refused go says why in the book routes' own words (a reasons TABLE, not a function)", async () => {
    const r = atlasRig(async () => ({ reason: 'plan_not_ready' }))
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'portfolio', state: SIZED })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'portfolio', origin: 'user', out: { payload: { reply: 'Built.', go: true } }, input: { accounts } })
    const [line] = await rows(r.sessions, s)
    assert.equal(line.agent, 'portfolio')
    assert.equal(line.content, 'Not generated yet — The plan is not sized yet — every holding needs a share count.')
})

test('a desk without a go (Argus, Prometheus) never presses anything', async () => {
    const r = atlasRig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'analyst', origin: 'user', out: { payload: { reply: 'x', go: true } }, input: {} })
    assert.equal(r.pressed.length, 0)
})

// ─── a build cut short by the tool budget is carried on (Roy, 2026-11-12: auto-continue) ─────────────────────────
test('a cut-short turn is carried on: a hand-off line to the same desk, its turn queued with the marked accounts — at most 3 in a row', async () => {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const runner = makeChainRunner({ sessions, loadUser: async (id) => ({ _id: id, role: 'trader' }), reads: { target: () => null, request: async () => ({}) } })
    const queued = []
    runner.bindRunQueued(async (a) => { queued.push(a); return {} })
    const s = await sessions.getActive({ userId: 'u1' })
    const turn = (origin) => runner.afterTurn({ user, sessionId: s.sessionId, agent: 'portfolio', origin, out: { payload: { reply: 'More next turn.', cut_short: true } }, input: { accounts, mainAccountId: 'a1', ops: ['x'] } })
    await turn('user')
    assert.equal(queued.length, 1)
    assert.equal(queued[0].agent, 'portfolio')
    assert.equal(queued[0].origin, 'chain')
    assert.equal(queued[0].text, null)
    assert.deepEqual(queued[0].input, { accounts, mainAccountId: 'a1' }, 'the per-turn extras only — never a card press')
    const [hand] = await rows(sessions, s)
    assert.equal(hand.kind, 'handoff')
    assert.equal(hand.to, 'portfolio')
    await turn('chain'); await turn('chain')
    assert.equal(queued.length, 3)
    await turn('chain')
    assert.equal(queued.length, 3, 'the fourth in a row is not carried')
    assert.match((await rows(sessions, s)).at(-1).content, /say "continue"/)
    await turn('user')
    assert.equal(queued.length, 4, 'the user spoke: the count starts again')
})

test('a cut-short turn of a desk without a go (Prometheus) is not carried on', async () => {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const runner = makeChainRunner({ sessions, loadUser: async (id) => ({ _id: id, role: 'trader' }), reads: { target: () => null, request: async () => ({}) } })
    const queued = []
    runner.bindRunQueued(async (a) => { queued.push(a); return {} })
    const s = await sessions.getActive({ userId: 'u1' })
    await runner.afterTurn({ user, sessionId: s.sessionId, agent: 'analyst', origin: 'user', out: { payload: { reply: 'x', cut_short: true } }, input: {} })
    assert.equal(queued.length, 0)
})

test("Atlas's go REFUSES without the book's capital — one line asking for it, nothing pressed (Roy, 2026-11-12)", async () => {
    const r = atlasRig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'portfolio', state: { pendingPlan: { ideas: [{ asset: 'MA', quantity: null }], positionSize: null } } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'portfolio', origin: 'user', out: { payload: { reply: 'Built.', go: true } }, input: { accounts } })
    assert.equal(r.pressed.length, 0)
    assert.equal((await rows(r.sessions, s))[0].content, 'The book is built, but I need its capital before I generate it — how much should it deploy?')
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'portfolio', state: { pendingPlan: { ideas: [{ asset: 'MA', quantity: 10 }], positionSize: 50000 } } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'portfolio', origin: 'user', out: { payload: { reply: 'Built.', go: true } }, input: { accounts } })
    assert.equal(r.pressed.length, 1, 'with the capital, it goes')
})
