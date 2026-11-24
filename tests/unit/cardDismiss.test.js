import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAgentContextService } from '../../services/agentContext.service.js'
import { makeBuilds, answerNote, USER_DECLINED } from '../../services/desks/builds.js'
import { makeSessionTurn } from '../../services/desks/sessionTurn.js'
import { makeAsking } from '../../services/desks/asking.js'

// Prod, 2026-11-24 (Roy, on mobile): Axl sent "which semiconductor names?" to the analyst; "Why not nvidia" started an
// NVDA coverage build; its card's "I don't want to update Nvidia" was told "carry on building … then go"; and the card
// had no way back to Axl.

const user = { _id: 'u1', role: 'user' }

function rig() {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const turns = []
    const builds = makeBuilds({ sessions, depth: () => 0, runTurn: async (x) => { turns.push(x) } })
    const asks = makeAsking({ sessions, profiles: { read: async () => ({ notes: [], size: null }) }, runTurn: async () => {}, builds })
    return { db, sessions, builds, asks, turns }
}
const st = async (sessions, s) => (await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState
const rows = (sessions, s) => sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })

test('a question to the analyst in a conversation is a chat turn, never a coverage build (no card was open)', async () => {
    const { db, sessions, builds } = rig()
    const contexts = makeAgentContextService({ getDb: async () => db })
    const analyst = { agent: 'analyst', run: async () => ({ reply: 'It is covered already — rated buy.' }), done: (r) => ({ reply: r.reply }), nextState: (p) => p ?? {} }
    const noCards = { post: async () => ({ reason: 'off' }), setAside: async ({ state }) => state }
    const turn = makeSessionTurn({ sessions, contexts, desks: { analyst }, experience: async () => 'novice', profiles: { read: async () => ({ notes: [], size: null }) }, summarize: async () => 'S', asks: noCards, buildsSvc: builds })
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst' })
    await turn({ user, sessionId: s.sessionId, agent: 'analyst', text: 'Why not nvidia', origin: 'user' })
    const ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.agentState?.analyst?.build, undefined, 'no build')
    assert.equal(ses.floor, 'analyst', 'the conversation stays where it is')
    assert.deepEqual((await rows(sessions, s)).map(r => `${r.role}:${r.ref?.build ? 'build' : '-'}`), ['user:-', 'assistant:-'], 'the reply is in the chat')
})

test("the card's answer may be NO: the note lets the builder stop, and the user's no takes the build off the table", async () => {
    const note = answerNote('analyst', "My answer:\n- I don't want to update Nvidia")
    assert.match(note, /I don't want to update Nvidia/)
    assert.match(note, /do not want this built[\s\S]*PASS — the user does not want this built/)
    assert.match(answerNote('mentor', 'x'), /No trade: the user does not want this built/)
    assert.ok(USER_DECLINED.test('the user does not want this built.'))
    assert.ok(!USER_DECLINED.test("I can't defend a price target"))

    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'analyst', state: {}, title: 'coverage', text: 't', input: {} })
    const id = (await st(sessions, s)).analyst.build.id
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'analyst', role: 'assistant', content: 'PASS — the user does not want this built.', ref: { build: id } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'analyst', out: { payload: {} } }), 'dropped')
    assert.equal((await st(sessions, s)).analyst.build, undefined, 'off the table — nothing to Change or Dismiss')
    assert.equal(turns.length, 0, 'not carried on')
})

test("Not now on a build's card: the card is dismissed, the build dropped, nothing runs, the chat is Axl's", async () => {
    const { sessions, builds, asks, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'analyst', state: { active_symbol: 'NVDA' }, title: 'coverage', text: 't', input: {} })
    const id = (await st(sessions, s)).analyst.build.id
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'analyst', role: 'assistant', content: "Would you like me to update Nvidia's thesis?", ref: { build: id } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'analyst', out: { payload: {} } }), 'awaiting')
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst' })
    const card = (await rows(sessions, s)).at(-1)
    assert.deepEqual(await asks.dismiss({ user, sessionId: s.sessionId, seq: card.seq }), { agent: 'analyst', dismissed: true })
    const ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.floor, 'axl')
    assert.equal(ses.agentState.analyst.build, undefined)
    assert.equal(ses.agentState.analyst.active_symbol, 'NVDA', 'the rest of the table stays')
    assert.equal((await rows(sessions, s)).at(-1).ref.state, 'dismissed')
    assert.equal(turns.length, 0)
    assert.equal((await asks.dismiss({ user, sessionId: s.sessionId, seq: card.seq })).reason, 'already_answered')
})

test('Not now on the up-front card: dismissed, the ask off the table, back to Axl; a stray seq is not found', async () => {
    const { sessions, asks } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    const posted = await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'analyst', role: 'assistant', kind: 'questions', content: 'A few questions before I build it.', ref: { state: 'open', questions: [] } } })
    const seq = posted.message.seq
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst', state: { asking: { seq } } })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst' })
    assert.equal((await asks.dismiss({ user, sessionId: s.sessionId, seq: seq + 5 })).reason, 'not_found')
    assert.deepEqual(await asks.dismiss({ user, sessionId: s.sessionId, seq }), { agent: 'analyst', dismissed: true })
    const ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual([ses.floor, ses.agentState.analyst.asking], ['axl', undefined])
})

// The root of the same prod chat: the picker had left the analyst's card PARKED; the research route's opening then ran as
// a chat turn with the analyst. A route's opening is a new ask: the old card aside, a fresh one with the route's name.
test("a route's opening to a builder with a parked card posts a fresh card — never a chat turn with the builder", async () => {
    const { db, sessions, builds } = rig()
    const contexts = makeAgentContextService({ getDb: async () => db })
    let ran = 0
    const analyst = { agent: 'analyst', run: async () => { ran++; return { reply: 'TSM, ASML, ADI.' } }, done: (r) => ({ reply: r.reply }), nextState: (p) => p ?? {} }
    const asks = makeAsking({ sessions, profiles: { read: async () => ({ notes: [], size: null }) }, runTurn: async () => {}, builds, coverage: { listSymbols: async () => ['NVDA'] } })
    const turn = makeSessionTurn({ sessions, contexts, desks: { analyst }, experience: async () => 'novice', profiles: { read: async () => ({ notes: [], size: null }) }, summarize: async () => 'S', asks, buildsSvc: builds })
    const s = await sessions.getActive({ userId: 'u1' })
    const parked = await asks.post({ user, sessionId: s.sessionId, agent: 'analyst', state: null })
    await turn({ user, sessionId: s.sessionId, agent: 'analyst', text: 'I want coverage on NVDA.', origin: 'opening', input: { routeSymbol: 'NVDA' } })
    assert.equal(ran, 0, 'the analyst did not chat')
    const cards = (await rows(sessions, s)).filter(r => r.kind === 'questions')
    assert.deepEqual(cards.map(c => [c.seq === parked.seq, c.ref.state]), [[true, 'set_aside'], [false, 'open']])
    assert.equal(cards[1].ref.questions[0].default, 'NVDA', "the route's name")
    const ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual([ses.floor, ses.agentState.analyst.asking.seq], ['analyst', cards[1].seq])
})
