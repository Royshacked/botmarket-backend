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

test("a build that asks the user PAUSES on a card — the question and the options it listed; the chat stays put (step 8, M8)", async () => {
    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'axl' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: {}, title: 'NVDA trade', text: 't', input: {} })
    const id = (await st(sessions, s)).mentor.build.id
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', content: 'Two ways in.\n\nWhich of the two stops?\n- the swing low at $393\n- the full fall at $402', ref: { build: id } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } }), 'awaiting')
    const card = (await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })).at(-1)
    assert.deepEqual([card.kind, card.ref.state, card.ref.mid, card.ref.buildId], ['questions', 'open', true, id])
    assert.equal(card.ref.questions[0].question, 'Which of the two stops?')
    assert.deepEqual(card.ref.questions[0].options.map(o => o.label), ['the swing low at $393', 'the full fall at $402'])
    let ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.floor, 'axl', 'the chat stays with Axl')
    assert.deepEqual([ses.agentState.mentor.build.status, ses.agentState.mentor.build.card], ['awaiting', card.seq])

    // Answered: back to the background with the answer.
    assert.deepEqual(await builds.resume({ user, sessionId: s.sessionId, agent: 'mentor', text: 'My answer:\n- the full fall' }), { ok: true })
    ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.agentState.mentor.build.status, 'building')
    assert.equal(ses.agentState.mentor.build.card, undefined)
    assert.match(turns.at(-1).text, /the user answered your question on the card[\s\S]*the full fall[\s\S]*then go/)
    assert.equal((await builds.resume({ user, sessionId: s.sessionId, agent: 'mentor', text: 'x' })).reason, 'wrong_status')
})

test("answering a build's card through the answers endpoint resumes it (asking.answer, mid)", async () => {
    const { makeAsking } = await import('../../services/desks/asking.js')
    const { sessions, builds, turns } = rig()
    const asks = makeAsking({ sessions, profiles: { read: async () => ({ notes: [], size: null }) }, runTurn: async () => {}, builds })
    const s = await sessions.getActive({ userId: 'u1' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: {}, title: 'NVDA trade', text: 't', input: {} })
    const id = (await st(sessions, s)).mentor.build.id
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', content: 'Which stop?\n- $393\n- $402', ref: { build: id } } })
    await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } })
    const card = (await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })).at(-1)
    assert.equal((await asks.answer({ user, sessionId: s.sessionId, seq: card.seq, answers: { answer: {} } })).reason, 'unanswered:answer')
    assert.deepEqual(await asks.answer({ user, sessionId: s.sessionId, seq: card.seq, answers: { answer: { choice: '$402' } } }), { agent: 'mentor', resumed: true })
    assert.match(turns.at(-1).text, /- Which stop\? \$402/)
    assert.equal((await asks.answer({ user, sessionId: s.sessionId, seq: card.seq, answers: { answer: { choice: '$402' } } })).reason, 'already_answered')
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

