import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    normalizeChartRequest, makeChartRequestCapture, makeChartChatPipe, stripChartBlock,
    runAgentStream, CHART_INSTRUCTION, CHART_TIMEFRAMES,
} from '../../services/agentIO.js'
import { buildTagCaptures, createTagSuppressor } from '../../services/llmStream.util.js'
import { parseChartInterval } from '../../services/candleInterval.util.js'

// The chart-in-chat protocol: every agent shows the user a chart with the same <chart> tag, and the
// row reaches its chat on the same `chart` event get_chart already uses. The point of the shared pipe
// is that a new agent costs a single argument (onChart) — these tests pin what that argument buys it:
// the instruction, the capture, the row, the strip.
//
// A chart the USER asked for goes out as `{ symbol, timeframe, live: true }` and the client mounts
// its own interactive chart. Nothing is rendered here: the tag closes and the row is already gone.
// (get_chart's `show_to_user` PNG is the other half of the same event — see marketData.tools.js.)

// ─── normalizeChartRequest ────────────────────────────────────────────────────

test('canonical spellings pass through untouched', () => {
    for (const tf of CHART_TIMEFRAMES) {
        assert.deepEqual(normalizeChartRequest({ ticker: 'NVDA', timeframe: tf }), { ticker: 'NVDA', timeframe: tf })
    }
})

test('every timeframe we can ask for is one /api/market/candles can serve', () => {
    // The live chart fetches its OWN candles from that endpoint, so this pair is now load-bearing:
    // a timeframe this module emits but parseChartInterval rejects is a 400 and an empty chart frame
    // — with nothing in the reply to suggest anything went wrong.
    for (const tf of CHART_TIMEFRAMES) {
        assert.ok(parseChartInterval(tf), `${tf} must resolve to a bar spec`)
    }
})

test('the spellings models actually emit are mapped onto the canonical set', () => {
    // The client's PriceChart PERIOD_MAP knows these too, but normalizing here keeps the chart row's
    // caption ("NVDA · 1HR") from reading back whatever dialect the model chose.
    const cases = { '1h': '1hr', '1H': '1hr', '4h': '4hr', '1d': 'day', 'D': 'day', '1w': 'week', '60': '1hr', '15m': '15min' }
    for (const [given, want] of Object.entries(cases)) {
        assert.equal(normalizeChartRequest({ ticker: 'X', timeframe: given }).timeframe, want, given)
    }
})

