// The per-turn VISION budget — the backstop under "never run it across the pool".
//
// get_chart, get_orderblocks and get_false_breaks each render a chart and then spend a Claude vision
// call on the image. They are the only tools in the kit that bill per use, and nothing counted them:
// web_search has its own max_uses, the render pool bounds concurrency, MAX_PARALLEL_TOOLS bounds what
// is in flight. None of those bound the COUNT, so the discipline was a prompt line, and a scan working
// a twenty-name shortlist could spend twenty vision calls with nothing to stop it or say so after.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeVisionBudget, VISION_BUDGET_SPENT } from '../../services/llmStream.util.js'
import { isToolError, toolErrorText } from '../../services/toolResult.util.js'
import { makeStructureVisionHandler } from '../../services/tools/priceStructure.tools.js'

// ── the budget itself ─────────────────────────────────────────────────────────

test('it hands out exactly its ceiling and then refuses, without throwing', () => {
    const b = makeVisionBudget(3)
    assert.deepEqual([b.take(), b.take(), b.take()], [true, true, true])
    assert.equal(b.take(), false)
    assert.equal(b.take(), false, 'still false, and still not a throw')
    assert.equal(b.used, 3, 'a refused claim does not count against the budget twice')
    assert.equal(b.max, 3)
})

test('a nonsense ceiling still allows one call rather than none', () => {
    for (const bad of [0, -5, NaN, undefined, null]) {
        const b = makeVisionBudget(bad)
        assert.equal(b.take(), true, `ceiling ${bad} refused everything`)
        assert.equal(b.take(), false)
    }
})

// ── the handler that claims from it ───────────────────────────────────────────

const VISION = { system: 'S', question: () => 'Q' }
/** A structure handler whose render and vision call are stubs, so only the gating is under test. */
function handler(counter) {
    return makeStructureVisionHandler({
        log: '[test]', kind: 'orderblocks', vision: VISION, onChart: null,
        deps: {
            renderChart:  async () => { counter.renders++; return 'PNG' },
            claudeVision: async () => { counter.visions++; return 'zones: 100-102' },
        },
    })
}

test('inside the budget the read happens', async () => {
    const c = { renders: 0, visions: 0 }
    const out = await handler(c)({ ticker: 'NVDA', timeframe: '1d' }, { visionBudget: makeVisionBudget(2) })
    assert.match(String(out), /zones: 100-102/)
    assert.deepEqual([c.renders, c.visions], [1, 1])
})

// THE POINT: refused BEFORE the render, so a refusal costs nothing at all — not a Chromium page and
// not a vision call.
test('past the budget nothing is rendered and no vision call is spent', async () => {
    const c = { renders: 0, visions: 0 }
    const h = handler(c)
    const budget = makeVisionBudget(1)
    await h({ ticker: 'NVDA', timeframe: '1d' }, { visionBudget: budget })
    const out = await h({ ticker: 'AMD', timeframe: '1d' }, { visionBudget: budget })

    assert.deepEqual([c.renders, c.visions], [1, 1], 'the second call spent nothing')
    assert.ok(isToolError(out), 'a refusal must be an ERROR, not a string')
    assert.match(toolErrorText(out), /budget of 1 chart\/vision reads is spent/)
    // …and it points at the cheap tools, so a refused turn has somewhere to go.
    assert.match(toolErrorText(out), /get_candles/)
})

// A toolError matters for more than tone: services/scanner.grounding credits a ticker as `validated`
// when a per-name tool SUCCEEDS on it. A refusal returned as a plain string would ground a name
// against a read that never happened.
test('the refusal is a toolError, so it cannot ground a name it never read', async () => {
    const budget = makeVisionBudget(1)
    const h = handler({ renders: 0, visions: 0 })
    await h({ ticker: 'NVDA', timeframe: '1d' }, { visionBudget: budget })
    const out = await h({ ticker: 'GHOST', timeframe: '1d' }, { visionBudget: budget })
    assert.ok(isToolError(out))
})

test('no budget on the ctx → no gating, so non-desk callers (Talos, tests) are untouched', async () => {
    const c = { renders: 0, visions: 0 }
    const h = handler(c)
    for (let i = 0; i < 5; i++) await h({ ticker: 'NVDA', timeframe: '1d' }, { onUsage: null })
    assert.deepEqual([c.renders, c.visions], [5, 5])
})

test('the refusal text names the tool that was refused and the ceiling', () => {
    const msg = VISION_BUDGET_SPENT('get_false_breaks', 8)
    assert.match(msg, /^get_false_breaks refused/)
    assert.match(msg, /budget of 8/)
})