test('"Find one for me" (M18): the stock picker\'s candidates on a card; the pick runs the held answers with that name', async () => {
    const { makeAsking } = await import('../../services/desks/asking.js')
    const { candidatesNote, pickQuestion } = await import('../../services/desks/candidates.js')
    const { _normalizeCandidates } = await import('../../services/agents/scanner.agent.service.js')
    assert.deepEqual(_normalizeCandidates([{ ticker: 'nvda', thesis: 'x' }, { ticker: 'NVDA' }, { ticker: 'amd' }, { ticker: 'bad ticker' }, { ticker: 'TSM' }, { ticker: 'MU' }]).map(c => c.ticker), ['NVDA', 'AMD', 'TSM'])
    assert.match(candidatesNote('swing'), /CANDIDATES[\s\S]*Horizon: swing[\s\S]*<argus_candidates>/)
    assert.match(pickQuestion([], 'the list is empty — SPY is under its 200-day').question, /found no name: the list is empty/)

    const { sessions, builds, turns } = rig()
    const finds = []
    const finder = { find: async (x) => { finds.push(x.userId); return { candidates: [{ ticker: 'NVDA', thesis: 'room to target' }, { ticker: 'AMD', thesis: 'a NOW read' }], reply: '' } } }
    const asks = makeAsking({ sessions, profiles: { read: async () => ({ notes: [], size: null }) }, runTurn: async (x) => { turns.push(x) }, builds, finder })
    const s = await sessions.getActive({ userId: 'u1' })
    const post = await asks.post({ user, sessionId: s.sessionId, agent: 'mentor', state: null, input: {} })
    const answers = { name: { choice: 'Find one for me' }, account: { accountId: 'p1', accountLabel: 'Paper' }, size: { other: '$10,000' },
        risk: { choice: '1% of the account' }, rr: { choice: '1.5' }, scenarios: { choice: 'Both (recommended)' }, invalidation: { choice: 'Redraw it' }, surprises: { choice: 'Decide for me' } }
    const out = await asks.answer({ user, sessionId: s.sessionId, seq: post.seq, answers, accounts: [{ id: 'p1', broker: 'paper' }] })
    assert.equal(out.picking, true)
    assert.equal(turns.length, 0, 'the trader does not run without a name')
    await new Promise(r => setTimeout(r, 10))
    assert.deepEqual(finds, ['u1'])
    const card = (await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })).at(-1)
    assert.deepEqual([card.ref.pick, card.ref.mid, card.ref.questions[0].options.map(o => o.label)], [true, true, ['NVDA', 'AMD']])
    assert.equal((await st(sessions, s)).mentor.build.status, 'awaiting')

    assert.deepEqual(await asks.answer({ user, sessionId: s.sessionId, seq: card.seq, answers: { name: { choice: 'AMD' } } }), { agent: 'mentor', resumed: true })
    const b = (await st(sessions, s)).mentor.build
    assert.deepEqual([b.status, b.title, b.pending, b.picking], ['building', 'AMD trade', undefined, undefined])
    assert.match(turns[0].text, /- Which stock\? AMD\n/)
    assert.doesNotMatch(turns[0].text, /Find one for me/)
    assert.deepEqual(turns[0].input.accounts, [{ id: 'p1', broker: 'paper' }], "the card's account rides on")
})

test("each builder's own \"done\" (step 9): a trade's readiness, a new book's sized plan, a review's verdict, a standing coverage draft", async () => {
    const { generatable } = await import('../../services/desks/builds.js')
    assert.equal(generatable({ pendingPlan: { holdings: [] } }, 'portfolio'), true)
    assert.equal(generatable({ mandate: {} }, 'portfolio'), false)
    assert.equal(generatable({ reviewMode: true, reviewed: true }, 'portfolio'), true, 'a review that found nothing is a hold — done too')
    assert.equal(generatable({ reviewMode: true, pendingPlan: {} }, 'portfolio'), false, 'not reviewed yet')
    assert.equal(generatable({ draft: { symbol: 'MSFT' }, standing: true }, 'analyst'), true)
    assert.equal(generatable({ draft: { symbol: 'MSFT' }, standing: false }, 'analyst'), false, 'a withdrawn draft')
})

test("a done build that ends asking \"shall I apply it?\" is READY — the question IS the Confirm (step 9)", async () => {
    const { sessions, builds } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'portfolio', state: { reviewMode: true, reviewed: true, build: { id: 'b1', status: 'building', title: 'Growth review', since: 1 } } })
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'portfolio', role: 'assistant', content: 'Trim MSFT by a third. Shall I apply it?', ref: { build: 'b1' } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'portfolio', out: { payload: {} } }), 'ready')
})

test('a review opened from its card runs in the background: begin starts it, runs its first turn, the chat back with Axl (step 9, M11)', async () => {
    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'portfolio' })
    const started = await builds.begin({ user, sessionId: s.sessionId, agent: 'portfolio', state: { reviewMode: true, portfolioId: 'p1', editing: { kind: 'portfolio', entityId: 'p1' } }, title: 'Growth review', text: '[App note] review it' })
    assert.equal(started.run, true)
    const ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.floor, 'axl')
    assert.deepEqual([ses.agentState.portfolio.build.status, ses.agentState.portfolio.reviewMode, ses.agentState.portfolio.editing.entityId], ['building', true, 'p1'])
    assert.deepEqual([turns[0].agent, turns[0].origin, turns[0].input.answered], ['portfolio', 'opening', true])
})

