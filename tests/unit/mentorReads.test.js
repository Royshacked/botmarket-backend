import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import {
    readKindFor, readTarget, coverageRead, catalystRead, readFor, requestRead, settlePending, pendingReads, onReadSettled,
    readPending, resumePending, _resetPending, SOURCE, PASS_FRESH_DAYS, freshness, researchedAt, } from '../../services/mentorReads.service.js'
import { makeMentorActions } from '../../services/desks/actions/mentor.actions.js'
import { setupReason } from '../../api/setups/setupReasons.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeChainRunner, readWaitLine } from '../../services/chain/runner.js'
import { receiverOf, briefFor } from '../../services/chain/contracts.js'
import { KIND, makeArtifact } from '../../services/chain/artifact.js'
import { _buildReadSection } from '../../services/agents/mentor.agent.service.js'
import { researchOpening } from '../../services/researchRun.service.js'

// MENTOR'S READS (docs/design/argus-rework.md step 3; Roy, 2026-11-11): before Mentor builds, Prometheus's read on the name
// for the horizon — coverage for swing / long term, a catalyst read for short term swing, none intraday. Code checks it,
// asks for a missing one on the shared research run (waiting in line), and hands it to Mentor when it lands.

const NOW = Date.parse('2026-11-11T15:00:00Z')
const DAY = 86_400_000
const ledger = (asset, settled = {}, claimed = {}) => ({ active_asset: asset, draft: { asset, build: { active: asset, names: [{ asset, settled, claimed }] } } })

beforeEach(() => _resetPending())

// ─── What each horizon needs; where the build stands ─────────────────────────

test('the read by horizon: coverage for swing and long term, a catalyst read for short term swing, none intraday', () => {
    assert.equal(readKindFor('swing'), 'coverage')
    assert.equal(readKindFor('long term'), 'coverage')
    assert.equal(readKindFor('short term swing'), 'catalyst')
    assert.equal(readKindFor('intraday'), null)
    assert.equal(readKindFor('day'), null)
    assert.equal(readKindFor(null), 'coverage', 'no horizon yet: the DECIDING read (argus-rework.md §2.3)')
})

test('the target: the SETTLED horizon\'s read; none settled yet → the DECIDING read; a day trade needs none (Roy, 2026-11-12)', () => {
    assert.deepEqual(readTarget(ledger('nvda', { horizon: 'swing' })), { symbol: 'NVDA', horizon: 'swing' })
    assert.deepEqual(readTarget(ledger('NVDA', {}, { horizon: { value: 'swing', source: 'mentor' } })), { symbol: 'NVDA', horizon: null }, 'a claim is not settled: the experts decide')
    assert.equal(readTarget(ledger('NVDA', {}, { horizon: { value: 'intraday', source: 'hotlist' } })), null, 'a day board hand-off: no read')
    assert.equal(readTarget(ledger('NVDA', { horizon: 'intraday' })), null)
    assert.deepEqual(readTarget({ active_asset: 'NVDA', draft: null }), { symbol: 'NVDA', horizon: null }, '"let\'s trade NVDA" — a name and nothing else')
    assert.equal(readTarget(null), null)
})

// ─── The DECIDING read (argus-rework.md §2.3): fresh coverage, or re-researched first ─────────────────────────────
const DNOW = Date.parse('2026-11-12T15:00:00Z')
const DAYS = (n) => new Date(DNOW - n * 86_400_000).toISOString()

test('freshness: researched within 30 days and no report since; the research is the latest initiation, re-model or re-initiation', () => {
    assert.equal(researchedAt({ created_at: DAYS(90), monitor: { last_remodel_at: DAYS(20) }, revisions: [{ kind: 'update', at: DAYS(1) }] }), DAYS(20), 'a plain update is not research')
    assert.equal(researchedAt({ created_at: DAYS(90), revisions: [{ kind: 'reinitiate', at: DAYS(3) }] }), DAYS(3))
    assert.equal(freshness({ created_at: DAYS(10) }, null, DNOW).fresh, true)
    assert.match(freshness({ created_at: DAYS(40) }, null, DNOW).stale, /over 30 days ago/)
    assert.match(freshness({ created_at: DAYS(10) }, DAYS(5).slice(0, 10), DNOW).stale, /a report on .* after the research/)
    assert.equal(freshness({ created_at: DAYS(10) }, DAYS(15).slice(0, 10), DNOW).fresh, true, 'a report BEFORE the research is in it')
})

