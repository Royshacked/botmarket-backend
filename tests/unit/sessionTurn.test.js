import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAgentContextService } from '../../services/agentContext.service.js'
import { makeSessionTurn, ownWords } from '../../services/desks/sessionTurn.js'
import { foldPlan, makeSummarizer } from '../../services/desks/summarize.js'
import { DESK_DEFS } from '../../services/desks/index.js'

// A desk turn run against the session (services/desks/sessionTurn.js) — on memDb with a STUB desk, so
// what is tested is the mechanism: what is appended, what the desk is handed, what state is kept, where
// the floor goes, and when the summary folds.

function rig({ run, nextState = (prev, r) => ({ ...(prev ?? {}), last: r.reply }), summarize = async () => 'S' } = {}) {
    const { db, rows } = memDb()
    const getDb = async () => db
    const sessions = makeSessionService({ getDb })
    const contexts = makeAgentContextService({ getDb })
    const seen = []
    const stub = (agent) => ({
        agent,
        run: async (ctx) => { seen.push({ agent, ...ctx }); return run ? run(ctx) : { reply: `${agent} says hi` } },
        done: (r) => ({ reply: r.reply }),
        nextState,
    })
    // Argus keeps its real onRouted: the route-lands-and-resets rule is what some tests below pin.
    const desks = { axl: stub('axl'), mentor: stub('mentor'), scanner: { ...stub('scanner'), onRouted: DESK_DEFS.scanner.onRouted }, strategy: stub('strategy') }
    const turn = makeSessionTurn({ sessions, contexts, desks, experience: async () => 'novice', summarize })
    return { turn, sessions, contexts, rows, seen }
}
const user = { _id: 'u1', role: 'user' }

test('a turn appends the user message and the reply, and hands the desk only its own conversation', async () => {
    const { turn, sessions, seen } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await turn({ user, sessionId: s.sessionId, agent: 'axl', text: 'hello' })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'long NVDA' })
    const all = await sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(all.map(m => `${m.agent}:${m.role}`), ['axl:user', 'axl:assistant', 'mentor:user', 'mentor:assistant'])
    // Mentor never saw Axl's turns.
    assert.deepEqual(seen[1].common.messages, [{ role: 'user', content: 'long NVDA' }])
    assert.equal(seen[1].common.audience, 'novice')
})

test('the working state is folded by the desk and kept for the next turn', async () => {
    const { turn, sessions, seen } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'one' })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'two' })
    assert.deepEqual(seen[1].state, { last: 'mentor says hi' })
    assert.deepEqual((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState.mentor, { last: 'mentor says hi' })
})

test('a reply that routes moves the floor to that desk’s agent; otherwise the agent that answered keeps it', async () => {
    const { turn, sessions } = rig({ run: (ctx) => (ctx.common.messages.at(-1).content === 'go'
        ? { reply: 'Sending you to Mentor', route: 'assist', opening: 'long NVDA' }
        : { reply: 'ok' }) })
    const s = await sessions.getActive({ userId: 'u1' })
    await turn({ user, sessionId: s.sessionId, agent: 'axl', text: 'hi' })
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).floor, 'axl')
    const out = await turn({ user, sessionId: s.sessionId, agent: 'axl', text: 'go' })
    assert.equal(out.payload.route, 'assist')
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).floor, 'mentor')
})

test('a trade starts at Mentor — a `trade` route hands the floor to Mentor, never to Argus (Roy, 2026-10-19)', async () => {
    const { turn, sessions } = rig({ run: () => ({ reply: 'Mentor will take it from here', route: 'trade' }) })
    const s = await sessions.getActive({ userId: 'u1' })
    await turn({ user, sessionId: s.sessionId, agent: 'axl', text: 'i want to talk to the trader' })
    const h = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(h.floor, 'mentor')
    assert.equal(h.agentState?.scanner, undefined)
})

test('a route from Axl with no opening carries the user’s own words, so the desk speaks first (Roy, 2026-10-19)', async () => {
    const { turn, sessions } = rig({ run: () => ({ reply: 'Mentor will take it from here', route: 'assist' }) })
    const s = await sessions.getActive({ userId: 'u1' })
    const out = await turn({ user, sessionId: s.sessionId, agent: 'axl', text: '  i want to talk to the trader ' })
    assert.equal(out.payload.opening, 'i want to talk to the trader')
})

