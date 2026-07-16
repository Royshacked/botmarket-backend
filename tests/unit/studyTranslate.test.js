import { test } from 'node:test'
import assert from 'node:assert/strict'
import { studiesToIndicators, translateStudy } from '../../services/chartRender/studyTranslate.js'
import { buildStudies } from '../../monitoring/evaluators/chart.evaluator.js'

// The own-chart renderer draws the SAME overlays chart-img did. studyTranslate maps _buildStudies'
// TradingView study objects → klinecharts indicator descriptors. These lock the name/param mapping
// + the overlay-vs-pane split (moving averages/bands/vwap overlay the candle pane; rsi/macd/atr/vol
// get their own pane) so a rename downstream can't silently drop an indicator.

test('EMA / SMA / BOLL / VWAP are overlays; RSI / MACD / ATR / VOL are panes', () => {
    assert.deepEqual(translateStudy({ name: 'Moving Average Exponential', input: { in_0: 20 } }),
        { name: 'EMA', calcParams: [20], overlay: true, custom: false })
    assert.deepEqual(translateStudy({ name: 'Moving Average', input: { in_0: 50 } }),
        { name: 'MA', calcParams: [50], overlay: true, custom: false })
    assert.deepEqual(translateStudy({ name: 'Bollinger Bands', input: { in_0: 20, in_1: 2 } }),
        { name: 'BOLL', calcParams: [20, 2], overlay: true, custom: false })
    assert.deepEqual(translateStudy({ name: 'VWAP' }),
        { name: 'VWAP', calcParams: [], overlay: true, custom: true })
    assert.deepEqual(translateStudy({ name: 'Relative Strength Index', input: { in_0: 14 } }),
        { name: 'RSI', calcParams: [14], overlay: false, custom: false })
    assert.deepEqual(translateStudy({ name: 'MACD', input: { in_0: 12, in_1: 26, in_2: 9 } }),
        { name: 'MACD', calcParams: [12, 26, 9], overlay: false, custom: false })
    assert.deepEqual(translateStudy({ name: 'Average True Range', input: { in_0: 14 } }),
        { name: 'ATR', calcParams: [14], overlay: false, custom: true })
    assert.deepEqual(translateStudy({ name: 'Volume' }),
        { name: 'VOL', calcParams: [], overlay: false, custom: false })
})

test('ATR and VWAP are flagged custom (not klinecharts built-ins)', () => {
    assert.equal(translateStudy({ name: 'VWAP' }).custom, true)
    assert.equal(translateStudy({ name: 'Average True Range' }).custom, true)
    assert.equal(translateStudy({ name: 'EMA is built-in?', input: {} }), null)  // unknown → dropped
})

test('missing inputs fall back to sane defaults', () => {
    assert.deepEqual(translateStudy({ name: 'Moving Average Exponential' }).calcParams, [20])
    assert.deepEqual(translateStudy({ name: 'Relative Strength Index' }).calcParams, [14])
    assert.deepEqual(translateStudy({ name: 'Bollinger Bands' }).calcParams, [20, 2])
})

test('unmapped / malformed studies are dropped silently', () => {
    assert.equal(translateStudy(null), null)
    assert.equal(translateStudy({}), null)
    assert.equal(translateStudy({ name: 'Ichimoku Cloud' }), null)
    const { overlays, panes } = studiesToIndicators([{ name: 'Ichimoku Cloud' }, null, { name: 'VWAP' }])
    assert.equal(overlays.length, 1)
    assert.equal(panes.length, 0)
})

test('studiesToIndicators splits overlays vs panes', () => {
    const { overlays, panes } = studiesToIndicators([
        { name: 'Moving Average Exponential', input: { in_0: 20 } },
        { name: 'Relative Strength Index', input: { in_0: 14 } },
        { name: 'Volume' },
    ])
    assert.deepEqual(overlays.map(o => o.name), ['EMA'])
    assert.deepEqual(panes.map(p => p.name), ['RSI', 'VOL'])
})

test('non-array input yields empty result (no throw)', () => {
    assert.deepEqual(studiesToIndicators(undefined), { overlays: [], panes: [] })
    assert.deepEqual(studiesToIndicators('nope'), { overlays: [], panes: [] })
})

// End-to-end with the REAL _buildStudies parser: a free-text indicator string an agent might pass
// to get_chart must translate to drawable descriptors, proving the two layers stay in sync.
test('round-trips real _buildStudies output', () => {
    const studies = buildStudies('ema(20), rsi(14), volume', { fillDefaults: false })
    const { overlays, panes } = studiesToIndicators(studies)
    assert.deepEqual(overlays.map(o => o.name), ['EMA'])
    assert.deepEqual(panes.map(p => p.name).sort(), ['RSI', 'VOL'])
})