test('the deciding read: fresh live coverage is READY with its views and date; stale is re-researched (reinit); none is new', async () => {
    const base = { now: () => DNOW, lastReport: async () => null, listQueue: async () => [], getRun: () => null,
        liveCatalyst: async () => null, latestCatalyst: async () => null }
    const fresh = { ...COV, created_at: DAYS(5), horizon_views: { long_term: { book: 'long_term', rating: 'buy', target: { value: 300, target_date: '2027-11-01' } } } }
    const ready = await readFor('NVDA', null, { ...base, coverage: async () => fresh })
    assert.equal(ready.state, 'ready')
    assert.equal(ready.decide, true)
    assert.match(ready.facts, /his long-term view: buy, target 300\.00 by 2027-11-01/)
    assert.match(ready.facts, /researched 2026-11-07/)
    const stale = await readFor('NVDA', null, { ...base, coverage: async () => ({ ...COV, created_at: DAYS(45) }) })
    assert.deepEqual([stale.state, stale.need, stale.decide], ['missing', 'reinit', true])
    const reported = await readFor('NVDA', null, { ...base, coverage: async () => ({ ...COV, created_at: DAYS(10) }), lastReport: async () => DAYS(2).slice(0, 10) })
    assert.equal(reported.need, 'reinit', 'a report since the research')
    const none = await readFor('NVDA', null, { ...base, coverage: async () => null })
    assert.deepEqual([none.state, none.need], ['missing', 'new'])
})

test("the wait line for a deciding read says what it decides, and why it is read again", () => {
    assert.equal(readWaitLine({ symbol: 'TSLA', horizon: null }, { kind: 'coverage', need: 'reinit', ahead: 0 }),
        "Before I say whether TSLA is worth trading, and on which horizon, I'm reading the business first — the coverage again (it is over 30 days old, or a report has come out since). I'll carry on as soon as it lands.")
})

// ─── Reading a read ──────────────────────────────────────────────────────────

const COV = { symbol: 'NVDA', status: 'active', rating: 'buy', conviction: { level: 'high' }, thesis: 'Data-centre demand outruns supply through 2027. More words.',
    price_target: { value: 230, horizon: '6m', target_date: '2027-05-01' } }

test('coverage as a read: his rating and target, the thesis\'s first sentence; against when not a Buy, broken or hit', () => {
    const r = coverageRead(COV)
    assert.equal(r.against, false)
    assert.match(r.facts, /^the analyst buy \(high conviction\), target 230\.00 by 2027-05-01 \(a 6m target\); thesis: Data-centre demand outruns supply through 2027\.$/)
    assert.equal(coverageRead({ ...COV, rating: 'hold' }).against, true)
    assert.match(coverageRead({ ...COV, status: 'thesis_broken' }).facts, /his thesis is BROKEN/)
    assert.equal(coverageRead({ ...COV, status: 'target_hit' }).against, true)
})

test('a catalyst read: a live one is for the trade; a pass is against it and says why', () => {
    assert.equal(catalystRead({ status: 'active', verdict: 'credible', read: 'A real beat.', target: null, run_up: { worth: false } }).against, false)
    const pass = catalystRead({ status: 'pass', verdict: 'priced_in', pass_reason: 'too_small', read: 'The move already happened. The rest.' })
    assert.equal(pass.against, true)
    assert.equal(pass.facts, 'the analyst (priced_in): no trade — too small; The move already happened.')
})

function deps(over = {}) {
    const calls = { enqueue: [], startRun: [] }
    return {
        calls,
        coverage: async () => null,
        liveCatalyst: async () => null,
        latestCatalyst: async () => null,
        listQueue: async () => [],
        enqueue: async (row) => { calls.enqueue.push(row); return { ok: true, id: 'rq_1' } },
        startRun: async (a) => { calls.startRun.push(a); return { ok: true } },
        getRun: () => null,
        now: () => NOW,
        ...over,
    }
}

test('readFor: live coverage is ready; a horizon that needs none, or no symbol, is kind null', async () => {
    const r = await readFor('nvda', 'swing', deps({ coverage: async () => COV }))
    assert.equal(r.state, 'ready')
    assert.equal(r.kind, 'coverage')
    assert.deepEqual(await readFor('NVDA', 'intraday', deps()), { kind: null })
    assert.deepEqual(await readFor('', 'swing', deps()), { kind: null })
    assert.equal((await readFor('NVDA', 'swing', deps({ coverage: async () => ({ ...COV, status: 'retired' }) }))).state, 'missing', 'retired is no read')
})

test('readFor: a live catalyst read is ready; a recent pass is the answer (passed), asked with the freshness window', async () => {
    let since = null
    const live = await readFor('SMCI', 'short term swing', deps({ liveCatalyst: async () => ({ status: 'active', verdict: 'credible', read: 'x', run_up: { worth: false } }) }))
    assert.equal(live.state, 'ready')
    const pass = await readFor('SMCI', 'short term swing', deps({ latestCatalyst: async (s, o) => { since = o.sinceMs; return { status: 'pass', verdict: 'unclear', pass_reason: 'no_target' } } }))
    assert.equal(pass.state, 'passed')
    assert.equal(pass.against, true)
    assert.equal(since, NOW - PASS_FRESH_DAYS.catalyst * DAY)
})

