import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeChainRunner } from '../../services/chain/runner.js'
import { receiverOf, briefFor } from '../../services/chain/contracts.js'
import { KIND, makeArtifact } from '../../services/chain/artifact.js'
import { decisionFor, emitted, researchQueueFrom } from '../../services/chain/rules.js'

// The chain runner (plan phase 5c): after every turn — hand on what was emitted, stop at the user's
// call, ask before taking over an agent's own work, cap the automatic steps, pause on an interjection,
// and pause-and-ask after a restart. On memDb, with a recording stand-in for the queued-turn runner.

function rig({ maxSteps, covered = ['NVDA'], saveList = null } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const roles = { admin1: 'admin' }
    // Argus's save before a research run (8d CR (a)) and its seal — recorded, no database behind them.
    const saves = [], seals = []
    const save = saveList ?? (async ({ state }) => { saves.push(state); return { result: { scan: { id: 'scan1' } }, seal: { kind: 'scan', entityIds: ['scan1'] }, after: null } })
    const sealing = { sealFromSession: async (a) => { seals.push(a); return { sealed: 1 } }, openForEdit: async () => ({ agent: 'x' }) }
    const runner = makeChainRunner({ sessions, loadUser: async (id) => ({ _id: id, role: roles[id] ?? 'trader' }), isCovered: async (t) => covered.includes(t), saveList: save, sealing, ...(maxSteps ? { maxSteps } : {}) })
    const queued = []
    runner.bindRunQueued(async (args) => { queued.push(args); return {} })
    return { sessions, runner, queued, saves, seals }
}
const user = { _id: 'u1', role: 'user' }
const rows = (sessions, s) => sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })
const header = (sessions, s) => sessions.get({ sessionId: s.sessionId, userId: 'u1' })
const pick = { ticker: 'NVDA', direction: 'long', thesis: 'Reclaiming the 50-day.', recommended_mode: 'swing' }

async function argusPicked({ sessions, runner }, s) {
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'scanner', state: { handoff: true, handoffTo: 'mentor' } })
    await runner.afterTurn({ user, sessionId: s.sessionId, agent: 'scanner', origin: 'user', out: { payload: { reply: 'NVDA it is', kairos_pick: pick } } })
}

test('Argus’s single pick is handed to Mentor: a hand-off message, the floor, the chain step, Mentor’s turn queued with the seed', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await argusPicked(r, s)
    const [hand] = await rows(r.sessions, s)
    assert.equal(hand.kind, 'handoff')
    assert.equal(hand.agent, 'scanner')
    assert.equal(hand.to, 'mentor')
    assert.equal(hand.content, 'I want to work on a NVDA trade — the read on it is: Reclaiming the 50-day. Let\'s build the setup together.')
    const h = await header(r.sessions, s)
    assert.equal(h.floor, 'mentor')
    assert.equal(h.chain.status, 'running')
    assert.equal(h.chain.steps, 1)
    assert.equal(h.agentState.mentor.chainId, h.chain.id)
    assert.equal(r.queued[0].agent, 'mentor')
    assert.equal(r.queued[0].origin, 'chain')
    assert.equal(r.queued[0].text, null)
    assert.equal(r.queued[0].input.seed.ticker, 'NVDA')
})

test('inside a chain, the receiver needing the user stops it with a decision card', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await argusPicked(r, s)
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { payload: { reply: 'Long or short?', gate: { stage: 'opening' } } } })
    const last = (await rows(r.sessions, s)).at(-1)
    assert.equal(last.kind, 'decision')
    assert.equal(last.agent, 'mentor')
    assert.equal((await header(r.sessions, s)).chain.status, 'waiting')
    assert.equal(r.queued.length, 1, 'nothing else ran')
})

test('outside a chain, a decision with no choice adds nothing — the desk’s own card carries it', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'x', gate: { stage: 'spans' } } } })
    assert.equal((await rows(r.sessions, s)).length, 0)
})

