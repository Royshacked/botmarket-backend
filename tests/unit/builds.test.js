import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAgentContextService } from '../../services/agentContext.service.js'
import { makeBuilds, buildTitle, buildLines, stillWorking } from '../../services/desks/builds.js'
import { makeSessionTurn } from '../../services/desks/sessionTurn.js'

// A build in the background (docs/design/modes-and-builders.md step 5b): queued / building / awaiting / ready / failed.

const user = { _id: 'u1', role: 'user' }

function rig({ depth = () => 0 } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const turns = []
    const builds = makeBuilds({ sessions, depth, runTurn: async (x) => { turns.push(x) } })
    return { db, sessions, builds, turns }
}
const st = async (sessions, s) => (await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState

test('a build is titled by its work', () => {
    assert.equal(buildTitle('mentor', { name: { choice: 'NVDA' } }), 'NVDA trade')
    assert.equal(buildTitle('mentor', { name: { choice: 'Find one for me' } }), 'a trade')
    assert.equal(buildTitle('mentor', { name: { other: 'amd' } }), 'AMD trade')
    assert.equal(buildTitle('portfolio', { objective: { choice: 'Growth' } }), 'Growth book')
    assert.deepEqual(buildLines({ mentor: { build: { title: 'NVDA trade', status: 'ready' } }, portfolio: { build: { title: 'Growth book', status: 'queued' } } }),
        ['- the trader: NVDA trade — READY — waiting for the user to review and Generate it in the pane', '- the portfolio manager: Growth book — queued behind another build'])
})

test('one build at a time: a second is queued with its answers, and starts when the first is ready (M10)', async () => {
    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    const a = await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: { asked: true }, title: 'NVDA trade', text: 't', input: {} })
    assert.equal(a.run, true)
    const b = await builds.start({ user, sessionId: s.sessionId, agent: 'portfolio', state: null, title: 'Growth book', text: 'answers', input: { accounts: [{ id: 'p1' }] } })
    assert.equal(b.run, false)
    assert.equal((await st(sessions, s)).portfolio.build.status, 'queued')
    await builds.ready({ user, sessionId: s.sessionId, agent: 'mentor' })
    const now = await st(sessions, s)
    assert.equal(now.mentor.build.status, 'ready')
    assert.equal(now.portfolio.build.status, 'building', 'the queued one started')
    assert.equal(now.portfolio.build.pending, undefined)
    assert.deepEqual([turns[0].agent, turns[0].text, turns[0].origin, turns[0].input.accounts[0].id], ['portfolio', 'answers', 'opening', 'p1'])
})

test('a build turn that leaves nothing in flight needs the user: its last reply comes into the chat, the mode goes back to the builder', async () => {
    const { sessions, builds } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: {}, title: 'NVDA trade', text: 't', input: {} })
    const id = (await st(sessions, s)).mentor.build.id
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', content: 'Which of the two stops?', ref: { build: id } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } }), 'awaiting')
    const row = (await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })).at(-1)
    assert.deepEqual(row.ref, { fromBuild: id }, 'shown in the chat now')
    const ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.floor, 'mentor')
    assert.equal(ses.agentState.mentor.build.status, 'awaiting')
})

test('a build with something in flight keeps building; a failed turn fails it', async () => {
    assert.equal(stillWorking({ chain: { status: 'running', origin: 'mentor' } }, 'mentor'), true)
    assert.equal(stillWorking({ agentState: { mentor: { go_pending: {} } } }, 'mentor'), true)
    assert.equal(stillWorking({ waiting: { 'NVDA|coverage': { symbol: 'NVDA', kind: 'coverage' } } }, 'mentor'), true)
    assert.equal(stillWorking({ waiting: { 'echo|ev': { kind: 'echo_map' } } }, 'mentor'), false, "the event analyst's map is not the build's")
    assert.equal(stillWorking({}, 'mentor', 2), true, 'a turn queued behind this one')
    assert.equal(stillWorking({ chain: { status: 'running', origin: 'portfolio' } }, 'mentor'), false)

    const { sessions, builds } = rig({ depth: () => 2 })
    const s = await sessions.getActive({ userId: 'u1' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: {}, title: 'x', text: 't', input: {} })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } }), null)
    assert.equal((await st(sessions, s)).mentor.build.status, 'building')
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { reason: 'error' } }), 'failed')
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'axl', out: {} }), null, 'only builders build')
})

