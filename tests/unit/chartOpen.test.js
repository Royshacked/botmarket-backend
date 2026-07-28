import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    normalizeChartRequest, makeChartOpenCapture, stripChartBlock,
    runAgentStream, CHART_OPEN_INSTRUCTION, CHART_TIMEFRAMES,
} from '../../services/agentIO.js'
import { buildTagCaptures } from '../../services/llmStream.util.js'

// The chart-open protocol: every agent opens the user's ONE live chart with the same <chart> tag.
// The point of the shared pipe is that a new agent costs a single argument (onOpenChart) — these
// tests pin the three things that argument buys it: the instruction, the capture, the strip.

// ─── normalizeChartRequest ────────────────────────────────────────────────────

test('canonical spellings pass through untouched', () => {
    for (const tf of CHART_TIMEFRAMES) {
        assert.deepEqual(normalizeChartRequest({ ticker: 'NVDA', timeframe: tf }), { ticker: 'NVDA', timeframe: tf })
    }
})

test('the spellings models actually emit are mapped onto the canonical set', () => {
    // The client's PriceChart PERIOD_MAP knows these too, but normalizing here keeps the panel
    // header ("NVDA · 1HR") from reading back whatever dialect the model chose.
    const cases = { '1h': '1hr', '1H': '1hr', '4h': '4hr', '1d': 'day', 'D': 'day', '1w': 'week', '60': '1hr', '15m': '15min' }
    for (const [given, want] of Object.entries(cases)) {
        assert.equal(normalizeChartRequest({ ticker: 'X', timeframe: given }).timeframe, want, given)
    }
})

test('an unknown or missing timeframe falls back to day rather than failing the request', () => {
    // The user asked to SEE the chart; the wrong resolution is one click away, no chart is a dead end.
    assert.equal(normalizeChartRequest({ ticker: 'AAPL', timeframe: 'fortnight' }).timeframe, 'day')
    assert.equal(normalizeChartRequest({ ticker: 'AAPL' }).timeframe, 'day')
    assert.equal(normalizeChartRequest({ ticker: 'AAPL', timeframe: null }).timeframe, 'day')
})

test('the ticker is upper-cased and $-prefixed symbols are accepted', () => {
    assert.equal(normalizeChartRequest({ ticker: ' nvda ' }).ticker, 'NVDA')
    assert.equal(normalizeChartRequest({ ticker: '$tsla' }).ticker, 'TSLA')
    assert.equal(normalizeChartRequest({ ticker: 'BRK.B' }).ticker, 'BRK.B')
    assert.equal(normalizeChartRequest({ ticker: 'btc-usd' }).ticker, 'BTC-USD')
})

test('no usable ticker → null, never a chart of nothing', () => {
    for (const bad of [null, undefined, {}, { ticker: '' }, { ticker: '   ' }, { ticker: 'a name with spaces' }, { ticker: '<script>' }]) {
        assert.equal(normalizeChartRequest(bad), null, JSON.stringify(bad))
    }
})

// ─── makeChartOpenCapture ─────────────────────────────────────────────────────

test('a valid block fires the callback mid-stream and is remembered', () => {
    const seen = []
    const c = makeChartOpenCapture(r => seen.push(r))
    c.capture('{"ticker":"aapl","timeframe":"1h"}')
    assert.deepEqual(seen, [{ ticker: 'AAPL', timeframe: '1hr' }])
    assert.deepEqual(c.get(), { ticker: 'AAPL', timeframe: '1hr' })
})

test('a malformed block is dropped without throwing — the reply still lands', () => {
    const seen = []
    const c = makeChartOpenCapture(r => seen.push(r))
    assert.doesNotThrow(() => c.capture('{"ticker": '))
    assert.doesNotThrow(() => c.capture('not json'))
    assert.doesNotThrow(() => c.capture('{"timeframe":"1hr"}'))   // no ticker
    assert.deepEqual(seen, [])
    assert.equal(c.get(), null)
})