test('readFor: a waiting row says how many are ahead — the running run\'s rest and the queued rows before it', async () => {
    const mine = { symbol: 'NVDA', status: 'queued', created_at: '2026-11-11T14:00:00Z', context: { mentor: true } }
    const listQueue = async (q) => (q.symbols ? [mine] : [{ created_at: '2026-11-11T13:00:00Z' }, { created_at: '2026-11-11T13:30:00Z' }, mine, { created_at: '2026-11-11T14:30:00Z' }])
    const r = await readFor('NVDA', 'swing', deps({ listQueue, getRun: () => ({ status: 'running', total: 10, position: 4 }) }))
    assert.deepEqual(r, { kind: 'coverage', state: 'waiting', need: 'new', ahead: 8, running: true })
    // A catalyst row does not answer a coverage question.
    const other = await readFor('NVDA', 'swing', deps({ listQueue: async () => [{ ...mine, context: { hotlist: true } }] }))
    assert.equal(other.state, 'missing')
})

test('readFor: coverage researched and passed (no edge) recently is the answer; an old pass is not; a failed read is unknown', async () => {
    const row = (days) => ({ symbol: 'NVDA', status: 'rejected', reason: 'no_edge', updated_at: new Date(NOW - days * DAY).toISOString(), context: { mentor: true } })
    const recent = await readFor('NVDA', 'swing', deps({ listQueue: async () => [row(3)] }))
    assert.equal(recent.state, 'passed')
    assert.match(recent.facts, /researched NVDA on 2026-11-08 and passed — no edge; no coverage/)
    assert.equal((await readFor('NVDA', 'swing', deps({ listQueue: async () => [row(40)] }))).state, 'missing')
    assert.equal((await readFor('NVDA', 'swing', deps({ listQueue: async () => null }))).state, 'unknown')
    assert.equal((await readFor('NVDA', 'swing', deps({ coverage: async () => { throw new Error('down') } }))).state, 'unknown')
})

// ─── Asking for one ──────────────────────────────────────────────────────────

test('requestRead: a missing read is queued as the trader\'s, the house run started for it, the session remembered — asked once', async () => {
    let queued = false
    const d = deps({ listQueue: async (q) => (q.symbols && queued ? [{ symbol: 'NVDA', status: 'queued', created_at: 'x', context: { mentor: true } }] : []),
        enqueue: async (row) => { d.calls.enqueue.push(row); queued = true; return { ok: true } } })
    const r = await requestRead({ symbol: 'nvda', horizon: 'swing', sessionId: 's1', userId: 'u1' }, d)
    assert.equal(r.asked, true)
    assert.equal(r.state, 'waiting')
    assert.deepEqual(d.calls.enqueue, [{ symbol: 'NVDA', source: SOURCE, requestedBy: 'u1', context: { mentor: true, horizon: 'swing', sessionId: 's1' } }])
    assert.deepEqual(d.calls.startRun, [{ userId: null, symbols: ['NVDA'] }], 'run as the house, by symbol')
    assert.deepEqual(pendingReads().map(p => [p.sessionId, p.symbol, p.kind]), [['s1', 'NVDA', 'coverage']])
    // Asked again while it waits: nothing new is queued, and the chat is not told twice.
    const again = await requestRead({ symbol: 'NVDA', horizon: 'swing', sessionId: 's1', userId: 'u1' }, d)
    assert.equal(again.asked, false)
    assert.equal(d.calls.enqueue.length, 1)
})

test('requestRead: a short-term swing asks for a CATALYST read (the run tells it apart by context.hotlist)', async () => {
    const d = deps()
    await requestRead({ symbol: 'SMCI', horizon: 'short term swing', sessionId: 's1', userId: 'u1' }, d)
    assert.deepEqual(d.calls.enqueue[0].context, { hotlist: true, requested: true, mentor: true, horizon: 'short term swing', sessionId: 's1' })
})

test('requestRead: a read on file, a horizon with none, or a failed queue asks for nothing', async () => {
    const ready = deps({ coverage: async () => COV })
    assert.equal((await requestRead({ symbol: 'NVDA', horizon: 'swing', sessionId: 's1' }, ready)).state, 'ready')
    assert.equal(ready.calls.enqueue.length, 0)
    assert.deepEqual(await requestRead({ symbol: 'NVDA', horizon: 'intraday', sessionId: 's1' }, deps()), { kind: null })
    const broken = deps({ enqueue: async () => ({ ok: false, reason: 'x' }) })
    assert.equal((await requestRead({ symbol: 'NVDA', horizon: 'swing', sessionId: 's1' }, broken)).state, 'unknown')
    assert.equal(broken.calls.startRun.length, 0)
    assert.equal(pendingReads().length, 0)
})