test('an investing list offers research; the tap runs a one-name-per-turn queue through Prometheus', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    const scan = { profile: 'investing', thesis: 'Semis', candidates: [{ ticker: 'NVDA' }, { ticker: 'AMD' }, { ticker: 'AVGO' }] }
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'scanner', state: { profile: 'investing', pendingScan: scan } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'scanner', origin: 'user', out: { payload: { reply: 'three names', scan } } })
    const card = (await rows(r.sessions, s)).at(-1)
    assert.deepEqual(card.ref.choices.map(c => c.id), ['research', 'keep'])

    assert.deepEqual(await r.runner.resume({ user, sessionId: s.sessionId, choice: 'research' }), { ok: true })
    // 8d CR (a): the list is saved FIRST — Argus's own action — and its conversation sealed onto it.
    assert.deepEqual(r.saves[0].pendingScan, scan)
    assert.deepEqual(r.seals[0], { userId: 'u1', sessionId: s.sessionId, agent: 'scanner', kind: 'scan', entityIds: ['scan1'] })
    const hand = (await rows(r.sessions, s)).at(-1)
    assert.equal(hand.to, 'analyst')
    assert.match(hand.content, /^Research NVDA for coverage — it is a candidate for the Semis sleeve\. This is one of 3 from the same sleeve — AMD, AVGO follow after it\./)
    assert.equal(r.queued.at(-1).input.seed.ticker, 'NVDA')

    // Prometheus drafts NVDA → the card offers the next name → AMD.
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'analyst', origin: 'chain', out: { payload: { reply: 'draft', coverage: { symbol: 'NVDA' } } } })
    assert.deepEqual((await rows(r.sessions, s)).at(-1).ref.choices.map(c => c.label), ['Next name'])
    await r.runner.resume({ user, sessionId: s.sessionId, choice: 'next' })
    assert.match((await rows(r.sessions, s)).at(-1).content, /^Research AMD/)
})

test('a research run Atlas started hands what came back to Atlas; one the user started just ends', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    const art = makeArtifact({ kind: KIND.CANDIDATE_LIST, items: [{ ticker: 'NVDA' }], context: { queued: true, sector: 'Semis' } })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: {
        id: 'c1', status: 'awaiting', origin: 'portfolio', steps: 1, queue: { artifact: art, index: 0 }, awaiting: { agent: 'analyst', choices: ['next'] },
    } })
    await r.runner.resume({ user, sessionId: s.sessionId, choice: 'next' })
    const hand = (await rows(r.sessions, s)).at(-1)
    assert.equal(hand.to, 'portfolio')
    assert.equal(hand.content, 'Coverage is in for NVDA (Semis). Build from it.')
})

test('BUSY: the chain asks before taking over an agent’s own unsealed work; "set it aside" proceeds', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: { asset: 'AMD' } } })
    await argusPicked(r, s)
    const ask = (await rows(r.sessions, s)).at(-1)
    assert.equal(ask.agent, 'axl')
    assert.match(ask.content, /^Mentor is in the middle of something else/)
    assert.deepEqual(ask.ref.choices.map(c => c.id), ['finish', 'aside'])
    assert.equal(r.queued.length, 0)
    await r.runner.resume({ user, sessionId: s.sessionId, choice: 'aside' })
    assert.equal(r.queued.at(-1).agent, 'mentor')
    assert.equal((await header(r.sessions, s)).agentState.mentor.draft, null, 'the AMD work was set aside for the chain')
})

test('the step cap asks "keep going?" instead of running forever', async () => {
    const r = rig({ maxSteps: 1 })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'running', origin: 'scanner', steps: 1 } })
    await argusPicked(r, s)
    const ask = (await rows(r.sessions, s)).at(-1)
    assert.deepEqual(ask.ref.choices.map(c => c.id), ['more'])
    await r.runner.resume({ user, sessionId: s.sessionId, choice: 'more' })
    assert.equal(r.queued.at(-1).agent, 'mentor')
})

test('a user interjection pauses the chain after the turn in flight; Continue picks it up', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'running', origin: 'axl', steps: 1 } })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'scanner', state: { handoff: true, chainId: 'c1' } })
    await r.runner.requestPause({ user, sessionId: s.sessionId })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'scanner', origin: 'chain', out: { payload: { reply: 'NVDA', kairos_pick: pick } } })
    const ask = (await rows(r.sessions, s)).at(-1)
    assert.match(ask.content, /^Paused while you spoke/)
    assert.equal(r.queued.length, 0)
    await r.runner.resume({ user, sessionId: s.sessionId, choice: 'continue' })
    assert.equal(r.queued.at(-1).agent, 'mentor')
})

