import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeChainRunner } from '../../services/chain/runner.js'
import { replyExtras, showLine } from '../../services/desks/sessionTurn.js'
import { findForEdit } from '../../services/desks/entityLookup.js'
import { replay } from '../../services/sessionChannel.js'
import { briefTurn } from '../../services/desks/axl.desk.js'
import { splitShow, validateShow } from '../../services/routing.util.js'
import { buildSurfaceSection } from '../../services/agents/axl.agent.service.js'

// Unified-chat phase 7a (J2–J4): a reply keeps what it offered; the
// server acts on what Axl's route carries — the opening, an edit, the brief; the order ticket is a show.

const user = { _id: 'u1', role: 'trader' }

function rig({ open = async () => ({ agent: 'mentor', line: null }), find, lookup } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const opened = []
    const sealing = { openForEdit: async (args) => { opened.push(args); return open(args) } }
    const runner = makeChainRunner({
        sessions, sealing,
        loadUser: async (id) => ({ _id: id, role: 'trader' }),
        findEdit:   find   ?? (async ({ ref }) => (ref === 'NVDA' ? { ok: true, doc: { id: 's1', asset: 'NVDA' }, id: 's1' } : { ok: false, reason: 'not_found' })),
        lookupEdit: lookup ?? (async ({ id }) => (id === 's1' ? { ok: true, doc: { id: 's1', asset: 'NVDA' } } : { ok: false, reason: 'not_found' })),
    })
    const queued = []
    runner.bindRunQueued(async (args) => { queued.push(args); return {} })
    return { sessions, runner, queued, opened }
}
const rows = (sessions, s) => sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })

// ─── J2 ───────────────────────────────────────────────────────────────────────

test('a reply keeps its tap options, chart and show — only what is there, null when nothing', () => {
    assert.equal(replyExtras({ reply: 'hi' }), null)
    assert.equal(replyExtras({ suggestions: [] }), null)
    assert.deepEqual(replyExtras({ suggestions: ['A', ' ', 7, 'B'] }), { suggestions: ['A', 'B'] })
    assert.equal(replyExtras({ suggestions: ['1', '2', '3', '4', '5', '6', '7'] }).suggestions.length, 6)
    assert.deepEqual(replyExtras({ chart: { symbol: 'NVDA' }, show: { kind: 'setup', ref: 's1' } }), { chart: { symbol: 'NVDA' }, show: { kind: 'setup', ref: 's1' } })
})

// ─── J4: the route's opening ──────────────────────────────────────────────────

test('a route with an opening runs the landing desk’s first turn — the user’s words, their accounts, nothing else', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    const input = { accounts: ['a1'], mainAccountId: 'a1', clientTime: { clientTz: 'UTC' }, ops: [{ x: 1 }], brief: true }
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'axl', turnId: 't1', origin: 'user', input, out: { payload: { reply: 'Mentor will take it', route: 'assist', opening: '  I think NVDA breaks out this week.  ' } } })
    assert.equal(r.queued.length, 1)
    assert.deepEqual(r.queued[0], {
        user, sessionId: s.sessionId, agent: 'mentor', text: 'I think NVDA breaks out this week.',
        input: { accounts: ['a1'], mainAccountId: 'a1', clientTime: { clientTz: 'UTC' } }, turnId: 't1_open', origin: 'opening',
    })
})

test('no opening, an empty one, a chain turn, or a desk out of scope → nothing runs', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    const after = (agent, origin, payload) => r.runner.afterTurn({ user, sessionId: s.sessionId, agent, turnId: 't', origin, out: { payload } })
    await after('axl', 'user', { route: 'assist' })
    await after('axl', 'user', { route: 'assist', opening: '   ' })
    await after('axl', 'chain', { route: 'assist', opening: 'x' })
    await after('axl', 'user', { route: 'strategy', opening: 'build a view' })   // admin desk, main chat
    assert.equal(r.queued.length, 0)
})

// ─── J4: an edit ──────────────────────────────────────────────────────────────

test('an edit reopens the item it names — the same openForEdit the edit route runs', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'axl', origin: 'user', out: { payload: { reply: 'Reopening it', edit: { kind: 'setup', ref: 'NVDA', desk: 'trade' } } } })
    assert.equal(r.opened.length, 1)
    assert.deepEqual(r.opened[0], { userId: 'u1', sessionId: s.sessionId, kind: 'setup', entity: { id: 's1', asset: 'NVDA' }, name: 'NVDA' })
})