test('settle: a landed read goes to the hook and is forgotten; one still waiting starts the next run; one the run dropped is told as failed', async () => {
    const handed = []
    onReadSettled(async (p, r) => { handed.push([p.symbol, r.state]); return true })
    // Three pending: NVDA lands, AMD still waits (the run that ended listed the queue before it), TSLA was dropped.
    // NVDA's coverage lands between the ask and the settle.
    let landed = false
    const d = deps({
        coverage: async (s) => (s === 'NVDA' && landed ? COV : null),
        listQueue: async (q) => (q.symbols?.[0] === 'AMD' ? [{ symbol: 'AMD', status: 'queued', created_at: 'x', context: { mentor: true } }] : []),
    })
    for (const symbol of ['NVDA', 'AMD', 'TSLA']) {
        await requestRead({ symbol, horizon: 'swing', sessionId: 's1', userId: 'u1' }, { ...d, enqueue: async () => ({ ok: true }) })
    }
    d.calls.startRun.length = 0
    landed = true
    await settlePending(d)
    assert.deepEqual(handed, [['NVDA', 'ready'], ['TSLA', 'failed']])
    assert.deepEqual(pendingReads().map(p => p.symbol), ['AMD'])
    assert.deepEqual(d.calls.startRun, [{ userId: null, symbols: ['AMD'] }])
    // A run already going: no second start.
    await settlePending({ ...d, getRun: () => ({ status: 'running' }) })
    assert.equal(d.calls.startRun.length, 1)
})

// ─── The chain: asking after Mentor's turn, handing the read on ──────────────

function rig({ target = { symbol: 'NVDA', horizon: 'swing' }, request } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const asked = []
    const reads = {
        target: () => target,
        request: request ?? (async (a) => { asked.push(a); return { kind: 'coverage', state: 'waiting', ahead: 3, running: true, asked: true } }),
    }
    const runner = makeChainRunner({ sessions, loadUser: async (id) => ({ _id: id, role: 'trader' }), reads })
    const queued = []
    runner.bindRunQueued(async (args) => { queued.push(args); return {} })
    return { sessions, runner, queued, asked }
}
const user = { _id: 'u1', role: 'trader' }
const rows = (sessions, s) => sessions.messagesSince({ sessionId: s.sessionId, userId: 'u1' })

test('after a the trader turn with a name and a confirmed horizon, code asks for the read and the trader says so ONCE, with the line', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Swing it is.' } } })
    assert.deepEqual(r.asked, [{ symbol: 'NVDA', horizon: 'swing', sessionId: s.sessionId, userId: 'u1' }])
    const [line] = await rows(r.sessions, s)
    assert.equal(line.agent, 'mentor')
    assert.equal(line.content, 'Before I build the swing trade on NVDA, I\'m reading the business first — the full coverage. It waits in line behind 3 names in the house\'s research (about four minutes each). I\'ll carry on as soon as it lands.')
})

test('no line when the read was not newly asked for, and a failed ask never breaks the turn', async () => {
    const quiet = rig({ request: async () => ({ kind: 'coverage', state: 'waiting', ahead: 0, asked: false }) })
    const s = await quiet.sessions.getActive({ userId: 'u1' })
    await quiet.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'ok' } } })
    assert.equal((await rows(quiet.sessions, s)).length, 0)
    const boom = rig({ request: async () => { throw new Error('down') } })
    const s2 = await boom.sessions.getActive({ userId: 'u1' })
    await boom.runner.afterTurn({ user, sessionId: s2.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'ok' } } })
    assert.equal((await rows(boom.sessions, s2)).length, 0)
})

test('the wait line: no queue named when nothing is ahead; a catalyst read is named as one', () => {
    assert.equal(readWaitLine({ symbol: 'SMCI', horizon: 'short term swing' }, { kind: 'catalyst', ahead: 0 }),
        'Before I build the short term swing trade on SMCI, I\'m reading the business first — a catalyst read. I\'ll carry on as soon as it lands.')
    assert.match(readWaitLine({ symbol: 'X', horizon: 'swing' }, { kind: 'coverage', ahead: 1 }), /behind 1 name in/)
})

test('a landed read: the analyst\'s line, then the read handed to the trader and his turn queued — on the same name and horizon only', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    const taken = await r.runner.readSettled({ userId: 'u1', sessionId: s.sessionId, symbol: 'NVDA', horizon: 'swing' },
        { kind: 'coverage', state: 'ready', facts: 'The analyst buy, target 230.00', against: false })
    assert.equal(taken, true)
    const [line, hand] = await rows(r.sessions, s)
    assert.equal(line.agent, 'analyst')
    assert.equal(line.content, 'NVDA, swing: The analyst buy, target 230.00')
    assert.equal(hand.kind, 'handoff')
    assert.equal(hand.to, 'mentor')
    assert.equal(hand.content, 'The analyst\'s read on NVDA for the swing trade is in: The analyst buy, target 230.00. Check the trade against it and carry on building.')
    assert.equal(r.queued[0].agent, 'mentor')
    assert.equal(r.queued[0].input.seed, undefined, 'no seed — the build on the table keeps its lens')

    // The user moved on to another name: the line stays, nothing is pushed into the new trade.
    const moved = rig({ target: { symbol: 'AMD', horizon: 'swing' } })
    const s2 = await moved.sessions.getActive({ userId: 'u1' })
    await moved.runner.readSettled({ userId: 'u1', sessionId: s2.sessionId, symbol: 'NVDA', horizon: 'swing' }, { kind: 'coverage', state: 'ready', facts: 'f' })
    assert.equal((await rows(moved.sessions, s2)).length, 1)
    assert.equal(moved.queued.length, 0)
    assert.equal(await moved.runner.readSettled({ userId: 'u1', sessionId: 'gone', symbol: 'NVDA', horizon: 'swing' }, { state: 'ready' }), false)
})