test('a stopped chain turn pauses the chain; a route ends it', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'running', origin: 'axl', steps: 1 } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { stopped: true } })
    assert.equal((await header(r.sessions, s)).chain.status, 'paused')
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c2', status: 'running', origin: 'axl', steps: 1 } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { payload: { reply: 'to Argus', route: 'scan' } } })
    assert.equal((await header(r.sessions, s)).chain.status, 'done')
})

test('after a restart the sweep pauses a running chain and asks; Continue re-runs the step that was cut off', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: {
        id: 'c1', status: 'running', origin: 'scanner', steps: 1, current: { to: 'mentor', input: { seed: { ticker: 'NVDA' } }, step: 1 },
    } })
    assert.equal(await r.runner.sweep(), 1)
    const ask = (await rows(r.sessions, s)).at(-1)
    assert.equal(ask.content, 'I was interrupted — continue?')
    assert.equal(ask.agent, 'mentor')
    assert.equal((await header(r.sessions, s)).chain.status, 'paused')
    await r.runner.resume({ user, sessionId: s.sessionId, choice: 'continue' })
    assert.equal(r.queued.at(-1).agent, 'mentor')
    assert.equal(r.queued.at(-1).input.seed.ticker, 'NVDA')
})

test('8d CR: a list that did not save is not researched — the refusal is said, no hop', async () => {
    const r = rig({ saveList: async () => ({ reason: 'save_failed' }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    const scan = { thesis: 'Semis', profile: 'investing', candidates: [{ ticker: 'NVDA' }] }
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'scanner', state: { profile: 'investing', pendingScan: scan } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'scanner', origin: 'user', out: { payload: { reply: 'one name', scan } } })
    assert.deepEqual(await r.runner.resume({ user, sessionId: s.sessionId, choice: 'research' }), { reason: 'save_failed' })
    assert.equal(r.queued.length, 0)
})

test('a tap that is not on offer is refused', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    assert.deepEqual(await r.runner.resume({ user, sessionId: s.sessionId, choice: 'research' }), { reason: 'no_such_choice' })
})

// ── the tables and the briefs ───────────────────────────────────────────────

test('receivers: a pick → Mentor, a queue → Prometheus, a coverage set → Atlas', () => {
    assert.equal(receiverOf(makeArtifact({ kind: KIND.CANDIDATE_LIST, items: [{ ticker: 'X' }] })), 'mentor')
    assert.equal(receiverOf(makeArtifact({ kind: KIND.CANDIDATE_LIST, items: [{ ticker: 'X' }], context: { queued: true } })), 'analyst')
    assert.equal(receiverOf(makeArtifact({ kind: KIND.COVERAGE_SET })), 'portfolio')
    assert.throws(() => makeArtifact({ kind: 'mandate' }), /unknown artifact kind/)
})

test('Atlas’s brief says what did NOT come back, not just what did', () => {
    const b = briefFor(makeArtifact({ kind: KIND.COVERAGE_SET, items: [], context: { unfilled: ['Utilities'], declined: [{ ticker: 'SO', sector: 'Utilities' }] } }))
    assert.match(b.text, /^No coverage was initiated on this run\. These sleeves came back with NOTHING screened: Utilities\. Screened but NOT researched/)
})

test('only Argus in single-pick mode emits a pick; a decision table row per desk', () => {
    assert.equal(emitted('scanner', { kairos_pick: pick }, { handoff: false }), null)
    assert.equal(emitted('scanner', { kairos_pick: pick }, { handoff: true }).items[0].ticker, 'NVDA')
    assert.ok(decisionFor('portfolio', { plan: {} }, null))
    assert.ok(decisionFor('mentor', { setup: {}, readiness: { ready: true } }, null))
    assert.equal(decisionFor('mentor', { setup: {}, readiness: { ready: false } }, null), null)
    assert.equal(decisionFor('axl', { reply: 'hi' }, null), null)
    assert.equal(researchQueueFrom({ candidates: [] }), null)
})

// ── a sleeve settling into the chain (plan phase 5d) ────────────────────────

test('a settled sleeve becomes Argus’s line, then the coverage is handed to Atlas — saying what did not come back', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    const sleeve = { userId: 'u1', sessionId: s.sessionId, sector: 'Utilities', school: 'income' }
    const taken = await r.runner.sleeveSettled(sleeve, { covered: ['SO'], passed: ['DUK'], failed: [], unresolved: [], screened: 12 })
    assert.equal(taken, true)
    const [line, hand] = await rows(r.sessions, s)
    assert.equal(line.agent, 'scanner')
    assert.equal(line.content, 'Screened 12 for the Utilities sleeve (income) → 1 now in coverage: SO; 1 passed on (no edge).')
    assert.equal(hand.to, 'portfolio')
    assert.match(hand.content, /^Coverage is in for SO \(Utilities\)\. Build from it\. Screened but NOT researched/)
    assert.equal((await header(r.sessions, s)).chain.origin, 'portfolio')
    assert.equal(r.queued.at(-1).agent, 'portfolio')
})

