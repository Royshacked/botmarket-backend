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
