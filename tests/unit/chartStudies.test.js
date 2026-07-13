import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStudies } from '../../monitoring/evaluators/chart.evaluator.js'

// buildStudies drives what indicators get drawn on a rendered chart. The Kairos/Idea
// get_chart tools and the Hermes monitor now pass { fillDefaults: false } so a chart is
// PLAIN unless the caller explicitly names overlays — this keeps a price-action read from
// being primed toward moving averages / VWAP. Lock that contract.

const names = studies => studies.map(s => s.name)

// ── plain-by-default (fillDefaults: false) ───────────────────────────────
test('buildStudies: no indicators + fillDefaults:false → bare chart (no studies)', () => {
    assert.deepEqual(buildStudies('', { fillDefaults: false }), [])
})

test('buildStudies: fillDefaults:false draws ONLY the named overlay', () => {
    const studies = buildStudies('vwap', { fillDefaults: false })
    assert.deepEqual(names(studies), ['VWAP'])
})

test('buildStudies: fillDefaults:false with an explicit EMA draws just that EMA, no EMA20 fill', () => {
    const studies = buildStudies('ema(50)', { fillDefaults: false })
    const emas = studies.filter(s => s.name === 'Moving Average Exponential')
    assert.equal(emas.length, 1)
    assert.equal(emas[0].input.in_0, 50)
})

// ── legacy default (fillDefaults omitted → true) still tops off with EMA20/50 ──
test('buildStudies: default (fill on) tops a bare request off with EMA20/50', () => {
    const studies = buildStudies('')
    const periods = studies
        .filter(s => s.name === 'Moving Average Exponential')
        .map(s => s.input.in_0)
        .sort((a, b) => a - b)
    assert.deepEqual(periods, [20, 50])
})
