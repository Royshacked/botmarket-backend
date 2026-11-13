import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAgentContextService } from '../../services/agentContext.service.js'
import { makeSessionTurn, ownWords } from '../../services/desks/sessionTurn.js'
import { foldPlan, makeSummarizer } from '../../services/desks/summarize.js'
import { DESK_DEFS } from '../../services/desks/index.js'
import { makeSealing } from '../../services/desks/seal.js'

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
    // An old session's list state (before 2026-11-09) does not survive the landing.
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'scanner', state: { profile: 'investing', pendingScan: { candidates: [1] } } })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'yes, find me one' })
    const h = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(h.floor, 'scanner')
    assert.deepEqual(h.agentState.scanner, { handoff: true })
})

// Since 2026-11-09 there is no list mode for a later route to find: whatever lands on Argus lands in the single pick
// for Mentor. (A real Axl route to `scan` is dropped in the capture — routing.test.js; this rig hands the route in
// directly, past the capture, so it shows the landing is safe even if one got through.)
test('every landing on Argus is the single pick for Mentor — there is no list mode to fall back to', async () => {
    const { turn, sessions } = rig({ run: () => ({ reply: 'routing', route: 'scan' }) })
    const s = await sessions.getActive({ userId: 'u1' })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'find me a name' })
    await turn({ user, sessionId: s.sessionId, agent: 'axl', text: 'now a watchlist' })
    const st = (await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState.scanner
    assert.deepEqual(st, { handoff: true })
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
    assert.equal((await turn({ user, sessionId: s.sessionId, agent: 'zeus', text: 'x' })).reason, 'invalid_agent')
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

// ─── A turn that finished what it was editing (a setup closed in the chat, 2026-11-05) ─────────────────────

function finishingRig({ sealing } = {}) {
    const { db } = memDb()
    const getDb = async () => db
    const sessions = makeSessionService({ getDb })
    const contexts = makeAgentContextService({ getDb })
    const mentor = {
        agent: 'mentor',
        run: async () => ({ reply: 'Closed.', closedSetup: { id: 'st1', asset: 'AMD' } }),
        done: (r) => ({ reply: r.reply }),
        nextState: () => null,
        sealAfterTurn: DESK_DEFS.mentor.sealAfterTurn,
    }
    const turn = makeSessionTurn({ sessions, contexts, desks: { mentor }, experience: async () => 'novice', summarize: async () => 'S',
        sealing: sealing ?? makeSealing({ sessions, contexts, desks: DESK_DEFS }) })
    return { turn, sessions, contexts }
}
const editingTurn = async ({ turn, sessions }, extra = {}) => {
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { editing: { kind: 'setup', entityId: 'st1' }, draft: { asset: 'AMD' } } })
    const out = await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'close it', ...extra })
    return { s, out }
}

test('closing it in the chat: the conversation goes onto the setup, the reply stays on screen, and the desk starts clean', async () => {
    const rig = finishingRig()
    const { s } = await editingTurn(rig)
    const sealed = await rig.contexts.load({ userId: 'u1', kind: 'setup', entityId: 'st1', agent: 'mentor' })
    assert.deepEqual(sealed.messages.map(m => m.content), ['close it', 'Closed.'])
    const all = await rig.sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(all.map(m => m.content), ['close it', 'Closed.'], 'the timeline is left as the user saw it')
    const after = await rig.sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(after.agentState?.mentor?.editing ?? null, null, 'it is not still editing a closed setup')
    assert.equal(after.agentState?.mentor?.draft ?? null, null)
    assert.equal(after.seals.mentor, after.seq, 'the next seal starts after this work')
})

test('a seal that fails does not fail the turn: the setup is already closed', async () => {
    const rig = finishingRig({ sealing: { sealFromSession: async () => { throw new Error('mongo down') }, putAside: async () => { throw new Error('never') } } })
    const { out } = await editingTurn(rig)
    assert.equal(out.stopped, undefined)
})

test('a close followed by Stop still finishes: the desk is not left editing a closed setup', async () => {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const contexts = makeAgentContextService({ getDb: async () => db })
    const ctl = new AbortController()
    const mentor = {
        agent: 'mentor',
        run: async ({ common }) => { common.onFinished({ closedSetup: { id: 'st1', asset: 'AMD' } }); ctl.abort(); return null },
        done: (r) => ({ reply: r.reply }), nextState: () => null, sealAfterTurn: DESK_DEFS.mentor.sealAfterTurn,
    }
    const turn = makeSessionTurn({ sessions, contexts, desks: { mentor }, experience: async () => 'novice', summarize: async () => 'S', sealing: makeSealing({ sessions, contexts, desks: DESK_DEFS }) })
    const { s, out } = await editingTurn({ turn, sessions }, { signal: ctl.signal })
    assert.equal(out.stopped, true)
    const after = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(after.agentState?.mentor?.editing ?? null, null)
    assert.ok(await contexts.load({ userId: 'u1', kind: 'setup', entityId: 'st1', agent: 'mentor' }))
})