test('nothing found → Axl says so; nothing is opened', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'axl', origin: 'user', out: { payload: { edit: { kind: 'setup', ref: 'TSLA', desk: 'trade' } } } })
    assert.equal(r.opened.length, 0)
    const [line] = await rows(r.sessions, s)
    assert.equal(line.agent, 'axl')
    assert.match(line.content, /could not find/)
})

test('its desk busy → a decision; "set it aside" reopens it by id with force; "keep working" ends it', async () => {
    let busy = true
    const r = rig({ open: async ({ force }) => (busy && !force ? { reason: 'busy', agent: 'mentor' } : { agent: 'mentor', line: null }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'axl', origin: 'user', out: { payload: { edit: { kind: 'setup', ref: 'NVDA', desk: 'trade' } } } })
    const card = (await rows(r.sessions, s)).at(-1)
    assert.equal(card.kind, 'decision')
    assert.match(card.content, /Mentor is in the middle of something else/)
    assert.deepEqual(card.ref.choices.map(c => c.id), ['reopen', 'keep'])
    assert.deepEqual((await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).chain.pending, { edit: { kind: 'setup', id: 's1' } })

    assert.deepEqual(await r.runner.resume({ user, sessionId: s.sessionId, choice: 'reopen' }), { ok: true })
    assert.equal(r.opened.at(-1).force, true)
    assert.equal(r.opened.at(-1).entity.id, 's1')
    const h = await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(h.chain.status, 'done')
    assert.deepEqual(await r.runner.resume({ user, sessionId: s.sessionId, choice: 'reopen' }), { reason: 'no_such_choice' }, 'a stale tap does nothing')
})

// ─── findForEdit ──────────────────────────────────────────────────────────────

test('findForEdit: an id first, then a name that matches EXACTLY one item — two NVDA setups find nothing', async () => {
    const docs = { s1: { id: 's1', asset: 'NVDA' }, s2: { id: 's2', asset: 'AMD' }, s3: { id: 's3', asset: 'AMD' } }
    const lookups = { setup: async ({ id }) => (docs[id] ? { ok: true, doc: docs[id] } : { ok: false, reason: 'not_found' }) }
    const names = { setup: async ({ ref }) => { const hits = Object.values(docs).filter(d => d.asset === ref.toUpperCase()); return hits.length === 1 ? hits[0].id : null } }
    const find = (ref) => findForEdit({ kind: 'setup', ref, user }, { lookups, byName: names })
    assert.deepEqual(await find('s2'), { ok: true, doc: docs.s2, id: 's2' })
    assert.deepEqual(await find('nvda'), { ok: true, doc: docs.s1, id: 's1' })
    assert.deepEqual(await find('AMD'), { ok: false, reason: 'not_found' })
    assert.deepEqual(await findForEdit({ kind: 'scan', ref: 'Semis', user }, { lookups: { scan: async () => ({ ok: false, reason: 'not_found' }) }, byName: names }), { ok: false, reason: 'not_found' }, 'a scan is id or nothing')
    assert.deepEqual(await findForEdit({ kind: 'setup', ref: '', user }, { lookups, byName: names }), { ok: false, reason: 'not_editable' })
})

// ─── J4: the brief; the ticket ────────────────────────────────────────────────

test('the brief as Axl’s turn: the status chip, the whole text as one token, the reply; stopped → nothing', async () => {
    const events = []
    const emit = (type, data) => events.push({ type, data })
    const out = await briefTurn({ emit, fetchBrief: async () => ({ text: 'Futures up.', asOf: 1 }) })
    assert.deepEqual(out, { reply: 'Futures up.' })
    assert.deepEqual(events, [{ type: 'status', data: { tool: 'market_brief' } }, { type: 'token', data: { text: 'Futures up.' } }])
    const ac = new AbortController(); ac.abort()
    assert.equal(await briefTurn({ emit: () => {}, signal: ac.signal, fetchBrief: async () => ({ text: 'x' }) }), null)
})

test('Stop while the brief is still being written ends the turn AT ONCE — no token after it (8f drive)', async () => {
    const events = []
    let finish
    const writing = new Promise(r => { finish = r })
    const ac = new AbortController()
    const turn = briefTurn({ emit: (type) => events.push(type), signal: ac.signal, fetchBrief: () => writing })
    ac.abort()
    assert.equal(await turn, null, 'the turn ended without waiting for the rewrite')
    finish({ text: 'Late brief.' })
    await new Promise(r => setImmediate(r))
    assert.deepEqual(events, ['status'], 'the late brief is not sent into a stopped turn')
})

test('the order ticket is a show: with or without a symbol, junk symbols dropped', () => {
    assert.deepEqual(splitShow('ticket'), { kind: 'ticket', ref: null })
    assert.deepEqual(splitShow('ticket AAPL'), { kind: 'ticket', ref: 'AAPL' })
    assert.deepEqual(validateShow({ kind: 'ticket', ref: 'aapl' }), { kind: 'ticket', ref: 'AAPL' })
    assert.deepEqual(validateShow({ kind: 'ticket', ref: null }), { kind: 'ticket', ref: null })
    assert.deepEqual(validateShow({ kind: 'ticket', ref: 'buy me something nice' }), { kind: 'ticket', ref: null })
    assert.deepEqual(splitShow('setup s1'), { kind: 'setup', ref: 's1' }, 'setups unchanged')
})

// ─── Phase 7 CR ───────────────────────────────────────────────────────────────

test('a refused edit says it is not theirs to change — not that it was not found', async () => {
    const r = rig({ find: async () => ({ ok: false, reason: 'forbidden' }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'axl', origin: 'user', out: { payload: { edit: { kind: 'coverage', ref: 'NVDA', desk: 'research' } } } })
    const [line] = await rows(r.sessions, s)
    assert.match(line.content, /not yours to change/)
    assert.equal(r.opened.length, 0)
})

test('Axl in the social chat is told hand-offs do not happen there; the chat needs no line', () => {
    assert.equal(buildSurfaceSection('chat'), '')
    assert.equal(buildSurfaceSection(undefined), '')
    assert.match(buildSurfaceSection('social'), /SOCIAL CHAT/)
    assert.match(buildSurfaceSection('social'), /continue in the main chat/)
})

// ─── Phase 7 CR ───────────────────────────────────────────────────────────────

test('an opening runs ONE turn: a turn that was itself an opening never opens or edits again (no ping-pong)', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'portfolio', turnId: 't1_open', origin: 'opening', out: { payload: { route: 'assist', opening: 'over to you' } } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'portfolio', turnId: 't1_open', origin: 'opening', out: { payload: { edit: { kind: 'setup', ref: 'NVDA', desk: 'trade' } } } })
    assert.equal(r.queued.length, 0)
    assert.equal(r.opened.length, 0)
})

