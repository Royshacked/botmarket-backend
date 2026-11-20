import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAskSpecialist, composeQuestion, routeNote } from '../../services/desks/subagent.js'
import { buildConversation } from '../../services/desks/context.js'
import { segmentOf } from '../../services/session.util.js'
import { specialistHint } from '../../services/desks/axl.desk.js'
import { isToolError, toolErrorText } from '../../services/toolResult.util.js'

// Axl's subagents (docs/design/modes-and-builders.md §3): the event analyst and the technical analyst answer INSIDE Axl's
// turn — as themselves, kept as their own rows, the floor never moving.

const user = { _id: 'u1', role: 'user' }

function rig(deskImpl) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const runs = [], frames = []
    const desks = {
        echo:    { agent: 'echo', run: async (args) => { runs.push(args); return deskImpl(args) } },
        proteus: { agent: 'proteus', run: async (args) => { runs.push(args); return deskImpl(args) } },
    }
    const ask = makeAskSpecialist({ sessions, desks })
    const emit = (type, data, as) => frames.push({ type, data, as })
    return { sessions, ask, runs, frames, emit }
}

test('composeQuestion: the ask, every company BY NAME, what is already known', () => {
    const q = composeQuestion({ question: 'Does the IPO affect other companies?', companies: [{ ticker: 'ant', name: 'Anthropic' }, { ticker: 'NVDA', name: '' }], context: 'Priced at $83, opened near $110.' })
    assert.equal(q, 'Does the IPO affect other companies?\n\nCompanies: ANT (Anthropic), NVDA.\n\nWhat is already known: Priced at $83, opened near $110.')
    assert.equal(composeQuestion({ question: 'Heatwave — who gains?', companies: [] }), 'Heatwave — who gains?')
})

test('the event analyst answers as itself: its question hidden in its segment, its reply its own row, the tool result tells Axl not to repeat it', async () => {
    const { sessions, ask, runs, frames, emit } = rig(({ common }) => {
        common.onToken('Broadcom scores 9.')
        common.onToolStart('get_event_map')
        return { reply: 'Broadcom scores 9.' }
    })
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'axl' })
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'axl', role: 'user', content: 'does the ANT ipo affect others?' } })
    const out = await ask({ user, sessionId: s.sessionId, emit })({ specialist: 'event_analyst', question: 'Does the ANT IPO reach other companies?', companies: [{ ticker: 'ANT', name: 'Anthropic' }] })

    assert.match(out, /^THE EVENT ANALYST ANSWERED — its reply is ALREADY ON SCREEN/)
    assert.match(out, /--- its reply ---\nBroadcom scores 9\./)
    // It read the question with the company named, and streamed AS the event analyst.
    const conv = runs[0].common.messages
    assert.match(conv.at(-1).content, /Companies: ANT \(Anthropic\)\./)
    assert.deepEqual(frames.map(f => `${f.type}:${f.as}`), ['token:echo', 'status:echo'])
    const rows = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    const [, q, a] = rows
    assert.deepEqual([q.agent, q.role, q.ref], ['echo', 'user', { opening: true, via: 'axl' }])
    assert.deepEqual([a.agent, a.role, a.content, a.ref], ['echo', 'assistant', 'Broadcom scores 9.', { via: 'axl' }])
    assert.deepEqual(a.tools, ['get_event_map'])
    // The floor did not move.
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).floor, 'axl')
})

test("Axl's next turn reads the answer, labelled as the role's; the role's own next turn reads its whole exchange", async () => {
    const { sessions, ask, emit } = rig(() => ({ reply: 'TSM is a layer-3 supplier, score 8.' }))
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'axl', role: 'user', content: 'and the suppliers?' } })
    await ask({ user, sessionId: s.sessionId, emit })({ specialist: 'event_analyst', question: 'Which suppliers does the ANT IPO reach?', companies: [{ ticker: 'ANT', name: 'Anthropic' }] })
    const rows = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })

    const axl = buildConversation({ messages: rows, agent: 'axl' })
    assert.deepEqual(axl.map(m => m.role), ['user', 'assistant'])
    assert.equal(axl[1].content, "[The event analyst's answer, shown to the user as written:]\nTSM is a layer-3 supplier, score 8.")
    // The store's own query agrees with the pure filter.
    const viaStore = await sessions.messagesForAgent({ sessionId: s.sessionId, userId: 'u1', agent: 'axl', afterSeq: 0 })
    assert.deepEqual(viaStore.map(m => m.seq), segmentOf(rows, 'axl').map(m => m.seq))

    const echo = buildConversation({ messages: rows, agent: 'echo' })
    assert.deepEqual(echo.map(m => m.role), ['user', 'assistant'])
    assert.match(echo[0].content, /Which suppliers/)
})

