import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { _splitRoute, axlAgentService } from '../../services/axl.agent.service.js'
import { _sanitizeRouteSymbol, VALID_PIPELINES } from '../../api/axl/axl.controller.js'

// Axl's desk hand-off: `<route>research NVDA</route>` — the desk AND the name it should open on.
// The symbol is what turns "routing you to Prometheus" into Prometheus already researching NVDA,
// so it is parsed here and sanitized in the controller: it becomes an agent's opening turn.

// ── the tag split (service) ───────────────────────────────────────────────────

test('split: desk + symbol', () => {
    assert.deepEqual(_splitRoute('research NVDA'), { desk: 'research', symbol: 'NVDA' })
})

test('split: a bare desk (a scan, a whole portfolio) → no symbol', () => {
    assert.deepEqual(_splitRoute('scan'), { desk: 'scan', symbol: null })
})

test('split: tolerant separators + a capitalized desk', () => {
    assert.deepEqual(_splitRoute('Research:NVDA'), { desk: 'research', symbol: 'NVDA' })
    assert.deepEqual(_splitRoute(' trade,  TSLA '), { desk: 'trade', symbol: 'TSLA' })
})

test('split: extra words past the symbol are ignored, not concatenated', () => {
    assert.deepEqual(_splitRoute('research NVDA for coverage'), { desk: 'research', symbol: 'NVDA' })
})

test('split: no tag at all → nothing to route', () => {
    assert.deepEqual(_splitRoute(null), { desk: null, symbol: null })
    assert.deepEqual(_splitRoute(''), { desk: null, symbol: null })
})

// ── the symbol gate (controller) ──────────────────────────────────────────────

test('sanitize: uppercases, and passes dotted/dashed tickers', () => {
    assert.equal(_sanitizeRouteSymbol('nvda'), 'NVDA')
    assert.equal(_sanitizeRouteSymbol(' brk.b '), 'BRK.B')
    assert.equal(_sanitizeRouteSymbol('BTC-USD'), 'BTC-USD')
})

test('sanitize: junk the model may have attached → null (the desk opens empty)', () => {
    assert.equal(_sanitizeRouteSymbol('the'), 'THE')          // 3 letters IS a plausible ticker — passes by design
    assert.equal(_sanitizeRouteSymbol('Nvidia Corp'), null)   // a space is never a symbol
    assert.equal(_sanitizeRouteSymbol('$NVDA'), null)         // decorated
    assert.equal(_sanitizeRouteSymbol('NASDAQ:NVDA'), null)   // exchange-prefixed
    assert.equal(_sanitizeRouteSymbol('ABCDEFGHIJKLMNOP'), null)
    assert.equal(_sanitizeRouteSymbol(''), null)
    assert.equal(_sanitizeRouteSymbol(null), null)
    assert.equal(_sanitizeRouteSymbol(42), null)
})

// ── the prompt and the gate agree ─────────────────────────────────────────────

// The failure this catches is silent and total: the prompt teaches Axl a tag the controller drops,
// so Axl says "taking you there", the desk never opens, and nothing errors. It is exactly how the
// Assist desk sat unroutable — a desk in the hub with no key in the gate.
test('every route tag the prompt teaches is one the controller accepts', () => {
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), '../../axl_system_prompt.md')
    const prompt = readFileSync(promptPath, 'utf8')
    const taught = [...prompt.matchAll(/<route>([a-z]+)(?:[\s:,][^<]*)?<\/route>/g)].map(m => m[1])

    assert.ok(taught.length >= 4, 'the prompt still teaches the route tags')
    for (const desk of new Set(taught)) {
        assert.ok(VALID_PIPELINES.has(desk), `the prompt teaches <route>${desk}</route> but the controller drops it`)
    }
})

// ── the whole turn (service, over the _run seam) ──────────────────────────────

// Stand in for runAgentStream: the tag never reaches the token stream, so the capture is how the
// service sees it — hand the reply back through the same callback the real stream uses.
function runWith(reply) {
    return async ({ tagCaptures }) => {
        const routeTag = reply.match(/<route>([\s\S]*?)<\/route>/)
        const capture = (tagCaptures ?? []).find(c => c.open === '<route>')
        if (routeTag) capture?.onCapture?.(routeTag[1])
        return reply
    }
}

test('turn: the tag becomes route + routeSymbol and never shows up in the reply', async () => {
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: "let's research nvda" }],
        _run: runWith('Taking you to Prometheus. <route>research NVDA</route>'),
    })
    assert.equal(result.route, 'research')
    assert.equal(result.routeSymbol, 'NVDA')
    assert.equal(result.reply, 'Taking you to Prometheus.')
})

