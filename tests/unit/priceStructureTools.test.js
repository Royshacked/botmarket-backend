import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStructureVisionHandler, OB_VISION, FB_VISION } from '../../services/priceStructure.tools.js'

// The order-block / false-break tools render a PLAIN chart and run a focused vision pass,
// returning a structured, citable read. Deps are injected so these tests hit neither the
// chart-img API nor the vision model.

const fakeVision = { system: 'SYS', question: (s, tf) => `Q for ${s} ${tf}` }

function build(overrides = {}) {
    const calls = { fetch: [], vision: [], onChart: [] }
    const handler = makeStructureVisionHandler({
        log: '[test]',
        kind: overrides.kind ?? 'orderblocks',
        vision: overrides.vision ?? fakeVision,
        onChart: overrides.onChart ?? (p => calls.onChart.push(p)),
        deps: {
            renderChart:  async (sym, tf, studies) => { calls.fetch.push({ sym, tf, studies }); return 'PNGBYTES' },
            claudeVision: async (sys, q, png, opts) => { calls.vision.push({ sys, q, png, opts }); return '  OB1: bullish 247–248, fresh  ' },
        },
    })
    return { handler, calls }
}

// ── renders a PLAIN chart (no overlays) ──────────────────────────────────
test('structure handler renders a plain chart — empty studies array', async () => {
    const { handler, calls } = build()
    await handler({ ticker: 'aapl', timeframe: '15min' })
    assert.equal(calls.fetch.length, 1)
    assert.deepEqual(calls.fetch[0].studies, [])          // no indicators drawn
    assert.equal(calls.fetch[0].sym, 'AAPL')              // upper-cased
    assert.equal(calls.fetch[0].tf, '15min')
})

// ── passes the vision config + a larger token budget, returns the read ───
test('structure handler runs vision with the config + trimmed text + caveat', async () => {
    const { handler, calls } = build()
    const out = await handler({ ticker: 'AAPL', timeframe: '1hr' })
    assert.equal(calls.vision[0].sys, 'SYS')
    assert.equal(calls.vision[0].q, 'Q for AAPL 1hr')
    assert.equal(calls.vision[0].png, 'PNGBYTES')
    assert.equal(calls.vision[0].opts.maxTokens, 1024)    // richer than the YES/NO default
    assert.match(out, /OB1: bullish 247–248, fresh/)      // vision text, trimmed
    assert.match(out, /APPROXIMATE — confirm exact prices with get_candles/)
})

// ── show_to_user gates the chart surfacing ───────────────────────────────
test('structure handler surfaces the chart only when show_to_user is true', async () => {
    const on = build()
    await on.handler({ ticker: 'AAPL', timeframe: 'day', show_to_user: true })
    assert.equal(on.calls.onChart.length, 1)
    assert.equal(on.calls.onChart[0].imageBase64, 'PNGBYTES')

    const off = build()
    await off.handler({ ticker: 'AAPL', timeframe: 'day' })
    assert.equal(off.calls.onChart.length, 0)
})

// ── error path returns a tool error, never throws ────────────────────────
test('structure handler returns a tool error when the chart render fails', async () => {
    const handler = makeStructureVisionHandler({
        log: '[test]', kind: 'false_breaks', vision: fakeVision, onChart: null,
        deps: { renderChart: async () => { throw new Error('chart-img 500') } },
    })
    const out = await handler({ ticker: 'AAPL', timeframe: '5min' })
    const text = typeof out === 'string' ? out : JSON.stringify(out)
    assert.match(text, /Could not analyze false breaks for AAPL/)
})

// ── the exported vision configs are well-formed ──────────────────────────
test('OB / FB vision configs carry a system + a question that names ticker & timeframe', () => {
    for (const cfg of [OB_VISION, FB_VISION]) {
        assert.equal(typeof cfg.system, 'string')
        assert.ok(cfg.system.length > 40)
        const q = cfg.question('NVDA', '4hr')
        assert.match(q, /NVDA/)
        assert.match(q, /4hr/)
    }
})
