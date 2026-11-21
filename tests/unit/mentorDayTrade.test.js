import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { isDayTrade } from '../../services/stockProfile.engine.js'
import { _readState, _dayTradeRead, _horizonNow, mentorNextState } from '../../services/desks/mentor.desk.js'
import { _buildReadSection } from '../../services/agents/mentor.agent.service.js'
import { readTarget, requestRead, settlePending, onReadWaiting, onReadSettled, _resetPending } from '../../services/mentorReads.service.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeChainRunner } from '../../services/chain/runner.js'

// A DAY TRADE OFF THE INTRADAY TAB (KDP, 2026-11-14): the trader said "I'm asking the analyst and the technical analyst"
// — code had asked neither (the name was only on the seed on the first turn) — and then waited on an analyst read a day
// trade never gets. And the waits the user sits through say what is happening.

beforeEach(() => _resetPending())

test('a day trade is the intraday and day horizons — flat by the close (proteus-v2: the day scale)', () => {
    assert.equal(isDayTrade('Intraday'), true)
    assert.equal(isDayTrade('day'), true)
    assert.equal(isDayTrade('short term swing'), false)
    assert.equal(isDayTrade(null), false)
})

test("the first turn of a hand-off reads the experts on the SEED's name and horizon — the state has neither yet", () => {
    const seed = { ticker: 'kdp', horizon: 'intraday' }
    const s = _readState(null, seed)
    assert.deepEqual(s, { active_asset: 'KDP', seed_horizon: 'intraday' })
    assert.equal(readTarget(s), null, 'a day trade asks for no analyst read')
    assert.deepEqual(_dayTradeRead(s), { symbol: 'KDP', horizon: 'intraday', dayTrade: true })
    // A worksheet's name outranks the seed (mentorNextState's order); a different name drops the old seed horizon.
    const working = { active_asset: 'TSLA', draft: { asset: 'TSLA' } }
    assert.equal(_readState(working, seed), working)
    assert.deepEqual(_readState({ active_asset: 'TSLA', seed_horizon: 'intraday' }, { ticker: 'NVDA' }), { active_asset: 'NVDA' })
    assert.equal(_readState({ active_asset: 'KDP' }, null).active_asset, 'KDP')
})

test('the horizon now: settled, else claimed, else the seed\'s', () => {
    const build = (settled, claimed) => ({ draft: { asset: 'KDP', build: { active: 'KDP', names: [{ asset: 'KDP', settled, claimed }] } }, seed_horizon: 'intraday' })
    assert.equal(_horizonNow(build({ horizon: 'swing' }, {})), 'swing')
    assert.equal(_horizonNow(build({}, { horizon: { value: 'day', source: 'mentor' } })), 'day')
    assert.equal(_horizonNow(build({}, {})), 'intraday')
    assert.equal(_dayTradeRead(build({ horizon: 'swing' }, {})), null)
})

test('the trader is TOLD a day trade has no analyst read — never "I am asking him"', () => {
    const s = _buildReadSection({ symbol: 'KDP', horizon: 'intraday', dayTrade: true })
    assert.match(s, /NO ANALYST READ on KDP — a day trade \(intraday\) needs none/)
    assert.match(s, /Never say you are asking the analyst, or waiting on him/)
    assert.ok(!/Proteus|Prometheus|Mentor/.test(s), 'no internal name (One Axl)')
})

test('a deciding read judged on in THIS turn is remembered, so the runner does not hand it over again', () => {
    const next = mentorNextState(null, { reply: 'x', decideSeen: 'TSLA' }, { seed: { ticker: 'TSLA' } })
    assert.equal(next.decide_seen, 'TSLA')
    assert.equal(mentorNextState(next, { reply: 'y' }).decide_seen, 'TSLA', 'kept on the same name')
    assert.equal(mentorNextState(next, { reply: 'z', taggedAsset: 'NVDA', setup: { asset: 'NVDA' } }).decide_seen, undefined, 'gone with the name')
})

// ─── The chat's status line while the analyst reads ──────────────────────────
function rig({ target = { symbol: 'NVDA', horizon: 'swing' }, request } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const reads = { target: () => target, request: request ?? (async () => ({ kind: 'coverage', state: 'waiting', ahead: 3, running: true, asked: true })) }
    const runner = makeChainRunner({ sessions, loadUser: async (id) => ({ _id: id, role: 'trader' }), reads })
    const queued = []
    runner.bindRunQueued(async (args) => { queued.push(args); return {} })
    return { sessions, runner, queued }
}
const user = { _id: 'u1', role: 'trader' }

test('a read asked for puts a status line on the session; its count updates, its first time stays; it clears when the read lands', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Swing.' } } })
    const w1 = (await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).waiting
    assert.deepEqual(Object.keys(w1), ['NVDA|coverage'])
    assert.deepEqual({ ...w1['NVDA|coverage'], since: 0 }, { symbol: 'NVDA', horizon: 'swing', kind: 'coverage', ahead: 3, running: true, since: 0 })
    const since = w1['NVDA|coverage'].since
    // A run settled; the read is still in line, one name ahead now.
    await r.runner.readWaiting({ userId: 'u1', sessionId: s.sessionId, symbol: 'NVDA', horizon: 'swing', kind: 'coverage' }, { kind: 'coverage', state: 'waiting', ahead: 1, running: true })
    const w2 = (await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).waiting['NVDA|coverage']
    assert.equal(w2.ahead, 1)
    assert.equal(w2.since, since, 'the wait keeps the time it was first asked')
    // It lands: the line goes, the read is handed on.
    await r.runner.readSettled({ userId: 'u1', sessionId: s.sessionId, symbol: 'NVDA', horizon: 'swing', kind: 'coverage' }, { kind: 'coverage', state: 'ready', facts: 'buy', against: false })
    assert.deepEqual((await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).waiting, {})
    assert.equal(r.queued[0].agent, 'mentor')
})

