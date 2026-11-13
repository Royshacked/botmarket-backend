import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeChartHandler } from '../../services/tools/marketData.tools.js'
import { CHART_SOURCE } from '../../services/chartImgCache.service.js'

// get_chart tells the LLM WHERE the image came from. The own render is drawn from the same candles
// the user's chart pane shows; the chart-img fallback is TradingView's data and drawing. Labelling
// every image "TradingView" (the old hard-coded text) misattributed the source whenever the own
// renderer served it.
async function label(source) {
    const handler = makeChartHandler({
        log: '[test]',
        readText: 'Read it.',
        renderChart: async () => ({ png: 'AAAA', source }),
    })
    const res = await handler({ ticker: 'aapl', timeframe: 'day', indicators: '' })
    const text = res.find(b => b.type === 'text').text
    assert.equal(res.find(b => b.type === 'image').source.data, 'AAAA')
    return text
}

test('own render is labelled as the app chart, not TradingView', async () => {
    const text = await label(CHART_SOURCE.OWN)
    assert.match(text, /^AAPL day chart \(app render/)
    assert.doesNotMatch(text, /TradingView/)
})

test('chart-img fallback is still labelled TradingView', async () => {
    const text = await label(CHART_SOURCE.CHART_IMG)
    assert.match(text, /^AAPL day TradingView chart/)
})

test('show_to_user opens a LIVE chart with the lines the agent drew, regardless of source (2026-11-13: the chat draws no PNG)', async () => {
    const seen = []
    const handler = makeChartHandler({
        log: '[test]', readText: '',
        onChart: e => seen.push(e),
        renderChart: async () => ({ png: 'BBBB', source: CHART_SOURCE.OWN }),
    })
    await handler({ ticker: 'TSLA', timeframe: '1hr', show_to_user: true })
    assert.deepEqual(seen, [{ symbol: 'TSLA', timeframe: '1hr', live: true }])
    seen.length = 0
    await handler({ ticker: 'NVDA', timeframe: 'day', show_to_user: true, levels: [{ price: 151.49, label: 'swing low Nov 12' }, { price: 148.8, label: 'swept to', kind: 'stop' }] })
    assert.deepEqual(seen, [{ symbol: 'NVDA', timeframe: 'day', live: true, levels: [{ kind: 'level', price: 151.49, label: 'swing low Nov 12' }, { kind: 'stop', price: 148.8, label: 'swept to' }] }])
})