test('a Stop with nothing finished keeps the state, as it always did', async () => {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const contexts = makeAgentContextService({ getDb: async () => db })
    const mentor = { agent: 'mentor', run: async () => null, done: (r) => r, nextState: () => null, sealAfterTurn: DESK_DEFS.mentor.sealAfterTurn }
    const turn = makeSessionTurn({ sessions, contexts, desks: { mentor }, experience: async () => 'novice', summarize: async () => 'S', sealing: makeSealing({ sessions, contexts, desks: DESK_DEFS }) })
    const { s } = await editingTurn({ turn, sessions })
    const after = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(after.agentState.mentor.editing.entityId, 'st1')
})


test('a reply that was ONLY a chart gets its row — the chart on it and one line naming it — so the next turn knows (2026-11-12)', async () => {
    const asks = []
    const { turn, sessions, seen } = rig({ run: (ctx) => {
        asks.push(ctx.common.messages.map(m => `${m.role}:${m.content}`))
        const want = ctx.common.messages.at(-1).content.includes('SPY') ? 'SPY' : 'NVDA'
        ctx.common.onChart?.({ symbol: want, timeframe: 'day', live: true })
        return { reply: '' }   // the chart tag was the whole reply
    } })
    const s = await sessions.getActive({ userId: 'u1' })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'show NVDA daily' })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'and SPY daily' })
    const all = await sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(all.map(m => m.content), ['show NVDA daily', "Here's the NVDA daily chart.", 'and SPY daily', "Here's the SPY daily chart."])
    assert.deepEqual(all[1].ref, { chart: { ticker: 'NVDA', timeframe: 'day' } })
    // The second turn SAW that NVDA was already shown — not two asks in a row.
    assert.deepEqual(asks[1], ['user:show NVDA daily', "assistant:Here's the NVDA daily chart.", 'user:and SPY daily'])
    assert.equal(seen.length, 2)
})

test('a reply WITH words keeps exactly what it had — no chart added to its row from what the turn drew', async () => {
    const { turn, sessions } = rig({ run: (ctx) => { ctx.common.onChart?.({ symbol: 'TSLA', timeframe: 'day' }); return { reply: 'The plan, with its chart below.' } } })
    const s = await sessions.getActive({ userId: 'u1' })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'build it' })
    const [, reply] = await sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(reply.content, 'The plan, with its chart below.')
    assert.equal(reply.ref ?? null, null)
})

test('the tools a turn called ride on its reply, and the next turn is told about them (Roy, 2026-11-13: Proteus called a measured profile made up)', async () => {
    const statuses = []
    const { turn, sessions, seen } = rig({
        run: ({ common }) => {
            if (seen.length === 1) {
                common.onToolStart('get_behaviour_profile')                          // the provider: the call starts
                common.onToolStart('get_behaviour_profile', { targets: ['NVDA'] })   // agentIO.announceTargets: it runs
                common.onToolStart('get_chart', { targets: ['NVDA'] })
            }
            return { reply: seen.length === 1 ? '74% of NVDA\'s breaks reclaim.' : 'From the measured profile.' }
        },
    })
    const s = await sessions.getActive({ userId: 'u1' })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'how does NVDA behave?', emit: (e, d) => statuses.push([e, d]) })
    await turn({ user, sessionId: s.sessionId, agent: 'mentor', text: 'how did you do it so fast?' })
    const all = await sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })
    assert.deepEqual(all[1].tools, ['get_behaviour_profile NVDA', 'get_chart NVDA'])
    assert.equal('tools' in all[3], false, 'a turn that called nothing keeps no trace')
    assert.match(seen[1].common.messages[2].content, /^\[App note, not the user's words: .*get_behaviour_profile NVDA; get_chart NVDA.*\]\n\nhow did you do it so fast\?$/s)
    assert.ok(statuses.some(([e, d]) => e === 'status' && d.tool === 'get_chart'), 'the desk\'s own status events still go out')
})

test('ownWords: a desk\'s hand-back to Axl carries the user\'s own question when the desk wrote no opening (Roy, 2026-11-13)', () => {
    assert.equal(ownWords({ route: 'reception', opening: null }, 'proteus', 'is NVDA a good business?').opening, 'is NVDA a good business?')
    assert.equal(ownWords({ route: 'reception', opening: 'is it cheap?' }, 'proteus', 'x').opening, 'is it cheap?')
    const r = { route: 'research', opening: null }
    assert.equal(ownWords(r, 'proteus', 'yes'), r, 'a desk\'s route elsewhere is unchanged')
})