test('a read that is already in clears any line; a failed one clears it too', async () => {
    const r = rig({ request: async () => ({ kind: 'coverage', state: 'ready', facts: 'buy' }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setWaiting({ sessionId: s.sessionId, userId: 'u1', key: 'NVDA|coverage', entry: { symbol: 'NVDA', kind: 'coverage', since: 1 } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'ok' } } })
    assert.deepEqual((await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).waiting, {})
    await r.sessions.setWaiting({ sessionId: s.sessionId, userId: 'u1', key: 'AMD|coverage', entry: { symbol: 'AMD', kind: 'coverage', since: 1 } })
    await r.runner.readSettled({ userId: 'u1', sessionId: s.sessionId, symbol: 'AMD', horizon: 'swing', kind: 'coverage' }, { kind: 'coverage', state: 'failed' })
    assert.deepEqual((await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).waiting, {})
})

test('a deciding read this turn already judged on is not handed again (decide_seen)', async () => {
    const r = rig({ target: { symbol: 'TSLA', horizon: null }, request: async () => ({ kind: 'coverage', state: 'ready', decide: true, facts: 'buy' }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { active_asset: 'TSLA', decide_seen: 'TSLA', draft: null } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Long, swing.' } } })
    assert.equal(r.queued.length, 0)
})

test("the read service tells the runner about a read STILL in line after a run settles — the status line's count", async () => {
    const seen = []
    onReadWaiting((p, r) => { seen.push([p.symbol, r.state, r.ahead]) })
    onReadSettled(async () => true)
    const deps = {
        coverage: async () => null, liveCatalyst: async () => null, latestCatalyst: async () => null, lastReport: async () => null,
        listQueue: async (q) => (q.symbols ? [{ symbol: 'AMD', status: 'queued', created_at: '2', context: { mentor: true } }] : [{ status: 'queued', created_at: '1' }]),
        enqueue: async () => ({ ok: true }), requeue: async () => ({ ok: true }), startRun: async () => ({ ok: true }),
        getRun: () => null, now: () => Date.parse('2026-11-14T10:00:00Z'),
    }
    await requestRead({ symbol: 'AMD', horizon: 'swing', sessionId: 's1', userId: 'u1' }, deps)
    await settlePending(deps)
    assert.deepEqual(seen, [['AMD', 'waiting', 1]])
})

test('the session store: setWaiting broadcasts the whole map, clears a key, and refuses another user', async () => {
    const { db } = memDb()
    const sent = []
    const events = new Proxy({}, { get: (_t, name) => (...a) => { if (name === 'state') sent.push(a) } })
    const sessions = makeSessionService({ getDb: async () => db, events })
    const s = await sessions.getActive({ userId: 'u1' })
    assert.deepEqual(await sessions.setWaiting({ sessionId: s.sessionId, userId: 'u1', key: 'A.B|coverage', entry: { symbol: 'A.B', since: 5 } }), { ok: true })
    assert.deepEqual(Object.keys((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).waiting), ['A_B|coverage'], 'a dot in a ticker is not a path')
    const waitSent = () => sent.filter(([, , patch]) => 'waiting' in (patch ?? {}))
    assert.deepEqual(waitSent().at(-1), ['u1', s.sessionId, { waiting: { 'A_B|coverage': { symbol: 'A.B', since: 5 } } }], 'the whole map is broadcast')
    assert.deepEqual(await sessions.setWaiting({ sessionId: s.sessionId, userId: 'u2', key: 'X|coverage', entry: { symbol: 'X' } }), { reason: 'not_found' })
    await sessions.setWaiting({ sessionId: s.sessionId, userId: 'u1', key: 'A.B|coverage', entry: null })
    assert.deepEqual((await sessions.get({ sessionId: s.sessionId, userId: 'u1' })).waiting, {})
    assert.deepEqual(waitSent().at(-1)[2], { waiting: {} }, 'the cleared map is broadcast')
    // CR 2026-11-14: a clear with no line is no write and no broadcast.
    const n = waitSent().length
    assert.deepEqual(await sessions.setWaiting({ sessionId: s.sessionId, userId: 'u1', key: 'ZZ|coverage', entry: null }), { reason: 'nothing_to_clear' })
    assert.equal(waitSent().length, n)
})

test('CR: a filed session gets no waiting line; a house read (no user) is not shown anywhere', async () => {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const old = await sessions.getActive({ userId: 'u1' })
    await sessions.startNew({ userId: 'u1', force: true })
    assert.deepEqual(await sessions.setWaiting({ sessionId: old.sessionId, userId: 'u1', key: 'N|coverage', entry: { symbol: 'N' } }), { reason: 'not_found' })
    const r = rig()
    await r.runner.readWaiting({ userId: null, sessionId: 's-house', symbol: 'N', kind: 'coverage' }, { state: 'waiting', ahead: 1 })   // resolves, no throw
})