test('the read\'s brief: for the trade, AGAINST it (say so, ask once), or none could be made', () => {
    const art = (item) => makeArtifact({ kind: KIND.PROMETHEUS_READ, items: [{ ticker: 'NVDA', horizon: 'swing', ...item }] })
    assert.equal(receiverOf(art({})), 'mentor')
    assert.match(briefFor(art({ state: 'ready', facts: 'buy.', against: false })).text, /is in: buy\. Check the trade against it/)
    assert.equal(briefFor(art({ state: 'passed', facts: 'The analyst (priced_in): no trade.', against: true })).text,
        'The analyst\'s read on NVDA for the swing trade is in, and it is against the trade: The analyst (priced_in): no trade. Say so plainly in one line, as a warning the user may override — not a question of its own; the trade\'s one question stands.')
    assert.doesNotMatch(briefFor(art({ state: 'passed', facts: 'x', against: true })).text, /Roy|20\d\d-\d\d-\d\d/, 'the hand-off row is on screen: no citations in it')
    assert.match(briefFor(art({ state: 'failed' })).text, /could not make a read on NVDA for the swing trade\. Tell me in one line, and ask me once whether to build without it/)
})

// ─── Mentor's turn context, and Prometheus's opening ─────────────────────────

test('The trader\'s context each turn: the read to validate with; against → a warning, no question of its own; running → no finish yet; none intraday', () => {
    const base = { symbol: 'NVDA', horizon: 'swing', kind: 'coverage' }
    assert.match(_buildReadSection({ ...base, state: 'ready', facts: 'buy, target 230', against: false }), /PROMETHEUS'S READ on NVDA for the swing trade \(his coverage\): buy, target 230\n {2}Validate the trade with it/)
    assert.match(_buildReadSection({ ...base, state: 'passed', facts: 'passed', against: true }), /is AGAINST it .*\n {2}If you have not said so yet, say it plainly in one line, as a WARNING they may override[\s\S]*never a question of its own/)
    assert.match(_buildReadSection({ ...base, state: 'waiting', ahead: 2 }), /PROMETHEUS IS READING NVDA for the swing trade \(his coverage, 2 names ahead of it in the house's research\).*Do not finish the trade before then: no setup put up to generate/)
    assert.match(_buildReadSection({ ...base, state: 'missing' }), /PROMETHEUS IS READING/)
    assert.match(_buildReadSection({ ...base, state: 'unknown' }), /could not be checked just now/)
    assert.equal(_buildReadSection({ symbol: 'NVDA', horizon: 'intraday', kind: null }), '')
    assert.equal(_buildReadSection(null), '')
})

test('The analyst is told a user is building the trade: coverage on the book\'s target horizon, a catalyst read on the short swing', () => {
    assert.equal(researchOpening({ symbol: 'NVDA', context: { mentor: true, horizon: 'swing' } }),
        'Research NVDA for coverage — a user is building a SWING trade on it with the trader, who needs your read before he builds. Set the price target on a 3m or 6m horizon.')
    assert.match(researchOpening({ symbol: 'NVDA', context: { mentor: true, horizon: 'long term' } }), /LONG TERM trade .* on a 12m or 18m or 24m horizon/)
    assert.match(researchOpening({ symbol: 'SMCI', context: { hotlist: true, mentor: true, requested: true, horizon: 'short term swing' } }),
        /^Catalyst read on SMCI — a user is building a SHORT-TERM SWING \(2–10 days\) on it with the trader/)
})

// ─── The fixes after the step-3 bug hunt (Roy, 2026-11-11: "fix the rest") ───

test('#2 the gate: a read still running holds Generate; one in, passed, failed or unchecked does not', async () => {
    const st = ledger('NVDA', { horizon: 'swing' })
    const waitingRow = [{ symbol: 'NVDA', status: 'queued', created_at: 'x', context: { mentor: true } }]
    assert.equal(await readPending(st, deps({ listQueue: async () => waitingRow })), true)
    assert.equal(await readPending(st, deps()), true, 'missing — about to be asked')
    assert.equal(await readPending(st, deps({ coverage: async () => COV })), false)
    assert.equal(await readPending(st, deps({ coverage: async () => { throw new Error('down') } })), false, 'unknown opens it')
    assert.equal(await readPending(ledger('NVDA', { horizon: 'intraday' }), deps()), false)
})

test('#2 the press: Generate and Generate all are refused while the read runs, with a reason the user can read', async () => {
    const commit = { commitSetup: async () => { throw new Error('must not commit') }, generateSetups: async () => { throw new Error('must not commit') } }
    const acts = makeMentorActions({ commit, readPending: async () => true })
    const args = { accounts: [{ id: 'a1' }], mainAccountId: 'a1' }
    const state = { ...ledger('NVDA', { horizon: 'swing' }), drafts: { AMD: { asset: 'AMD' } } }
    assert.deepEqual(await acts.generate({ user: { _id: 'u1' }, state, args }), { reason: 'read_pending' })
    assert.deepEqual(await acts.generateAll({ user: { _id: 'u1' }, state, args }), { reason: 'read_pending' })
    assert.deepEqual(setupReason('read_pending'), [409, 'I am still reading this name — Generate opens when the read lands'])
})

test('#2 a failed read is remembered: not asked again, and Generate opens — the user decides', async () => {
    onReadSettled(async () => true)
    const d = deps({ enqueue: async () => ({ ok: true }) })
    await requestRead({ symbol: 'TSLA', horizon: 'swing', sessionId: 's1', userId: 'u1' }, d)
    await settlePending(d)   // the run left nothing: failed
    assert.equal((await readFor('TSLA', 'swing', d, { sessionId: 's1' })).state, 'failed')
    const again = await requestRead({ symbol: 'TSLA', horizon: 'swing', sessionId: 's1', userId: 'u1' }, { ...d, enqueue: async () => { throw new Error('must not queue') } })
    assert.equal(again.state, 'failed')
    assert.equal(await readPending(ledger('TSLA', { horizon: 'swing' }), d, { sessionId: 's1' }), false)
    // A day later it may be asked again.
    assert.equal((await readFor('TSLA', 'swing', { ...d, now: () => NOW + DAY + 1 }, { sessionId: 's1' })).state, 'missing')
    // CR #4: another session's build on the same name is not touched by it.
    assert.equal((await readFor('TSLA', 'swing', d, { sessionId: 's2' })).state, 'missing')
})

// ─── The second round, after the code review (2026-11-11) ────────────────────

const claimRow = (over = {}) => ({ id: 'rq_NVDA_1', symbol: 'NVDA', status: 'in_research', created_at: '2026-11-11T14:00:00Z',
    updated_at: new Date(NOW - 5 * 60_000).toISOString(), context: { mentor: true }, ...over })

test('CR #1: a claim the run decided against (a failed turn or save, a Stop) or a dead one is FAILED, not "still reading"', async () => {
    assert.equal((await readFor('NVDA', 'swing', deps({ listQueue: async (q) => (q.symbols ? [claimRow()] : []) }))).state, 'waiting', 'a live claim is waiting')
    for (const reason of ['failed', 'save_failed', 'stopped']) {
        const r = await readFor('NVDA', 'swing', deps({ listQueue: async () => [claimRow({ reason })] }))
        assert.equal(r.state, 'failed', reason)
        assert.equal(r.rowId, 'rq_NVDA_1')
    }
    const stale = await readFor('NVDA', 'swing', deps({ listQueue: async () => [claimRow({ updated_at: new Date(NOW - 2 * 60 * 60_000).toISOString() })] }))
    assert.equal(stale.state, 'failed', 'a claim untouched for two hours is a dead process\'s')
    // …so Generate is not held by it.
    assert.equal(await readPending(ledger('NVDA', { horizon: 'swing' }), deps({ listQueue: async () => [claimRow({ reason: 'failed' })] })), false)
})

test('CR #1: a dead claim settles as FAILED to the waiting session; after a day the same row is put back in line', async () => {
    const handed = []
    onReadSettled(async (p, r) => { handed.push([p.symbol, r.state]); return true })
    let rows = [claimRow({ status: 'queued', updated_at: new Date(NOW).toISOString() })]
    const d = deps({ listQueue: async () => rows })
    await requestRead({ symbol: 'NVDA', horizon: 'swing', sessionId: 's1', userId: 'u1' }, d)
    rows = [claimRow({ reason: 'save_failed', updated_at: new Date(NOW).toISOString() })]
    await settlePending(d)
    assert.deepEqual(handed, [['NVDA', 'failed']])
    const requeued = []
    const later = deps({ now: () => NOW + DAY + 60_000, listQueue: async () => rows, requeue: async (id) => { requeued.push(id); rows = [claimRow({ status: 'queued' })]; return { ok: true } } })
    const r = await requestRead({ symbol: 'NVDA', horizon: 'swing', sessionId: 's1', userId: 'u1' }, later)
    assert.deepEqual(requeued, ['rq_NVDA_1'])
    assert.equal(r.asked, true, 'the chat is told it is being read again')
    assert.equal(later.calls.enqueue.length, 0, 'the old row, not a new one')
})

test('CR #2: only a run that finished cleanly starts the next — an account failure or a Stop does not loop', async () => {
    onReadSettled(async () => true)
    const queued = [{ symbol: 'AMD', status: 'queued', created_at: 'x', context: { mentor: true } }]
    const d = deps({ listQueue: async () => queued })
    await requestRead({ symbol: 'AMD', horizon: 'swing', sessionId: 's1', userId: 'u1' }, d)
    d.calls.startRun.length = 0
    await settlePending(d, { status: 'failed', error: 'requires more credits' })
    await settlePending(d, { status: 'stopped' })
    assert.equal(d.calls.startRun.length, 0)
    await settlePending(d, { status: 'done' })
    assert.equal(d.calls.startRun.length, 1)
})

test('CR #8: two settles at once hand one read on ONCE — the passes run in turn', async () => {
    const handed = []
    onReadSettled(async (p) => { handed.push(p.symbol); await new Promise(r => setTimeout(r, 5)); return true })
    let landed = false
    const d = deps({ coverage: async () => (landed ? COV : null), enqueue: async () => ({ ok: true }) })
    await requestRead({ symbol: 'NVDA', horizon: 'swing', sessionId: 's1', userId: 'u1' }, d)
    landed = true
    await Promise.all([settlePending(d), settlePending(d)])
    assert.deepEqual(handed, ['NVDA'])
})

test('CR #5: only a PASS stands as the catalyst answer — a spent read (hit, expired, graded) gets a fresh one', async () => {
    for (const status of ['hit', 'expired', 'graded', 'active']) {
        const r = await readFor('SMCI', 'short term swing', deps({ latestCatalyst: async () => ({ status, verdict: 'credible', read: 'x' }) }))
        assert.equal(r.state, 'missing', status)
    }
})

test('CR #4: the trader is told a read failed — never left building without a word', () => {
    assert.match(_buildReadSection({ symbol: 'NVDA', horizon: 'swing', kind: 'coverage', state: 'failed' }),
        /PROMETHEUS COULD NOT MAKE A READ on NVDA for the swing trade \(his coverage\).*ask the user whether to build without it/)
})

test('#3 the run is started on the SYMBOL, not the source — a row another chain queued is the user\'s answer too', async () => {
    const d = deps({ listQueue: async () => [{ symbol: 'NVDA', status: 'queued', source: 'pythia', created_at: 'x', context: { pythia: true } }] })
    const r = await requestRead({ symbol: 'NVDA', horizon: 'swing', sessionId: 's1', userId: 'u1' }, d)
    assert.equal(r.state, 'waiting')
    assert.equal(d.calls.enqueue.length, 0, 'not queued twice')
    assert.deepEqual(d.calls.startRun, [{ userId: null, symbols: ['NVDA'] }])
})

test('#4 a landed read does not take over another desk\'s running chain — the line is posted, nothing is handed on', async () => {
    const r = rig()
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'chn_atlas', status: 'running', origin: 'portfolio', steps: 2 } })
    await r.runner.readSettled({ userId: 'u1', sessionId: s.sessionId, symbol: 'NVDA', horizon: 'swing' }, { kind: 'coverage', state: 'ready', facts: 'buy' })
    assert.deepEqual((await rows(r.sessions, s)).map(m => m.agent), ['analyst'])
    assert.equal(r.queued.length, 0)
    const h = await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })
    assert.equal(h.chain.origin, 'portfolio', 'The portfolio manager keeps its chain')
})

