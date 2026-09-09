import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatActiveShockPredictions } from '../../services/tools/aether.tools.js'

// Minimal valid prediction doc (matches ChannelPrediction.to_mongo() shape)
const _pred = (overrides = {}) => ({
    prediction_id:  'news1:energy_cost',
    news_id:        'news1',
    channel_id:     'energy_cost',
    direction:      'up',
    magnitude:      'medium',
    lag_weeks_min:  2,
    lag_weeks_max:  4,
    confidence_llm: 0.80,
    reasoning:      'Oil supply cut drives energy cost up',
    expires_at:     '2026-09-15',
    created_at:     '2026-09-01T10:00:00Z',
    status:         'provisional',
    ...overrides,
})

test('formatActiveShockPredictions: null/empty → no-signal message', () => {
    const out = formatActiveShockPredictions(null)
    assert.match(out, /no active signals/)

    const out2 = formatActiveShockPredictions([])
    assert.match(out2, /no active signals/)
})

test('formatActiveShockPredictions: single signal renders channel and direction', () => {
    const out = formatActiveShockPredictions([_pred()])
    assert.match(out, /energy_cost/)
    assert.match(out, /↑ UP/)
    assert.match(out, /medium/)
    assert.match(out, /conf=0\.80/)
    assert.match(out, /lag 2–4w/)
    assert.match(out, /expires 2026-09-15/)
    assert.match(out, /Oil supply cut drives energy cost up/)
})

test('formatActiveShockPredictions: down direction renders arrow correctly', () => {
    const out = formatActiveShockPredictions([_pred({ direction: 'down', channel_id: 'credit_access' })])
    assert.match(out, /↓ DOWN/)
})

test('formatActiveShockPredictions: neutral direction renders arrow correctly', () => {
    const out = formatActiveShockPredictions([_pred({ direction: 'neutral', channel_id: 'risk_premium' })])
    assert.match(out, /→ NEUTRAL/)
})

test('formatActiveShockPredictions: equal lag renders without dash', () => {
    const out = formatActiveShockPredictions([_pred({ lag_weeks_min: 3, lag_weeks_max: 3 })])
    assert.match(out, /lag 3w/)
    assert.doesNotMatch(out, /lag 3–3w/)
})

test('formatActiveShockPredictions: multiple signals on same channel — highest confidence shown as top', () => {
    const docs = [
        _pred({ news_id: 'news1', confidence_llm: 0.60, reasoning: 'low confidence signal' }),
        _pred({ news_id: 'news2', confidence_llm: 0.90, reasoning: 'high confidence signal' }),
    ]
    const out = formatActiveShockPredictions(docs)
    // Should show the high confidence reasoning
    assert.match(out, /high confidence signal/)
    // Should aggregate count N=2
    assert.match(out, /N=2/)
    // Should list total signal count
    assert.match(out, /2 provisional signals/)
})

test('formatActiveShockPredictions: two different channels — both appear', () => {
    const docs = [
        _pred({ channel_id: 'energy_cost', confidence_llm: 0.80, reasoning: 'energy reason' }),
        _pred({ channel_id: 'credit_access', confidence_llm: 0.70, reasoning: 'credit reason', direction: 'down' }),
    ]
    const out = formatActiveShockPredictions(docs)
    assert.match(out, /energy_cost/)
    assert.match(out, /credit_access/)
    assert.match(out, /energy reason/)
    assert.match(out, /credit reason/)
})

test('formatActiveShockPredictions: channels sorted by highest confidence first', () => {
    const docs = [
        _pred({ channel_id: 'fiscal_impulse', confidence_llm: 0.50, reasoning: 'fiscal' }),
        _pred({ channel_id: 'energy_cost',    confidence_llm: 0.90, reasoning: 'energy' }),
    ]
    const out = formatActiveShockPredictions(docs)
    // energy_cost (conf=0.90) should appear before fiscal_impulse (conf=0.50)
    const posEnergy = out.indexOf('energy_cost')
    const posFiscal = out.indexOf('fiscal_impulse')
    assert.ok(posEnergy < posFiscal, 'higher-confidence channel should appear first')
})

test('formatActiveShockPredictions: includes cross-reference hint', () => {
    const out = formatActiveShockPredictions([_pred()])
    assert.match(out, /get_name_exposure/)
})

test('formatActiveShockPredictions: no expires_at renders without expires line', () => {
    const out = formatActiveShockPredictions([_pred({ expires_at: null })])
    assert.doesNotMatch(out, /expires/)
})

test('formatActiveShockPredictions: summary counts are correct', () => {
    const docs = [
        _pred({ channel_id: 'energy_cost', news_id: 'n1' }),
        _pred({ channel_id: 'energy_cost', news_id: 'n2' }),
        _pred({ channel_id: 'credit_access', news_id: 'n3' }),
    ]
    const out = formatActiveShockPredictions(docs)
    assert.match(out, /3 provisional signals/)
    assert.match(out, /2 channels/)
})
