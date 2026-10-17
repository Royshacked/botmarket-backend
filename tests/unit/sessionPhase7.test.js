import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeChainRunner } from '../../services/chain/runner.js'
import { replyExtras } from '../../services/desks/sessionTurn.js'
import { findForEdit } from '../../services/desks/entityLookup.js'
import { hydrateCards, cardView } from '../../services/sessionCards.js'
import { replay } from '../../services/sessionChannel.js'
import { briefTurn } from '../../services/desks/axl.desk.js'
import { splitShow, validateShow } from '../../services/routing.util.js'

// Unified-chat phase 7a (J2–J4): a reply keeps what it offered; card rows are drawn from the card; the
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
        input: { accounts: ['a1'], mainAccountId: 'a1', clientTime: { clientTz: 'UTC' } }, turnId: 't1_open', origin: 'user',
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
    assert.deepEqual(r.opened[0], { userId: 'u1', sessionId: s.sessionId, kind: 'setup', entity: { id: 's1', asset: 'NVDA' } })
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

// ─── J3: card rows drawn from the card ────────────────────────────────────────

test('hydrateCards: one read for every card row; a missing card reads null; other rows untouched', async () => {
    const reads = []
    const store = new Map([['m1', { id: 'm1', payload: { a: 1 }, actions: { primary: {} }, status: 'pending', resolveOutcome: null, resolveNote: null, content: 'x' }]])
    const read = async (ids) => { reads.push(ids); return store }
    const input = [
        { seq: 1, kind: 'msg', content: 'hi' },
        { seq: 2, kind: 'card', ref: { msgId: 'm1' } },
        { seq: 3, kind: 'card', ref: { msgId: 'gone' } },
    ]
    const out = await hydrateCards(input, read)
    assert.deepEqual(reads, [['m1', 'gone']])
    assert.deepEqual(out[0], input[0])
    assert.deepEqual(out[1].card, { payload: { a: 1 }, actions: { primary: {} }, status: 'pending', resolveOutcome: null, resolveNote: null })
    assert.equal(out[2].card, null)
    assert.deepEqual(await hydrateCards([{ kind: 'msg' }], async () => { throw new Error('no read for no cards') }), [{ kind: 'msg' }])
    assert.equal(cardView(null), null)
})

test('the reconnect replay hydrates its card rows', async () => {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', message: { agent: 'mentor', role: 'assistant', kind: 'card', content: 'hit', ref: { msgId: 'm1' } } })
    const sent = []
    await replay({ userId: 'u1', data: { sessionId: s.sessionId }, reply: (event, data) => sent.push({ event, data }) }, sessions,
        (msgs) => hydrateCards(msgs, async () => new Map([['m1', { status: 'done' }]])))
    assert.equal(sent[0].event, 'session_replay')
    assert.equal(sent[0].data.messages[0].card.status, 'done')
})

test('append: a live extra rides the pushed frame only — the stored row stays a reference', async () => {
    const { db, rows: raw } = memDb()
    const frames = []
    const sessions = makeSessionService({ getDb: async () => db, events: { message: (u, sid, m) => frames.push(m), removed() {}, state() {} } })
    const s = await sessions.getActive({ userId: 'u1' })
    await sessions.append({ sessionId: s.sessionId, userId: 'u1', live: { card: { status: 'pending' } }, message: { agent: 'mentor', role: 'assistant', kind: 'card', content: 'hit', ref: { msgId: 'm1' } } })
    assert.deepEqual(frames.at(-1).card, { status: 'pending' })
    assert.equal('card' in raw('session_messages')[0], false)
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

test('the order ticket is a show: with or without a symbol, junk symbols dropped', () => {
    assert.deepEqual(splitShow('ticket'), { kind: 'ticket', ref: null })
    assert.deepEqual(splitShow('ticket AAPL'), { kind: 'ticket', ref: 'AAPL' })
    assert.deepEqual(validateShow({ kind: 'ticket', ref: 'aapl' }), { kind: 'ticket', ref: 'AAPL' })
    assert.deepEqual(validateShow({ kind: 'ticket', ref: null }), { kind: 'ticket', ref: null })
    assert.deepEqual(validateShow({ kind: 'ticket', ref: 'buy me something nice' }), { kind: 'ticket', ref: null })
    assert.deepEqual(splitShow('setup s1'), { kind: 'setup', ref: 's1' }, 'setups unchanged')
})