test('#5 after a restart the waiting reads are found again from their rows — the session rides on the row', async () => {
    const d = deps({ enqueue: async (row) => { d.calls.enqueue.push(row); return { ok: true } } })
    await requestRead({ symbol: 'NVDA', horizon: 'swing', sessionId: 's9', userId: 'u1' }, d)
    assert.equal(d.calls.enqueue[0].context.sessionId, 's9')
    _resetPending()
    const rowsBack = [
        { symbol: 'NVDA', status: 'queued', source: 'mentor', requestedBy: 'u1', context: { mentor: true, horizon: 'swing', sessionId: 's9' } },
        { symbol: 'SMCI', status: 'in_research', source: 'mentor', requestedBy: 'u2', context: { hotlist: true, mentor: true, horizon: 'short term swing', sessionId: 's8' } },
        { symbol: 'OLD', status: 'queued', source: 'mentor', requestedBy: 'u3', context: { mentor: true, horizon: 'swing' } },
    ]
    const back = deps({ listQueue: async () => rowsBack })
    assert.deepEqual(await resumePending(back), { resumed: 2 })
    assert.deepEqual(pendingReads().map(p => [p.sessionId, p.symbol, p.kind, p.userId]), [['s9', 'NVDA', 'coverage', 'u1'], ['s8', 'SMCI', 'catalyst', 'u2']])
    assert.deepEqual(back.calls.startRun, [{ userId: null, symbols: ['NVDA', 'SMCI'] }])
    assert.deepEqual(await resumePending(deps({ listQueue: async () => null })), { resumed: 0 })
})

