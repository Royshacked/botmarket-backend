import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAssessTools, makeAssessToolRunner, requestedSymbols, _testHandlers } from '../../monitoring/assessTools.js'

// The monitor's tool kit. Two properties earn this file:
//
// 1. IT IS THE REGISTRY'S, NOT A FORK. The previous kit was a hand-rolled copy of registry tools
//    with the ticker stripped out (hardcoded to the entity's own asset), which is precisely why a
//    condition like "NVDA is weak intraday" could be written and never checked. If a tool here
//    loses its `ticker` parameter again, that whole class of condition silently stops working.
//
// 2. THE SYMBOL SCOPE IS THE BUDGET. Free-text conditions can name any ticker in the world. Mounting
//    general tools without bounding WHICH instruments they may read would hand an unbounded fetch
//    budget to whatever the model decides to type.

test('the kit is the shared registry kit, and its reads take a ticker', () => {
    const tools = buildAssessTools()
    const byName = Object.fromEntries(tools.map(t => [t.name, t]))

    for (const n of ['get_chart', 'get_candles', 'get_indicators', 'get_orderblocks', 'get_structure']) {
        assert.ok(byName[n], `${n} must be mounted`)
        assert.ok(byName[n].input_schema.properties.ticker,
            `${n} must take a ticker — without it, a condition about another symbol is unverifiable`)
    }
    // The one condition-about-the-world tool. Server-side: no input_schema, run by Anthropic.
    assert.equal(byName.web_search.type, 'web_search_20250305')
})

test('every mounted tool can actually be executed', () => {
    // A tool the model can see but the runner cannot dispatch is a guaranteed error tool_result.
    const missing = buildAssessTools().filter(t => !t.type && !_testHandlers[t.name]).map(t => t.name)
    assert.deepEqual(missing, [])
})

test('a monitor never surfaces its charts to the user', () => {
    // The chart tools omit show_to_user, so a monitor read cannot push an image into the chat.
    const byName = Object.fromEntries(buildAssessTools().map(t => [t.name, t]))
    for (const n of ['get_chart', 'get_orderblocks', 'get_false_breaks']) {
        assert.equal(byName[n].input_schema.properties.show_to_user, undefined, n)
    }
})

// ─── Symbol scope ─────────────────────────────────────────────────────────────

test('every spelling of "which instrument" is seen', () => {
    // Checked as a set rather than per-tool: a newly-mounted tool must not escape the scope by
    // naming its argument differently (get_derivatives_context says `symbol`, get_quotes `tickers`).
    assert.deepEqual(requestedSymbols({ ticker: 'nvda' }), ['NVDA'])
    assert.deepEqual(requestedSymbols({ symbol: 'btcusdt' }), ['BTCUSDT'])
    assert.deepEqual(requestedSymbols({ tickers: ['smh', ' qqq '] }), ['SMH', 'QQQ'])
    assert.deepEqual(requestedSymbols({ timeframe: '15min' }), [], 'a symbol-less call asks about nothing')
})

const runnerWith = (over = {}) => {
    const calls = []
    const run = makeAssessToolRunner({
        symbols: ['NVDA', 'SMH'],
        onCall: (n) => calls.push(n),
        handlers: { get_chart: async () => 'chart', get_quotes: async () => 'quotes', ...over },
    })
    return { run, calls }
}
const use = (name, input) => [{ type: 'tool_use', id: 't1', name, input }]

test('a read inside the plan\'s scope runs', async () => {
    const { run, calls } = runnerWith()
    const [res] = await run(use('get_chart', { ticker: 'NVDA', timeframe: '15min' }))
    assert.equal(res.is_error, undefined)
    assert.equal(res.content, 'chart')
    assert.deepEqual(calls, ['get_chart'])
})

test('a read outside it is refused, and the model is TOLD what it may read', async () => {
    // Refusing silently would leave the model guessing; it needs to know to mark the condition
    // unchecked rather than retry the same blocked symbol forever.
    const { run, calls } = runnerWith()
    const [res] = await run(use('get_chart', { ticker: 'TSLA', timeframe: '15min' }))
    assert.equal(res.is_error, true)
    assert.match(res.content, /TSLA/)
    assert.match(res.content, /NVDA, SMH/)
    assert.match(res.content, /unchecked/, 'must name the honest fallback')
    assert.deepEqual(calls, [], 'a blocked read costs nothing')
})

test('one out-of-scope name in a batch blocks the batch', async () => {
    const { run } = runnerWith()
    const [res] = await run(use('get_quotes', { tickers: ['SMH', 'TSLA'] }))
    assert.equal(res.is_error, true)
    assert.match(res.content, /TSLA/)
})

test('the timeframe is NOT fenced — the ladder is a hint, not a wall', async () => {
    // The old handler rejected any rung outside the entity's ±2 ladder window, which made
    // "NVDA weak INTRADAY" unverifiable on a swing setup.
    const { run } = runnerWith()
    const [res] = await run(use('get_chart', { ticker: 'NVDA', timeframe: '1min' }))
    assert.equal(res.is_error, undefined)
})

test('a symbol-less tool is always in scope', async () => {
    const { run } = runnerWith({ get_macro: async () => 'macro' })
    const [res] = await run(use('get_macro', {}))
    assert.equal(res.is_error, undefined)
})

test('an unknown tool answers an error rather than throwing away the wake', async () => {
    const { run } = runnerWith()
    const [res] = await run(use('get_vibes', { ticker: 'NVDA' }))
    assert.equal(res.is_error, true)
    assert.match(res.content, /unknown tool/)
})

test('server_tool_use blocks are left alone — Anthropic runs those', async () => {
    const { run } = runnerWith()
    const out = await run([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'FDA approval' } }])
    assert.deepEqual(out, [])
})

test('an image-returning handler keeps its content blocks intact', async () => {
    // get_chart answers [image, text]; stringifying it would throw the chart away.
    const blocks = [{ type: 'image', source: {} }, { type: 'text', text: 'NVDA 15min' }]
    const { run } = runnerWith({ get_chart: async () => blocks })
    const [res] = await run(use('get_chart', { ticker: 'NVDA' }))
    assert.deepEqual(res.content, blocks)
})

test('broken call accounting never breaks a read', async () => {
    const run = makeAssessToolRunner({
        symbols: ['NVDA'],
        onCall: () => { throw new Error('counter exploded') },
        handlers: { get_chart: async () => 'chart' },
    })
    const [res] = await run(use('get_chart', { ticker: 'NVDA' }))
    assert.equal(res.content, 'chart')
})