test('a reopen whose desk lives in another chat says where, and moves nothing; the card carries the item’s name', async () => {
    const r = rig({ open: async () => ({ reason: 'wrong_scope', agent: 'mentor' }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'axl', origin: 'user', out: { payload: { edit: { kind: 'setup', ref: 'NVDA', desk: 'trade' } } } })
    assert.equal(r.opened[0].name, 'NVDA')
    const [line] = await rows(r.sessions, s)
    assert.match(line.content, /opens in the main chat/)
})

test('openForEdit refuses an item whose desk is not in this session’s scope', async () => {
    const { makeSealing } = await import('../../services/desks/seal.js')
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const s = await sessions.getActive({ userId: 'a1', scope: 'strategy' })
    const sealing = makeSealing({ sessions, contexts: { load: async () => null } })
    assert.deepEqual(await sealing.openForEdit({ userId: 'a1', sessionId: s.sessionId, kind: 'setup', entity: { id: 's1', asset: 'NVDA' } }), { reason: 'wrong_scope', agent: 'mentor' })
    assert.equal((await sessions.get({ sessionId: s.sessionId, userId: 'a1' })).floor, s.floor, 'the floor did not move')
})

test('a reply that is only a show still gets one plain line', () => {
    assert.equal(showLine(null), null)
    assert.equal(showLine({ kind: 'ticket', ref: null }), "Here's the order ticket.")
    assert.equal(showLine({ kind: 'ticket', ref: 'AAPL' }), "Here's the order ticket for AAPL.")
    assert.equal(showLine({ kind: 'setup', ref: 's1' }), 'Here it is.')
})

test('the reconnect replay carries the chain and the agents’ states', async () => {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'awaiting', awaiting: { agent: 'axl', choices: ['continue'] } } })
    await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { draft: 1 } })
    const sent = []
    await replay({ userId: 'u1', data: { sessionId: s.sessionId }, reply: (event, data) => sent.push(data) }, sessions)
    assert.deepEqual(sent[0].chain, { id: 'c1', status: 'awaiting', awaiting: { agent: 'axl', choices: ['continue'] } })
    assert.deepEqual(sent[0].agentState.mentor, { draft: 1 })
})
