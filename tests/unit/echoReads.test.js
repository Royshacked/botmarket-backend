import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendNames, handOffFlagged, forwardContext, HANDOFFS, SOURCE, MAX_ASK } from '../../services/echoReads.service.js'
import { echoOpening, researchOpening } from '../../services/researchRun.service.js'
import { makeEchoHandlers } from '../../services/tools/echo.tools.js'
import { isToolError, toolErrorText } from '../../services/toolResult.util.js'
import { SOURCES } from '../../services/researchQueue.service.js'

// Echo's names through Prometheus and Proteus (docs/design/echo-desk.md §6): flagged only, swing, once per event.

const NOW = Date.parse('2026-11-20T06:00:00Z')
function deps({ reads = {}, events = [], done = [], on = true } = {}) {
    const calls = { profiles: [], enqueue: [], research: [], resume: [], handoffs: [] }
    const col = {
        find(q) { return { toArray: async () => done.filter(id => q._id.$in.includes(id)).map(id => ({ _id: id })) } },
        async updateOne(q, u) { calls.handoffs.push([q._id, u.$setOnInsert]) },
    }
    return {
        calls,
        readFor: async (s) => reads[s] ?? { state: 'missing', need: 'new' },
        enqueue: async (row) => { calls.enqueue.push(row); return { ok: true, id: `rq_${row.symbol}` } },
        listQueue: async () => [],
        research: async (o) => { calls.research.push(o); return { ok: true, outcome: 'started' } },
        resume: async (symbols, research) => { calls.resume.push(symbols); return research() },
        profiles: (s) => { calls.profiles.push(s) },
        events: async () => ({ events }),
        db: { collection: (name) => { assert.equal(name, HANDOFFS); return col } },
        on: () => on,
        maxUsd: () => 2,
        now: () => NOW,
    }
}

const link = (ticker, extra = {}) => ({ ticker, name: `${ticker} Inc.`, relation: 'supplier', direction: 'loses', why: `${ticker} builds for Cisco.`, group: 'flagged', ...extra })
const CSCO = { id: 'csco-earnings-2026-11-12', date: '2026-11-12', origin: 'Cisco', tickers: ['CSCO'], effect: 'down', size: 'Day 0 move -5.9% vs SPY',
    status: 'checked', flagged: [link('JBL'), link('FLEX')] }

test('echo is a research-queue source', () => {
    assert.ok(SOURCES.includes(SOURCE))
})

test('sendNames: Proteus for every name; Prometheus queued only where no read stands', async () => {
    const d = deps({ reads: { AMD: { state: 'ready' }, MU: { state: 'waiting' }, TSM: { state: 'missing', need: 'view' }, SNDK: { state: 'missing', need: 'reinit' } } })
    const r = await sendNames(['amd', 'MU', 'TSM', 'SNDK', 'STX', 'STX'], (s) => ({ echo: true, why: s }), {}, d)
    assert.deepEqual(d.calls.profiles, [['AMD', 'MU', 'TSM', 'SNDK', 'STX']], 'every name to Proteus, once, upper-cased')
    assert.deepEqual(r.names, [{ symbol: 'AMD', read: 'ready' }, { symbol: 'MU', read: 'waiting' }, { symbol: 'TSM', read: 'covered' },
        { symbol: 'SNDK', read: 'queued' }, { symbol: 'STX', read: 'queued' }])
    assert.deepEqual(d.calls.enqueue.map(e => [e.symbol, e.source, e.context.reinit ?? false]), [['SNDK', 'echo', true], ['STX', 'echo', false]])
    assert.equal(d.calls.research.length, 1)
    assert.deepEqual(d.calls.research[0].symbols, ['SNDK', 'STX'])
    assert.equal(d.calls.research[0].maxUsd, 2, "the house's weekly Echo budget")
    assert.equal(d.calls.research[0].budgetSince, new Date(NOW - 7 * 86_400_000).toISOString())
})

test('sendNames: nothing missing → nothing queued, no run', async () => {
    const d = deps({ reads: { AMD: { state: 'ready' } } })
    const r = await sendNames(['AMD'], () => ({}), {}, d)
    assert.deepEqual(r.queued, [])
    assert.equal(r.research, null)
    assert.deepEqual(await sendNames([], () => ({}), {}, d), { ok: true, names: [], queued: [], research: null })
})

test('the forward context says the event, the link, the rule, and that it lagged', () => {
    const c = forwardContext(CSCO, link('JBL'))
    assert.equal(c.echo, true); assert.equal(c.forward, true); assert.equal(c.horizon, 'swing')
    assert.match(c.event, /^Cisco \(CSCO\) down on its 2026-11-12 results — Day 0 move -5\.9% vs SPY$/)
    assert.equal(c.reason, 'The event analyst: lagging supplier of CSCO (forward test)')
})

test('handOffFlagged: checked events with lagging names, once each; mapped / late / no-flag events wait', async () => {
    const events = [CSCO, { ...CSCO, id: 'x-earnings-2026-11-13', status: 'mapped' }, { ...CSCO, id: 'y-earnings-2026-11-14', flagged: [] },
        { ...CSCO, id: 'z-earnings-2026-11-15', status: 'done', flagged: [link('ANET')] }]
    const d = deps({ events, done: ['z-earnings-2026-11-15'] })
    const r = await handOffFlagged(d)
    assert.deepEqual(r.handed, ['csco-earnings-2026-11-12'], 'z was handed off before; x not checked; y lagged nowhere')
    assert.deepEqual(d.calls.enqueue.map(e => e.symbol), ['JBL', 'FLEX'])
    assert.equal(d.calls.enqueue[0].context.relation, 'supplier')
    assert.equal(d.calls.handoffs[0][0], 'csco-earnings-2026-11-12')
    assert.deepEqual(d.calls.handoffs[0][1].names.map(n => n.symbol), ['JBL', 'FLEX'])
})