test("Analyst mode (M17): the user typing over the analyst's open card starts a coverage build — this turn is its first, its reply the pane's, the chat back with Axl", async () => {
    const { db, sessions, builds } = rig()
    const contexts = makeAgentContextService({ getDb: async () => db })
    const analyst = { agent: 'analyst', run: async () => ({ reply: 'Researching MSFT.' }), done: (r) => ({ reply: r.reply }), nextState: (p) => ({ ...(p ?? {}), draft: { symbol: 'MSFT' }, standing: true }) }
    const noCards = { post: async () => ({ reason: 'off' }), setAside: async ({ state }) => state }
    const turn = makeSessionTurn({ sessions, contexts, desks: { analyst }, experience: async () => 'novice', profiles: { read: async () => ({ notes: [], size: null }) }, summarize: async () => 'S', asks: noCards, buildsSvc: builds })
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst', state: { asking: { seq: 1 } } })
    await turn({ user, sessionId: s.sessionId, agent: 'analyst', text: 'Research MSFT into coverage', origin: 'user' })
    const ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.floor, 'axl')
    assert.equal(ses.agentState.analyst.build.status, 'building')
    const rows = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    assert.deepEqual(rows.map(r => `${r.role}:${r.ref?.build ? 'build' : '-'}`), ['user:-', 'assistant:build'], "the user's ask in the chat, the analyst's work in the pane")
    // Then it is ready: a standing draft; titled by its name.
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'analyst', out: { payload: {} } }), 'ready')
    assert.equal((await st(sessions, s)).analyst.build.title, 'MSFT coverage')
})

test('at boot, a build a restart cut off is marked failed (Retry) and the queue moves (step 10 — the drive found it)', async () => {
    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { build: { id: 'b1', status: 'building', title: 'AMD trade', since: 1 } } })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'portfolio', state: { build: { id: 'b2', status: 'queued', title: 'Growth book', since: 2, pending: { text: 'answers', input: {} } } } })
    assert.equal(await builds.sweep(), 1)
    const now = await st(sessions, s)
    assert.deepEqual([now.mentor.build.status, now.mentor.build.failedBy], ['failed', 'restart'])
    assert.equal(now.portfolio.build.status, 'building', 'the queued build started')
    assert.equal(turns[0].agent, 'portfolio')
    assert.equal(await builds.sweep(), 1, "the queued one, now building, is the next boot's — this one's turn is in flight")
})

test('a build whose verdict is NO TRADE is DECLINED — not carried on, not a question; Change or drop it (step 10 — the drive)', async () => {
    const { noTradeReason } = await import('../../services/desks/builds.js')
    assert.equal(noTradeReason('No trade: the chart challenge favored the short side.'), 'the chart challenge favored the short side.')
    assert.equal(noTradeReason('**No trade** — earnings in 2 days.'), 'earnings in 2 days.')
    assert.equal(noTradeReason('I see no trade-off here.'), null)
    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: {}, title: 'AMD trade', text: 't', input: {} })
    const id = (await st(sessions, s)).mentor.build.id
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', content: 'No trade: the chart favors the short side, and this desk builds longs only.', ref: { build: id } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } }), 'declined')
    assert.equal(turns.length, 0, 'not carried on')
    let b = (await st(sessions, s)).mentor.build
    assert.deepEqual([b.status, b.reason], ['declined', 'the chart favors the short side, and this desk builds longs only.'])
    assert.deepEqual(await builds.rework({ user, sessionId: s.sessionId, agent: 'mentor', kind: 'change', text: 'build the long on the pullback anyway' }), { ok: true })
    b = (await st(sessions, s)).mentor.build
    assert.equal(b.status, 'building')
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { build: { ...b, status: 'declined' } } })
    assert.deepEqual(await builds.rework({ user, sessionId: s.sessionId, agent: 'mentor', kind: 'drop' }), { ok: true })
    assert.equal((await st(sessions, s)).mentor.build, undefined, 'off the table')
})

test("a NO TRADE verdict beats a draft left from before it — declined, never confirmable (the drive: an old draft was armed)", async () => {
    const { sessions, builds } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'NVDA' }, view: { readiness: { ready: true } }, build: { id: 'b1', status: 'building', title: 'NVDA trade', since: 1 } } })
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', content: 'No trade: the pullback alternative is invalid now — NVDA is below both stops.', ref: { build: 'b1' } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } }), 'declined')
})