// ─── The TSLA drive (2026-11-12): "let's trade TSLA" — a first reply with no worksheet still gets the experts asked ─
test("the name his reply was on (its <asset> tag) reaches the state, so the reads are asked after a first reply with no worksheet", async () => {
    const { mentorNextState } = await import('../../services/desks/mentor.desk.js')
    assert.equal(mentorNextState(null, { reply: 'Asking the analyst and the technical analyst.', taggedAsset: 'TSLA' }).active_asset, 'TSLA')
    assert.deepEqual(readTarget(mentorNextState(null, { reply: 'x', taggedAsset: 'TSLA' })), { symbol: 'TSLA', horizon: null })
})

test('a FRESH deciding read is handed to the trader at once (his verdict is the turn it runs), and only once per session and name', async () => {
    const r = rig({ target: { symbol: 'TSLA', horizon: null }, request: async () => ({ kind: 'coverage', state: 'ready', decide: true, facts: 'The analyst buy, target 480.00', against: false }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'mentor', state: { active_asset: 'TSLA', draft: null } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Asking them.' } } })
    const [line, hand] = await rows(r.sessions, s)
    assert.equal(line.agent, 'analyst')
    assert.equal(line.content, 'TSLA: The analyst buy, target 480.00', 'no "null" horizon in the line')
    assert.equal(hand.kind, 'handoff')
    assert.equal(r.queued[0].agent, 'mentor')
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { payload: { reply: 'Long, swing.' } } })
    assert.equal(r.queued.length, 1, 'handed once')
})

// ─── The TSLA drive (2026-11-12): no "paused" / "needs your call" cards inside Mentor's own read chain ─────────────
test("inside a chain MENTOR started on his own read: no pause card and no 'needs your call' card — the chain just ends", async () => {
    // The read was already handed (no new hand-off this turn — a hand-off takes the chain over, the test below).
    const r = rig({ target: null })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c1', status: 'running', origin: 'mentor', steps: 1, pauseRequested: true } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { payload: { reply: 'Long, swing.', setup: { asset: 'TSLA' }, readiness: { ready: true } } } })
    const said = (await rows(r.sessions, s)).map(m => m.content)
    assert.ok(!said.some(c => /Paused while you spoke|needs your call/.test(c)), said.join(' | '))
    assert.equal((await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).chain.status, 'done')
})

test("a chain ANOTHER desk started still pauses and asks (the portfolio manager's sleeve going through the trader is not his own)", async () => {
    const r = rig({ target: null })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.sessions.setChain({ sessionId: s.sessionId, userId: 'u1', chain: { id: 'c2', status: 'running', origin: 'portfolio', steps: 1, pauseRequested: true } })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { payload: { reply: 'x' } } })
    assert.ok((await rows(r.sessions, s)).some(m => /Paused while you spoke/.test(m.content)))
})