test('an unknown or missing timeframe falls back to day rather than failing the request', () => {
    // "give SPY" names no timeframe at all — the daily is the answer, not an error.
    assert.equal(normalizeChartRequest({ ticker: 'SPY' }).timeframe, 'day')
    assert.equal(normalizeChartRequest({ ticker: 'AAPL', timeframe: 'fortnight' }).timeframe, 'day')
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

// ─── makeChartRequestCapture ──────────────────────────────────────────────────

test('a valid block fires the callback mid-stream and is remembered', () => {
    const seen = []
    const c = makeChartRequestCapture(r => seen.push(r))
    c.capture('{"ticker":"aapl","timeframe":"1h"}')
    assert.deepEqual(seen, [{ ticker: 'AAPL', timeframe: '1hr' }])
    assert.deepEqual(c.get(), { ticker: 'AAPL', timeframe: '1hr' })
})

test('a malformed block is dropped without throwing — the reply still lands', () => {
    const seen = []
    const c = makeChartRequestCapture(r => seen.push(r))
    assert.doesNotThrow(() => c.capture('{"ticker": '))
    assert.doesNotThrow(() => c.capture('not json'))
    assert.doesNotThrow(() => c.capture('{"timeframe":"1hr"}'))   // no ticker
    assert.deepEqual(seen, [])
    assert.equal(c.get(), null)
})

test('the LAST valid request wins when a model emits two', () => {
    const c = makeChartRequestCapture()
    c.capture('{"ticker":"AAPL","timeframe":"day"}')
    c.capture('{"ticker":"NVDA","timeframe":"1hr"}')
    assert.deepEqual(c.get(), { ticker: 'NVDA', timeframe: '1hr' })
})

test('works with no callback (non-streaming callers just read .get())', () => {
    const c = makeChartRequestCapture()
    assert.doesNotThrow(() => c.capture('{"ticker":"SPY"}'))
    assert.deepEqual(c.get(), { ticker: 'SPY', timeframe: 'day' })
})

// ─── stripChartBlock ──────────────────────────────────────────────────────────

test('the block is stripped from the reply, including a multi-line emit', () => {
    assert.equal(stripChartBlock("Here's NVDA. <chart>{\"ticker\":\"NVDA\"}</chart>").trim(), "Here's NVDA.")
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

// Fire the <chart> capture the way the tag suppressor does when the block closes.
function fireChart(args, payload) {
    args.tagCaptures.find(t => t.open === '<chart>').onCapture(payload)
}

test('onChart buys an agent the instruction, the capture, the live row and the strip', async () => {
    let got = null
    const streamFn = async (args) => {
        got = args
        fireChart(args, '{"ticker":"nvda","timeframe":"4h"}')
        return 'Here is NVDA. <chart>{"ticker":"nvda","timeframe":"4h"}</chart>'
    }
    const rows = []
    const raw = await runAgentStream({
        log: '[t]', messages: [], systemPrompt: [{ type: 'text', text: 'base' }],
        tagCaptures: buildTagCaptures({}), onChart: r => rows.push(r),
        _resolve: fakeResolve(streamFn),
    })

    // `live` is the contract with the client: mount the real interactive chart, don't wait for a PNG.
    assert.deepEqual(rows, [{ symbol: 'NVDA', timeframe: '4hr', live: true }], 'the row reaches the chat')
    assert.equal(raw.trim(), 'Here is NVDA.', 'no agent has to add <chart> to its own strip list')
    assert.equal(got.systemPrompt.length, 2)
    assert.equal(got.systemPrompt[0].text, 'base', 'the cached prefix is untouched')
    assert.equal(got.systemPrompt[1].text, CHART_INSTRUCTION)
})

test('no image is rendered for a chart the user asked for — nothing to wait on', async () => {
    // The point of the live row: the reply used to sit for 1–12s behind a headless-Chromium render
    // before `done`. The row now goes out the instant the tag closes, mid-stream.
    const rows = []
    await runAgentStream({
        systemPrompt: 'sys', tagCaptures: buildTagCaptures({}), onChart: r => rows.push(r),
        _resolve: fakeResolve(async (args) => {
            fireChart(args, '{"ticker":"SPY"}')
            assert.equal(rows.length, 1, 'emitted synchronously, before the stream even ended')
            return 'ok'
        }),
    })
    assert.equal(rows[0].imageBase64, undefined, 'no PNG on the wire')
})

// A streamFn that behaves like the real provider: it builds the tag suppressor out of the
// tagCaptures it was handed and pushes the reply through it in small chunks. Nothing here fires a
// capture by hand — if the wiring between runAgentStream and the suppressor is wrong, no row appears.
function streamingProvider(reply, chunkSize = 7) {
    return async ({ tagCaptures, onToken }) => {
        const suppressor = createTagSuppressor({ onToken, captures: tagCaptures })
        for (let i = 0; i < reply.length; i += chunkSize) suppressor.push(reply.slice(i, i + chunkSize))
        suppressor.flush()
        return reply
    }
}

test('a real chunked stream drives the whole pipe: tag → capture → row → clean text', async () => {
    // The end-to-end shape of "give spy", with the tag split across chunks the way tokens arrive.
    const rows = []
    const shown = []
    const raw = await runAgentStream({
        systemPrompt: 'sys', tagCaptures: buildTagCaptures({}),
        onChart: r => rows.push(r), onToken: t => shown.push(t),
        _resolve: fakeResolve(streamingProvider('Here\'s SPY on the daily. <chart>{"ticker":"SPY","timeframe":"day"}</chart>')),
    })

    assert.deepEqual(rows, [{ symbol: 'SPY', timeframe: 'day', live: true }])
    assert.equal(shown.join(''), "Here's SPY on the daily. ", 'the tag never reaches the user as text')
    assert.equal(raw.trim(), "Here's SPY on the daily.")
})

test('a bare ticker with no timeframe asks for the daily', async () => {
    const rows = []
    await runAgentStream({
        systemPrompt: 'sys', tagCaptures: buildTagCaptures({}), onChart: r => rows.push(r),
        _resolve: fakeResolve(async (args) => { fireChart(args, '{"ticker":"spy"}'); return 'ok' }),
    })
    assert.deepEqual(rows, [{ symbol: 'SPY', timeframe: 'day', live: true }])
})

test('a repeated identical request emits once — two identical charts read as a bug', async () => {
    const rows = []
    await runAgentStream({
        systemPrompt: 'sys', tagCaptures: buildTagCaptures({}), onChart: r => rows.push(r),
        _resolve: fakeResolve(async (args) => {
            fireChart(args, '{"ticker":"SPY","timeframe":"day"}')
            fireChart(args, '{"ticker":"SPY","timeframe":"day"}')
            fireChart(args, '{"ticker":"SPY","timeframe":"1hr"}')   // a different view still counts
            return 'ok'
        }),
    })
    assert.deepEqual(rows.map(r => r.timeframe), ['day', '1hr'])
})

test('an onChart that throws is contained — the reply still lands', async () => {
    const raw = await runAgentStream({
        systemPrompt: 'sys', tagCaptures: buildTagCaptures({}),
        onChart: () => { throw new Error('client gone') },
        _resolve: fakeResolve(async (args) => { fireChart(args, '{"ticker":"SPY"}'); return 'ok' }),
    })
    assert.equal(raw, 'ok')
})

test('a string system prompt gets the instruction appended too', async () => {
    let got = null
    const raw = await runAgentStream({
        systemPrompt: 'sys', tagCaptures: buildTagCaptures({}), onChart: () => {},
        _resolve: fakeResolve(async (args) => { got = args; return 'ok' }),
    })
    assert.equal(raw, 'ok')
    assert.ok(got.systemPrompt.startsWith('sys'))
    assert.ok(got.systemPrompt.includes(CHART_INSTRUCTION))
})

// ─── the pipe outside runAgentStream (Axl's reception) ────────────────────────

test('the reception gets the identical pipe — the row, and the request for its done payload', () => {
    // The reception hand-rolls its stream (it also captures <route>), so it is the one caller that
    // can drift. It shipped once sending its request to the workspace panel instead of showing it,
    // and the user saw a chart appear in a column away from the sentence that answered them.
    const rows = []
    const pipe = makeChartChatPipe(r => rows.push(r))

    pipe.capture('{"ticker":"spy"}')

    assert.deepEqual(rows, [{ symbol: 'SPY', timeframe: 'day', live: true }])
    assert.deepEqual(pipe.get(), { ticker: 'SPY', timeframe: 'day' }, 'the request still reports a chart was asked for')
})

test('a plain routing turn emits nothing at all', () => {
    const rows = []
    const pipe = makeChartChatPipe(r => rows.push(r))
    assert.deepEqual(rows, [])
    assert.equal(pipe.get(), null)
})

test('an agent that does NOT pass onChart is left exactly as it was', async () => {
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