test('a hand-back ("not mine") and an offer to take the user to a builder come back to Axl as words — nobody moves', async () => {
    assert.match(routeNote({ route: 'reception', opening: 'show me the hotlist' }, 'event analyst'), /says this question is not its own \("show me the hotlist"\) — answer it yourself/)
    assert.match(routeNote({ route: 'assist', routeSymbol: 'FN', opening: 'Build a trade on FN.' }, 'event analyst'),
        /offered to take the user to the trader on FN: "Build a trade on FN\."\. Only if that is what the user asked for, end your reply with that route \(<route>assist FN<\/route>/)
    assert.equal(routeNote({ reply: 'x' }, 'event analyst'), '')

    const { sessions, ask, emit } = rig(() => ({ reply: '', route: 'reception', opening: 'show me the hotlist' }))
    const s = await sessions.getActive({ userId: 'u1' })
    const out = await ask({ user, sessionId: s.sessionId, emit })({ specialist: 'event_analyst', question: 'show me the hotlist', companies: [] })
    assert.match(out, /not its own/)
    const rows = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    assert.equal(rows.filter(r => r.role === 'assistant').length, 0, 'a wordless hand-back writes no row')
})

test('the technical analyst keeps the chart it showed on its row', async () => {
    const { sessions, ask, emit } = rig(({ common }) => { common.onChart({ symbol: 'TSLA', timeframe: 'day' }); return { reply: 'TSLA false-breaks 70% of the time.' } })
    const s = await sessions.getActive({ userId: 'u1' })
    await ask({ user, sessionId: s.sessionId, emit })({ specialist: 'technical_analyst', question: 'How does TSLA behave?', companies: [{ ticker: 'TSLA', name: 'Tesla' }] })
    const rows = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    assert.deepEqual(rows.at(-1).ref, { via: 'axl', chart: { ticker: 'TSLA', timeframe: 'day' } })
})

test('refused before anything runs: an unknown specialist, no question, no companies; a failure is said, never thrown', async () => {
    const { sessions, ask, runs, emit } = rig(() => { throw new Error('model down') })
    const s = await sessions.getActive({ userId: 'u1' })
    const a = ask({ user, sessionId: s.sessionId, emit })
    for (const [args, re] of [
        [{ specialist: 'trader', question: 'x', companies: [] }, /specialist must be one of: technical_analyst, event_analyst|specialist must be one of: event_analyst, technical_analyst/],
        [{ specialist: 'event_analyst', question: ' ', companies: [] }, /question is required/],
        [{ specialist: 'event_analyst', question: 'x' }, /companies is required/],
    ]) {
        const r = await a(args)
        assert.ok(isToolError(r)); assert.match(toolErrorText(r), re)
    }
    assert.equal(runs.length, 0)
    const failed = await a({ specialist: 'event_analyst', question: 'x', companies: [] })
    assert.ok(isToolError(failed)); assert.match(toolErrorText(failed), /the event analyst failed \(model down\) — say so/)
})

test("Axl's summary fold keeps who said it: the specialist's answer is labelled as its, not the desk's", async () => {
    const { makeSummarizer } = await import('../../services/desks/summarize.js')
    let sent = null
    const summarize = makeSummarizer({ once: async ({ user }) => { sent = user; return 'ok' }, record: async () => {} })
    await summarize({ userId: 'u1', agent: 'axl', turns: [
        { agent: 'axl', role: 'user', kind: 'msg', content: 'does the ANT IPO reach others?' },
        { agent: 'echo', role: 'assistant', kind: 'msg', content: 'Broadcom scores 9.', ref: { via: 'axl' } },
        { agent: 'axl', role: 'assistant', kind: 'msg', content: 'Ask about any name on the map.' },
    ] })
    assert.match(sent, /USER: does the ANT IPO reach others\?\nEVENT ANALYST \(asked by the desk\): Broadcom scores 9\.\nDESK: Ask about any name on the map\./)
})

test("Axl's desk turns `via` into the hint: a subagent's role only", () => {
    assert.deepEqual(specialistHint('echo'), { key: 'event_analyst', role: 'event analyst' })
    assert.deepEqual(specialistHint('proteus'), { key: 'technical_analyst', role: 'technical analyst' })
    assert.equal(specialistHint('scanner'), null)
    assert.equal(specialistHint(undefined), null)
})