test("a building turn keeps no floor and its reply is the build's; the user turning to the builder takes it over in words", async () => {
    const { db, sessions, builds } = rig()
    const contexts = makeAgentContextService({ getDb: async () => db })
    const mentor = { agent: 'mentor', run: async () => ({ reply: 'Levels drawn.' }), done: (r) => ({ reply: r.reply }), nextState: (p) => ({ ...(p ?? {}), draft: { asset: 'NVDA' } }) }
    const noCards = { post: async () => ({ reason: 'off' }), setAside: async ({ state }) => state }
    const turn = makeSessionTurn({ sessions, contexts, desks: { mentor }, experience: async () => 'novice', profiles: { read: async () => ({ notes: [], size: null }) }, summarize: async () => 'S', asks: noCards })
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'axl' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: { asked: true }, title: 'NVDA trade', text: 't', input: {} })
    const id = (await st(sessions, s)).mentor.build.id

    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'My answers…', origin: 'opening', input: { answered: true } })
    let ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.floor, 'axl', 'the chat stays with Axl')
    assert.equal((await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })).at(-1).ref.build, id)
    assert.deepEqual([ses.agentState.mentor.build.status, ses.agentState.mentor.draft.asset], ['building', 'NVDA'], 'the fold keeps the build (markers)')

    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'use a tighter stop', origin: 'user' })
    ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.agentState.mentor.build.status, 'awaiting')
    assert.equal(ses.floor, 'mentor')
    assert.equal((await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })).at(-1).ref, null, 'in words, in the chat')
})

test("a build's go is READY — never saved on its own (runner)", async () => {
    const { makeChainRunner } = await import('../../services/chain/runner.js')
    const { sessions } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' }, build: { id: 'b1', status: 'building', title: 'NVDA trade', since: 1 } } })
    const readied = []
    const runner = makeChainRunner({ sessions, builds: { ready: async (x) => { readied.push(x.agent) } } })
    let acted = false
    runner.bindAct(async () => { acted = true; return {} })
    await runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', turnId: 't', origin: 'opening', out: { payload: { go: { position_size: 1 } } }, input: {} })
    assert.deepEqual(readied, ['mentor'])
    assert.equal(acted, false, 'no generate, no arm')
})

test("a build's later turns (a chain step after a read lands) bind to the card's account; lines said for it are the pane's (the drive, 2026-11-20)", async () => {
    const { buildRef } = await import('../../services/desks/builds.js')
    assert.deepEqual(buildRef({ build: { id: 'b1', status: 'building' } }), { build: 'b1' })
    assert.equal(buildRef({ build: { id: 'b1', status: 'awaiting' } }), null)
    assert.equal(buildRef(null), null)

    const { db, sessions, builds } = rig()
    const contexts = makeAgentContextService({ getDb: async () => db })
    const seen = []
    const mentor = { agent: 'mentor', run: async ({ input }) => { seen.push(input); return { reply: 'ok' } }, done: (r) => ({ reply: r.reply }), nextState: (p) => p }
    const noCards = { post: async () => ({ reason: 'off' }), setAside: async ({ state }) => state }
    const turn = makeSessionTurn({ sessions, contexts, desks: { mentor }, experience: async () => 'novice', profiles: { read: async () => ({ notes: [], size: null }) }, summarize: async () => 'S', asks: noCards })
    const s = await sessions.getActive({ userId: 'u1' })
    const acct = { id: 'p1', broker: 'paper' }
    await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: {}, title: 'AMD trade', text: 't', input: { accounts: [acct], mainAccountId: 'p1' } })
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'user', kind: 'handoff', to: 'mentor', content: 'The read is in.' } })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', input: {} })
    assert.deepEqual([seen[0].accounts, seen[0].mainAccountId], [[acct], 'p1'])
})

test('a build that stopped on a statement is carried on (twice at most); one that asks the user goes to them (the drive, 2026-11-20)', async () => {
    const { asksTheUser, carryLine, MAX_CARRIES } = await import('../../services/desks/builds.js')
    assert.equal(asksTheUser('What dollar amount are you willing to risk?'), true)
    assert.equal(asksTheUser('Which of the two?\n\n- A: $436\n- B: $514'), true, 'a question with its options under it')
    assert.equal(asksTheUser("I can't generate the entry because the earlier figures aren't in this turn, and I won't invent them."), false)
    assert.match(carryLine(), /call your tools again for any figure you need/)

    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: {}, title: 'AMD trade', text: 't', input: {} })
    const id = (await st(sessions, s)).mentor.build.id
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', content: "I won't invent the figures.", ref: { build: id } } })
    for (let i = 0; i < MAX_CARRIES; i++) assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } }), 'carried')
    assert.equal(turns.length, MAX_CARRIES)
    assert.equal(turns[0].origin, 'opening')
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } }), 'awaiting', 'then it is the user\'s')
})

test("a read landing hands the build its turn WITHOUT the floor; the build's go ends its chain (the drive, 2026-11-20)", async () => {
    const { makeChainRunner } = await import('../../services/chain/runner.js')
    const { sessions } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'axl' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'AMD' }, build: { id: 'b1', status: 'building', title: 'AMD trade', since: 1 } } })
    const ran = []
    const runner = makeChainRunner({ sessions, builds: { ready: async () => {} }, loadUser: async () => user })
    runner.bindRunQueued(async (x) => { ran.push(x.agent); return {} })
    // The hand-off a landed read makes (the same hop readSettled runs).
    const chain = { id: 'c1', status: 'running', origin: 'mentor', steps: 0 }
    await sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain })
    await runner._hop({ user, session: await sessions.get({ sessionId: s.sessionId, userId: 'u1' }), chain, art: { kind: 'prometheus_read', items: [{ ticker: 'AMD', facts: 'a hold' }] }, from: 'analyst' })
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).floor, 'axl', 'the chat stays with Axl')

    await runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', turnId: 't', origin: 'chain', out: { payload: { go: {} } }, input: {} })
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).chain.status, 'done')
})