test('ownWords: Axl only, never over an opening the model wrote, never without a route or words', () => {
    const r = { route: 'assist', opening: null }
    assert.equal(ownWords(r, 'axl', 'trade it').opening, 'trade it')
    assert.equal(ownWords({ route: 'assist', opening: 'Long NVDA' }, 'axl', 'go').opening, 'Long NVDA')
    assert.equal(ownWords(r, 'mentor', 'yes'), r)               // a desk's own route: "yes" is no opening
    assert.equal(ownWords({ route: null, opening: null }, 'axl', 'hi').opening, null)
    assert.equal(ownWords(r, 'axl', '   '), r)
})

test('Mentor sending the user to Argus presets Argus to find ONE name and hand it back to Mentor', async () => {
    const { turn, sessions } = rig({ run: (ctx) => (ctx.common.messages.at(-1).content === 'yes, find me one'
        ? { reply: 'Argus will find you a name', route: 'scan', opening: 'A swing long in semis' }
        : { reply: 'ok' }) })
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'scanner', state: { profile: 'trading' } })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'yes, find me one' })
    const h = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(h.floor, 'scanner')
    assert.equal(h.agentState.scanner.handoff, true)
    assert.equal(h.agentState.scanner.handoffTo, 'mentor')
    assert.equal(h.agentState.scanner.profile, 'trading')
})

test('the hand-back preset never outlives it — a later plain scan route from Axl finds Argus listing again', async () => {
    let from = 'mentor'
    const { turn, sessions } = rig({ run: () => ({ reply: 'routing', route: 'scan' }) })
    const s = await sessions.getActive({ userId: 'u1' })
    await turn({ user, sessionId: s.sessionId, agent: from, text: 'find me a name' })
    from = 'axl'
    await turn({ user, sessionId: s.sessionId, agent: from, text: 'now a watchlist' })
    const st = (await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState.scanner
    assert.equal(st.handoff, false)
    assert.equal(st.handoffTo, null)
})

test('a route to an admin desk from the main chat moves no floor — that desk keeps its own panel', async () => {
    const { turn, sessions } = rig({ run: () => ({ reply: 'to Pythia', route: 'strategy' }) })
    const s = await sessions.getActive({ userId: 'admin1' })
    await turn({ user: { _id: 'admin1', role: 'admin' }, sessionId: s.sessionId, agent: 'axl', text: 'industry view' })
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'admin1' })).floor, 'axl')
})

test('an agent speaks only in its own scope, and an admin desk only for an admin', async () => {
    const { turn, sessions } = rig()
    const main = await sessions.getActive({ userId: 'u1' })
    assert.equal((await turn({ user, sessionId: main.sessionId, agent: 'strategy', text: 'x' })).reason, 'forbidden')
    const pyth = await sessions.getActive({ userId: 'u1', scope: 'strategy' })
    assert.equal((await turn({ user, sessionId: pyth.sessionId, agent: 'strategy', text: 'x' })).reason, 'forbidden')   // a trader
    const ok = await turn({ user: { _id: 'u1', role: 'admin' }, sessionId: pyth.sessionId, agent: 'strategy', text: 'x' })
    assert.ok(ok.payload)
})