test('the horizon must fit the trade that can be built — a day trade only when the entry can fill today (the TSLA drive)', async () => {
    const { readFileSync } = await import('node:fs')
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    assert.match(p, /\*\*The horizon must fit the trade you can\s+build\*\*/)
    assert.match(p, /within about one daily ATR of the price, so it can fill today, and nothing waits on a\s+day close/)
})

test('a deciding read that LANDED is handed once: the next turn finding it fresh does not hand it again (CR 2026-11-12)', async () => {
    const ready = { kind: 'coverage', state: 'ready', decide: true, facts: 'f', against: false }
    const r = rig({ target: { symbol: 'TSLA', horizon: null }, request: async () => ready })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.readSettled({ userId: 'u1', sessionId: s.sessionId, symbol: 'TSLA', horizon: null }, ready)
    const before = (await rows(r.sessions, s)).length
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'chain', out: { payload: { reply: 'Long, swing.' } } })
    assert.equal((await rows(r.sessions, s)).length, before, 'no second the analyst line, no second hand-off')
    assert.equal(r.queued.length, 1, 'one the trader turn queued, by the landing only')
})

test('a FRESH deciding read handed after a turn ends that turn: no decision card, no carry on top of the hand-off', async () => {
    const r = rig({ target: { symbol: 'TSLA', horizon: null }, request: async () => ({ kind: 'coverage', state: 'ready', decide: true, facts: 'f', against: false }) })
    const s = await r.sessions.getActive({ userId: 'u1' })
    await r.runner.afterTurn({ user, sessionId: s.sessionId, agent: 'mentor', origin: 'user', out: { payload: { reply: 'Asking them.', cut_short: true } } })
    assert.equal(r.queued.length, 1, 'only the hand-off turn')
    assert.equal(r.queued[0].agent, 'mentor')
    assert.equal((await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).chain.status, 'running')
})

test('"not a long now" is a warning, not a refusal: their numbers are the override, and nothing is asked after them (the TSLA drive, 2026-11-12)', async () => {
    const { readFileSync } = await import('node:fs')
    const p = readFileSync(new URL('../../prompts/mentor_system_prompt.md', import.meta.url), 'utf8')
    assert.match(p, /\*\*"Not a long now" is a WARNING, not a refusal\*\*/)
    assert.match(p, /Their numbers after a "not a long now" are their override: build it\.\*\* Never\s+refuse once they gave them/)
    assert.match(p, /"all the way" is never answered with a question/)
    assert.doesNotMatch(p, /"Not a long now" is an answer: say why, and\s+stop there/)
})