test('handOffFlagged: off → nothing at all', async () => {
    const d = deps({ events: [CSCO], on: false })
    assert.deepEqual(await handOffFlagged(d), { handed: [], resume: null, off: true })
    assert.equal(d.calls.enqueue.length, 0)
})

test('handOffFlagged: Echo rows left waiting are resumed', async () => {
    const d = deps({ events: [] })
    d.listQueue = async (q) => { assert.equal(q.source, 'echo'); return [{ symbol: 'JBL' }, { symbol: 'JBL' }, { symbol: 'FLEX' }] }
    const r = await handOffFlagged(d)
    assert.deepEqual(d.calls.resume, [['JBL', 'FLEX']])
    assert.equal(r.resume.outcome, 'started')
})

test("Prometheus's opening: the event, the link, the rule; a lagging name is said to be no pick", () => {
    const o = echoOpening('JBL', forwardContext(CSCO, link('JBL')))
    assert.match(o, /^Research JBL for coverage — the event analyst linked it to an event: Cisco \(CSCO\) down/)
    assert.match(o, /It is a supplier of Cisco — JBL builds for Cisco\. By the chain rule the event should hurt it\./)
    assert.match(o, /NOT caught up by the 5th session — the test is unproven, so this is not a pick/)
    assert.match(o, /3m or 6m horizon \(SWING\)/)
    assert.equal(researchOpening({ symbol: 'JBL', context: forwardContext(CSCO, link('JBL')) }), o, 'researchOpening dispatches to it')
    const user = echoOpening('AMD', { echo: true, forward: false, event: 'GTA 6 released (2026-11-19)', origin: 'Take-Two', relation: 'supplier', direction: 'gains', reinit: true })
    assert.match(user, /^Re-research AMD — your coverage on it is not live —/)
    assert.match(user, /should help it\. A user mapped this event and asked for your read\./)
    assert.doesNotMatch(echoOpening('NTES', { echo: true, relation: 'peer', direction: 'unclear' }), /chain rule/)
})

const USER_DOC = { _id: 'ue_1', userId: 'u1', event: { date: '2026-11-19', what_changed: 'GTA 6 released', origin: 'Take-Two', origin_tickers: ['TTWO'], effect: 'up' },
    map: { links: [
        { ticker: 'AMD', relation: 'supplier', direction: 'gains', evidence_text: 'console chips' },
        { ticker: 'MU', relation: 'infrastructure', direction: 'gains', evidence_text: 'memory' },
        { ticker: 'GME', relation: 'customer', direction: 'unclear', evidence_text: 'retail' },
        { ticker: null, name: 'Foxconn', relation: 'supplier', direction: 'gains' },
    ] } }
const maps = { getUserEvent: async (id, u) => (id === 'ue_1' && u === 'u1' ? USER_DOC : null) }

test('request_reads: the directional links by default, the picked ones when named, theirs only', async () => {
    const sent = []
    const reads = { sendNames: async (syms, ctx, opts) => { sent.push({ syms, ctx: syms.map(ctx), opts }); return { names: syms.map(s => ({ symbol: s, read: s === 'AMD' ? 'ready' : 'queued' })), research: { outcome: 'busy' } } } }
    const h = makeEchoHandlers({ userId: 'u1', maps, reads })
    const out = await h.request_reads({ id: 'ue_1' })
    assert.deepEqual(sent[0].syms, ['AMD', 'MU'], 'unclear and unpriced links are not sent by default')
    assert.equal(sent[0].ctx[0].user_event, true); assert.equal(sent[0].ctx[0].forward, false)
    assert.equal(sent[0].opts.maxUsd, Infinity, 'a user ask is capped by count, not the house budget')
    assert.equal(sent[0].opts.requestedBy, 'u1')
    assert.match(out, /- AMD: the analyst's coverage stands — read it there; the technical analyst's profile queued/)
    assert.match(out, /- MU: queued for the analyst \(swing coverage\)/)
    assert.match(out, /busy with another run — these wait in line/)
    await h.request_reads({ id: 'ue_1', tickers: ['gme'] })
    assert.deepEqual(sent[1].syms, ['GME'], 'a name the user picked goes, unclear or not')
})

test('request_reads refuses: a forward-test id, another user\'s event, a name not on the map, too many', async () => {
    const reads = { sendNames: async () => { throw new Error('must not be called') } }
    const h = makeEchoHandlers({ userId: 'u1', maps, reads })
    const e = async (args, re) => { const r = await h.request_reads(args); assert.ok(isToolError(r)); assert.match(toolErrorText(r), re) }
    await e({ id: 'csco-earnings-2026-11-12' }, /on their own after the day-5 check/)
    await e({ id: 'ue_2' }, /No event ue_2/)
    await e({ id: 'ue_1', tickers: ['NVDA'] }, /Not on this map: NVDA/)
    const many = { ...USER_DOC, map: { links: Array.from({ length: MAX_ASK + 1 }, (_, i) => ({ ticker: `T${i}`, relation: 'supplier', direction: 'gains' })) } }
    const h2 = makeEchoHandlers({ userId: 'u1', maps: { getUserEvent: async () => many }, reads })
    const r = await h2.request_reads({ id: 'ue_1' })
    assert.ok(isToolError(r)); assert.match(toolErrorText(r), /at most 5 at a time/)
    assert.ok(isToolError(await makeEchoHandlers({ userId: null, maps, reads }).request_reads({ id: 'ue_1' })))
})