test('turn: a clarifying question (no tag) keeps the user with Axl', async () => {
    const result = await axlAgentService.chatStream({
        messages: [{ role: 'user', content: "let's analyze nvda" }],
        _run: runWith('A tradeable setup on it, or a research thesis?'),
    })
    assert.equal(result.route, null)
    assert.equal(result.routeSymbol, null)
    assert.equal(result.reply, 'A tradeable setup on it, or a research thesis?')
})

// ── intake: the goal the user states on the way in ────────────────────────────
//
// The objective is what survives the hop to a desk, so the turn has to surface its id (the client
// shows the captured goal back to the user) and stamp which desk took it. The collaborators are
// injected here — intake is the one part of Axl that touches a database, and this seam is what
// keeps a unit test of the turn from needing one.

/** Like runWith, but the model calls save_objective before it answers. */
function runWithIntake(reply, args = { target_pct: 5, horizon_days: 7 }) {
    return async ({ tagCaptures, toolHandlers }) => {
        await toolHandlers.save_objective(args)
        const routeTag = reply.match(/<route>([\s\S]*?)<\/route>/)
        const capture = (tagCaptures ?? []).find(c => c.open === '<route>')
        if (routeTag) capture?.onCapture?.(routeTag[1])
        return reply
    }
}

const summary = (id) => ({ id, target: { pct: 5 }, horizon: { days: 7, until: '2026-08-06' }, risk: {}, scope: null, symbol: null })
const stubHandlers = (id = 'obj_1') => () => ({
    save_objective: async () => ({ saved: true, id, deadline: '2026-08-06', objective: summary(id) }),
})

test('turn: an objective captured this turn rides out on the result', async () => {
    const result = await axlAgentService.chatStream({
        userId: 'u1',
        messages: [{ role: 'user', content: 'I want to make 5% in the next week' }],
        _run: runWithIntake('Noted — 5% by August 6th. One position or several?'),
        _objectiveHandlers: stubHandlers('obj_1'),
        _tradingContextHandlers: () => ({}),
    })
    assert.equal(result.objective?.id, 'obj_1')
    assert.equal(result.objective?.horizon.until, '2026-08-06', 'the chip needs the goal, not just its id')
    assert.equal(result.route, null, 'capturing a goal is not the same as handing it to a desk')
})

test('turn: routing a turn LATER still finds the open objective and stamps the desk', async () => {
    // The goal is usually captured a turn or two before the hand-off, so the id from this turn is
    // null while an open objective still exists. Without the lookup the stamp would just be missed.
    const marked = []
    const result = await axlAgentService.chatStream({
        userId: 'u1',
        messages: [{ role: 'user', content: 'one position' }],
        _run: runWith('Taking you to the trading desk. <route>trade NVDA</route>'),
        _objectiveHandlers: stubHandlers(),
        _tradingContextHandlers: () => ({}),
        _getOpenObjective: async () => summary('obj_earlier'),
        _markRouted: async (id, desk) => { marked.push([id, desk]) },
    })
    assert.equal(result.objective?.id, 'obj_earlier')
    assert.deepEqual(marked, [['obj_earlier', 'trade']])
})

test('turn: a reply that does not route never pays for the objective lookup', async () => {
    // Every Axl turn would otherwise carry a database read for a stamp only a hand-off needs.
    let looked = 0
    const result = await axlAgentService.chatStream({
        userId: 'u1',
        messages: [{ role: 'user', content: 'what is a stop loss?' }],
        _run: runWith('A stop is the price where you accept the idea was wrong.'),
        _objectiveHandlers: stubHandlers(),
        _tradingContextHandlers: () => ({}),
        _getOpenObjective: async () => { looked++; return summary('obj_1') },
    })
    assert.equal(looked, 0)
    assert.equal(result.objective, null)
})

test('turn: routing with no objective at all is fine — the desk simply asks', async () => {
    const result = await axlAgentService.chatStream({
        userId: 'u1',
        messages: [{ role: 'user', content: 'find me a trade on tsla' }],
        _run: runWith('Off to Kairos. <route>trade TSLA</route>'),
        _objectiveHandlers: stubHandlers(),
        _tradingContextHandlers: () => ({}),
        _getOpenObjective: async () => null,
        _markRouted: async () => { throw new Error('must not stamp a goal that does not exist') },
    })
    assert.equal(result.objective, null)
    assert.equal(result.route, 'trade')
})