test("a build's go that could not be generated yet is carried on with what is missing — not READY (the drive, 2026-11-20)", async () => {
    const { makeChainRunner } = await import('../../services/chain/runner.js')
    const { sessions } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: {
        draft: { asset: 'AMD' }, view: { readiness: { ready: false, missing: ['quantity on pullback'], problems: [] } },
        build: { id: 'b1', status: 'building', title: 'AMD trade', since: 1 },
    } })
    const carried = [], readied = []
    const runner = makeChainRunner({ sessions, builds: { carry: async (x) => { carried.push(x.note); return true }, ready: async (x) => { readied.push(x.agent) } } })
    await runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', turnId: 't', origin: 'opening', out: { payload: { go: {} } }, input: {} })
    assert.deepEqual(readied, [])
    assert.match(carried[0], /still needs quantity on pullback/)
})

test("the summary's Change, a failed build's Retry, a stale one's Recheck send the build back to work (step 6)", async () => {
    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    const put = (status) => sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'AMD' }, build: { id: 'b1', status, title: 'AMD trade', since: 1, readyAt: Date.now() - 45 * 60_000, carries: 3 } } })
    await put('ready')
    assert.deepEqual(await builds.rework({ user, sessionId: s.sessionId, agent: 'mentor', kind: 'change', text: 'a tighter stop' }), { ok: true })
    let b = (await st(sessions, s)).mentor.build
    assert.deepEqual([b.status, b.carries, b.readyAt, b.change], ['building', 0, undefined, 'a tighter stop'])
    assert.match(turns.at(-1).text, /asks for a change: "a tighter stop"\. Make exactly that change/)
    assert.equal(turns.at(-1).origin, 'opening')

    await put('ready')
    await builds.rework({ user, sessionId: s.sessionId, agent: 'mentor', kind: 'recheck' })
    assert.match(turns.at(-1).text, /made 45 minutes ago\. Recheck it against the current price/)
    await put('failed')
    await builds.rework({ user, sessionId: s.sessionId, agent: 'mentor', kind: 'retry' })
    assert.match(turns.at(-1).text, /Carry on building/)

    await put('building')
    assert.equal((await builds.rework({ user, sessionId: s.sessionId, agent: 'mentor', kind: 'change', text: 'x' })).reason, 'wrong_status')
    await put('ready')
    assert.equal((await builds.rework({ user, sessionId: s.sessionId, agent: 'mentor', kind: 'change', text: ' ' })).reason, 'change_required')
    assert.equal((await builds.rework({ user, sessionId: s.sessionId, agent: 'mentor', kind: 'nuke' })).reason, 'invalid_action')
    assert.equal((await builds.rework({ user, sessionId: s.sessionId, agent: 'portfolio', kind: 'retry' })).reason, 'no_build')
})

test('Dismiss on a build frees the slot — the queued build starts (step 6, M10)', async () => {
    const { makeAct } = await import('../../services/desks/act.js')
    const { db, sessions } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'AMD' }, build: { id: 'b1', status: 'ready', title: 'AMD trade', since: 1 } } })
    const started = []
    const sealing = { putAside: async () => {} }
    const act = makeAct({ sessions, sealing, builds: { startNext: async (x) => { started.push(x.sessionId) } } })
    void db
    const out = await act.act({ user, sessionId: s.sessionId, agent: 'mentor', action: 'discard', args: {}, rev: (await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentRev?.mentor ?? 0 })
    assert.equal(out.reason, undefined, JSON.stringify(out))
    assert.deepEqual(started, [s.sessionId])
})

test("a build that stopped on a statement with a draft that could be generated is READY — go or no go (after a Change, the drive)", async () => {
    const { generatable } = await import('../../services/desks/builds.js')
    assert.equal(generatable({ draft: {}, view: { readiness: { ready: true } } }), true)
    assert.equal(generatable({ draft: {}, view: { readiness: { ready: false } } }), false)
    assert.equal(generatable({ view: { readiness: { ready: true } } }), false, 'no draft, nothing to generate')
    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'AMD' }, view: { readiness: { ready: true } }, build: { id: 'b1', status: 'building', title: 'AMD trade', since: 1 } } })
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', content: 'Kept only scenario A. Press Update to save this edit.', ref: { build: 'b1' } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } }), 'ready')
    assert.equal((await st(sessions, s)).mentor.build.status, 'ready')
    assert.equal(turns.length, 0, 'not carried on')
})