test('the LAST valid request wins when a model emits two', () => {
    const c = makeChartOpenCapture()
    c.capture('{"ticker":"AAPL","timeframe":"day"}')
    c.capture('{"ticker":"NVDA","timeframe":"1hr"}')
    assert.deepEqual(c.get(), { ticker: 'NVDA', timeframe: '1hr' })
})

test('works with no callback (non-streaming callers just read .get())', () => {
    const c = makeChartOpenCapture()
    assert.doesNotThrow(() => c.capture('{"ticker":"SPY"}'))
    assert.deepEqual(c.get(), { ticker: 'SPY', timeframe: 'day' })
})

// ─── stripChartBlock ──────────────────────────────────────────────────────────

test('the block is stripped from the reply, including a multi-line emit', () => {
    assert.equal(stripChartBlock('Opening NVDA. <chart>{"ticker":"NVDA"}</chart>').trim(), 'Opening NVDA.')
    assert.equal(stripChartBlock('a <chart>\n{\n"ticker":"X"\n}\n</chart> b'), 'a  b')
})

test('a reply with no chart block is unchanged, and null/undefined never throw', () => {
    assert.equal(stripChartBlock('just prose'), 'just prose')
    assert.equal(stripChartBlock(null), '')
    assert.equal(stripChartBlock(undefined), '')
})

// ─── runAgentStream wiring ────────────────────────────────────────────────────

function fakeResolve(streamFn) {
    return () => ({ model: 'm', streamFn, provider: 'p', onUsage: undefined })
}

test('onOpenChart buys an agent the instruction, the capture and the strip — all three', async () => {
    let got = null
    const streamFn = async (args) => {
        got = args
        // Fire the capture the way the tag suppressor would when the block closes.
        args.tagCaptures.find(t => t.open === '<chart>').onCapture('{"ticker":"nvda","timeframe":"4h"}')
        return 'Opening NVDA. <chart>{"ticker":"nvda","timeframe":"4h"}</chart>'
    }
    const opened = []
    const raw = await runAgentStream({
        log: '[t]', messages: [], systemPrompt: [{ type: 'text', text: 'base' }],
        tagCaptures: buildTagCaptures({}), onOpenChart: r => opened.push(r),
        _resolve: fakeResolve(streamFn),
    })

    assert.deepEqual(opened, [{ ticker: 'NVDA', timeframe: '4hr' }], 'the chart opens mid-stream')
    assert.equal(raw.trim(), 'Opening NVDA.', 'no agent has to add <chart> to its own strip list')
    assert.equal(got.systemPrompt.length, 2)
    assert.equal(got.systemPrompt[0].text, 'base', 'the cached prefix is untouched')
    assert.equal(got.systemPrompt[1].text, CHART_OPEN_INSTRUCTION)
})

test('a string system prompt gets the instruction appended too', async () => {
    let got = null
    const raw = await runAgentStream({
        systemPrompt: 'sys', tagCaptures: buildTagCaptures({}), onOpenChart: () => {},
        _resolve: fakeResolve(async (args) => { got = args; return 'ok' }),
    })
    assert.equal(raw, 'ok')
    assert.ok(got.systemPrompt.startsWith('sys'))
    assert.ok(got.systemPrompt.includes(CHART_OPEN_INSTRUCTION))
})

test('an agent that does NOT pass onOpenChart is left exactly as it was', async () => {
    // Charts are opt-in; wiring one agent must not change another's prompt, tags or raw reply.
    let got = null
    const raw = await runAgentStream({
        systemPrompt: 'sys', tagCaptures: buildTagCaptures({}),
        _resolve: fakeResolve(async (args) => { got = args; return 'a <chart>{"ticker":"X"}</chart> b' }),
    })
    assert.equal(got.systemPrompt, 'sys')
    assert.equal(got.tagCaptures.find(t => t.open === '<chart>').onCapture, null)
    assert.equal(raw, 'a <chart>{"ticker":"X"}</chart> b')
})