// The TSLA prod build (2026-11-21): the analyst PASSED ("PASS — I can't defend a price target…"), the build carried it on
// twice with the TRADE wording, and it answered "No trade: I can't build a TSLA trade setup with the tools available in
// this analyst role" — the screen said "no trade on coverage".
test('the analyst\'s PASS ends a coverage build the first time — declined with its reason, named, never carried on', async () => {
    const { passReason, declineReason, carryLine, buildLines } = await import('../../services/desks/builds.js')
    assert.equal(passReason("PASS — I can't defend a price target: my $360 base uses speculative FY2026 EPS."), "I can't defend a price target: my $360 base uses speculative FY2026 EPS.")
    assert.equal(passReason('**PASS** - the filings contradict each other.'), 'the filings contradict each other.')
    assert.equal(passReason('I would pass on this for now.'), null, 'only the verdict line, in capitals')
    assert.equal(declineReason('PASS — no defensible number.', 'mentor'), null, "a PASS is the analyst's word, not the trader's")
    assert.equal(declineReason('No trade: x.', 'analyst'), 'x.', "the older wording still ends the analyst's build")
    assert.match(carryLine('analyst'), /starts with "PASS —"/)
    assert.doesNotMatch(carryLine('analyst'), /trade/i, 'no trade wording for the analyst')
    assert.match(carryLine(), /starts with "No trade:"/)

    const { sessions, builds, turns } = rig()
    const s = await sessions.getActive({ userId: 'u1' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'analyst', state: { active_symbol: 'TSLA' }, title: 'coverage', text: 'Tsla', input: {} })
    const id = (await st(sessions, s)).analyst.build.id
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'analyst', role: 'assistant', content: "PASS — I can't defend a price target: my $360 base uses speculative FY2026 EPS of $2.00 versus Street's $1.68.", ref: { build: id } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'analyst', out: { payload: {} } }), 'declined')
    assert.equal(turns.length, 0, 'not carried on')
    const b = (await st(sessions, s)).analyst.build
    assert.deepEqual([b.status, b.title], ['declined', 'TSLA coverage'])
    assert.match(b.reason, /^I can't defend a price target/)
    assert.match(buildLines({ analyst: { build: b } })[0], /the analyst: TSLA coverage — PASSED — no price target it can defend/)
})

test("another desk's turn queued on the lane is not the build's work — the build settles (the drive, 2026-11-20: it sat \"building\" for good)", async () => {
    const { sessions, builds } = rig({ depth: (_s, agent) => (agent === 'mentor' ? 1 : 2) })
    const s = await sessions.getActive({ userId: 'u1' })
    await builds.start({ user, sessionId: s.sessionId, agent: 'mentor', state: {}, title: 'RDW trade', text: 't', input: {} })
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', content: 'No trade: the structure is broken.', ref: { build: (await st(sessions, s)).mentor.build.id } } })
    assert.equal(await builds.settle({ user, sessionId: s.sessionId, agent: 'mentor', out: { payload: {} } }), 'declined')
})

test('trackTurn counts one agent\'s turns on a session, released once', async () => {
    const { trackTurn, agentDepth } = await import('../../services/desks/turnLock.js')
    const a = trackTurn('sX', 'mentor'); const b = trackTurn('sX', 'mentor'); const c = trackTurn('sX', 'analyst')
    assert.equal(agentDepth('sX', 'mentor'), 2)
    assert.equal(agentDepth('sX', 'analyst'), 1)
    a(); a()
    assert.equal(agentDepth('sX', 'mentor'), 1, 'a release twice counts once')
    b(); c()
    assert.equal(agentDepth('sX', 'mentor'), 0)
    assert.equal(agentDepth('sX', 'analyst'), 0)
})

test("a build never hands the user to another desk — a route out of one is dropped (prod 2026-11-21: the TSLA coverage build routed to the trader)", async () => {
    const { db, sessions, builds } = rig()
    const contexts = makeAgentContextService({ getDb: async () => db })
    const analyst = { agent: 'analyst', run: async () => ({ reply: 'Researching TSLA.', route: 'trade', opening: 'Build a TSLA trade setup.' }), done: (r) => ({ reply: r.reply }), nextState: (p) => ({ ...(p ?? {}), draft: { symbol: 'TSLA' } }) }
    const noCards = { post: async () => ({ reason: 'off' }), setAside: async ({ state }) => state }
    const turn = makeSessionTurn({ sessions, contexts, desks: { analyst }, experience: async () => 'novice', profiles: { read: async () => ({ notes: [], size: null }) }, summarize: async () => 'S', asks: noCards, buildsSvc: builds })
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setFloor({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst' })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'analyst', state: { asking: { seq: 1 } } })
    const out = await turn({ user, sessionId: s.sessionId, agent: 'analyst', text: 'Build tsla', origin: 'user' })
    const ses = await sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(ses.floor, 'axl', 'the chat back with Axl, not the trader')
    assert.equal(ses.agentState.analyst.build.status, 'building')
    assert.equal(out?.payload?.route ?? null, null, 'no route in the payload')
    const rows = await sessions.allMessagesSince({ sessionId: s.sessionId, userId: 'u1', afterSeq: 0 })
    assert.ok(!rows.some(r => r.agent === 'mentor'), 'no trader opening')
})