test('a summary that covers no further than the stored one is dropped (a slow fold never wins)', async () => {
    const { sessions } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setSummary({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', summary: { text: '', throughSeq: 40 } })
    assert.equal((await sessions.setSummary({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', summary: { text: 'old fold', throughSeq: 30 } })).reason, 'stale')
    assert.deepEqual((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).summaries.mentor, { text: '', throughSeq: 40 })
})

test('messagesForAgent reads only the agent’s rows and the hand-offs addressed to it', async () => {
    const { sessions } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    for (const m of [
        { agent: 'axl', role: 'user', content: 'a' },
        { agent: 'portfolio', role: 'assistant', kind: 'handoff', content: 'scan this', to: 'scanner' },
        { agent: 'scanner', role: 'assistant', content: 'b' },
        { agent: 'mentor', role: 'assistant', content: 'filled' },
    ]) await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: m })
    const rows = await sessions.messagesForAgent({ sessionId: s.sessionId, userId: 'u1', agent: 'scanner' })
    assert.deepEqual(rows.map(r => r.content), ['scan this', 'b'])
    assert.equal(await sessions.messagesForAgent({ sessionId: s.sessionId, userId: 'u2', agent: 'scanner' }), null)
})

test('a stopped turn keeps the user’s message and stores nothing it produced', async () => {
    const { turn, sessions } = rig({ run: () => null })
    const s = await sessions.getActive({ userId: 'u1' })
    const out = await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'wait' })
    assert.deepEqual(out, { stopped: true })
    const all = await sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(all.map(m => m.role), ['user'])
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState.mentor, undefined)
})

test('an unknown agent, another user’s session, or an archived one is refused before anything is written', async () => {
    const { turn, sessions, rows } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    assert.equal((await turn({ user, sessionId: s.sessionId, agent: 'kairos', text: 'x' })).reason, 'invalid_agent')
    assert.equal((await turn({ user: { _id: 'u2' }, sessionId: s.sessionId, agent: 'axl', text: 'x' })).reason, 'not_found')
    assert.equal(rows('session_messages').length, 0)
})

test('while editing, the sealed context is loaded into the agent’s conversation and the marker survives the turn', async () => {
    const { turn, sessions, contexts, seen } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await contexts.seal({ userId: 'u1', kind: 'setup', entityId: 'st1', agent: 'mentor', messages: [{ role: 'user', content: 'long AMD' }], summary: 'built Oct 3' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { editing: { kind: 'setup', entityId: 'st1' } } })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'move the stop' })
    assert.deepEqual(seen[0].common.messages.map(m => m.content), ['Earlier, on this item (summary): built Oct 3', 'long AMD', 'move the stop'])
    assert.deepEqual((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState.mentor.editing, { kind: 'setup', entityId: 'st1' })
})

// ── the summary fold ────────────────────────────────────────────────────────

test('foldPlan waits for the high-water mark, then folds down to maxMessages', () => {
    const seg = (n) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, agent: 'mentor', role: i % 2 ? 'assistant' : 'user', kind: 'msg', content: `m${i}` }))
    assert.equal(foldPlan(seg(24), 'mentor', null, 8), null)               // 24 = 8 × 3: not past it
    const plan = foldPlan(seg(25), 'mentor', null, 8)
    assert.equal(plan.fold.length, 17)
    assert.equal(plan.throughSeq, 17)
    assert.equal(foldPlan(seg(25), 'mentor', { throughSeq: 17 }, 8), null) // already folded
})

test('a turn past the mark folds the summary in the background; a failed summary changes nothing', async () => {
    const { turn, sessions } = rig({ summarize: async ({ turns }) => `summary of ${turns.length}` })
    const s = await sessions.getActive({ userId: 'u1' })
    // Mentor's maxMessages is 8 — 13 turns put 26 of its messages in the session, past 24.
    for (let i = 0; i < 13; i++) await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: `t${i}` })
    await new Promise(r => setTimeout(r, 10))
    const sum = (await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).summaries.mentor
    assert.match(sum.text, /^summary of \d+$/)
    assert.ok(sum.throughSeq > 0)

    const failing = rig({ summarize: async () => null })
    const f = await failing.sessions.getActive({ userId: 'u1' })
    for (let i = 0; i < 13; i++) await failing.turn({ user, sessionId: f.sessionId, agent: 'mentor', text: `t${i}` })
    await new Promise(r => setTimeout(r, 10))
    assert.equal((await failing.sessions.get({ sessionId: f.sessionId, userId: 'u1' })).summaries.mentor, undefined)
})

test('the summarizer books its usage to the user, and answers null on a failed call', async () => {
    const booked = []
    const ok = makeSummarizer({ once: async ({ onUsage }) => { onUsage({ input_tokens: 10 }, 'haiku'); return '  short summary ' }, record: async (...a) => booked.push(a) })
    assert.equal(await ok({ userId: 'u1', agent: 'mentor', turns: [{ role: 'user', content: 'x' }] }), 'short summary')
    assert.deepEqual(booked[0].slice(0, 2), ['u1', 'haiku'])
    assert.equal(booked[0][3], 'summary')
    const bad = makeSummarizer({ once: async () => { throw new Error('down') }, record: async () => {} })
    assert.equal(await bad({ userId: 'u1', agent: 'mentor', turns: [] }), null)
})