test('a sleeve whose session is gone is declined — the caller posts the card instead', async () => {
    const r = rig()
    assert.equal(await r.runner.sleeveSettled({ userId: 'u1', sessionId: 'nope', sector: 'X' }, { covered: [], passed: [], failed: [], unresolved: [], screened: 0 }), false)
})

test('a chain step the server starts on its own acts as the user WITH their role (an admin keeps admin reach)', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'admin1' })
    await r.runner.sleeveSettled({ userId: 'admin1', sessionId: s.sessionId, sector: 'Energy' }, { covered: ['XOM'], passed: [], failed: [], unresolved: [], screened: 3 })
    assert.equal(r.queued.at(-1).user.role, 'admin')
})

test('a finished run reports only names actually in coverage as covered — the rest as researched-not-covered', async () => {
    const r = rig({ covered: ['NVDA'] })
    const s = await r.sessions.getActive({ userId: 'u1' })
    const art = makeArtifact({ kind: KIND.CANDIDATE_LIST, items: [{ ticker: 'NVDA' }, { ticker: 'AMD' }], context: { queued: true, sector: 'Semis' } })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: {
        id: 'c1', status: 'awaiting', origin: 'portfolio', steps: 2, queue: { artifact: art, index: 1 }, awaiting: { agent: 'analyst', choices: ['next'] },
    } })
    await r.runner.resume({ user, sessionId: s.sessionId, choice: 'next' })
    const hand = (await rows(r.sessions, s)).at(-1)
    assert.ok(hand.content.startsWith('Coverage is in for NVDA (Semis). Build from it.'), hand.content)
    assert.ok(hand.content.includes('Screened but NOT researched (no coverage initiated): AMD (Semis).'), hand.content)
})

test('a stale tap on a finished chain does nothing; ending a chain clears what it was waiting on', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'done', origin: 'scanner', steps: 1, awaiting: { agent: 'axl', choices: ['aside'] } } })
    assert.deepEqual(await r.runner.resume({ user, sessionId: s.sessionId, choice: 'aside' }), { reason: 'no_such_choice' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c2', status: 'running', origin: 'axl', steps: 1, awaiting: { agent: 'x', choices: ['finish'] } } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { payload: { reply: 'to Argus', route: 'scan' } } })
    const c = (await header(r.sessions, s)).chain
    assert.equal(c.status, 'done')
    assert.equal(c.awaiting, null)
})

test('a chain step that is refused or fails pauses the chain and offers to try again — never left running', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'running', origin: 'scanner', steps: 1, current: { to: 'mentor', input: {}, step: 1 } } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { reason: 'error' } })
    const ask = (await rows(r.sessions, s)).at(-1)
    assert.equal(ask.content, 'That step did not go through — try it again?')
    assert.equal((await header(r.sessions, s)).chain.status, 'awaiting')
    await r.runner.resume({ user, sessionId: s.sessionId, choice: 'continue' })
    assert.equal(r.queued.at(-1).agent, 'mentor')
})

test('BUSY is about real work: Atlas’s own sleeve never asks, and a state that is only mode is not work', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    // Atlas holds its mandate AND a pending plan — but it started the chain, so its own sleeve comes straight back.
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'portfolio', state: { mandate: { a: 1 }, pendingPlan: { ideas: [] } } })
    await r.runner.sleeveSettled({ userId: 'u1', sessionId: s.sessionId, sector: 'Energy' }, { covered: ['XOM'], passed: [], failed: [], unresolved: [], screened: 3 })
    assert.equal(r.queued.at(-1).agent, 'portfolio')
    assert.deepEqual((await header(r.sessions, s)).agentState.portfolio.mandate, { a: 1 }, 'the mandate is kept, not wiped')
    // Mentor with only markers (no draft) is not busy.
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { view: { gate: null } } })
    await argusPicked(r, s)
    assert.equal(r.queued.at(-1).agent, 'mentor')
})
