import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatValidationOutcomes, formatOpportunityCards, formatShockFeed, formatTickerSignals } from '../../services/tools/aether.tools.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const _outcome = (overrides = {}) => ({
    prediction_id:        'pred1:energy_cost',
    channel_id:           'energy_cost',
    direction:            'up',
    confidence_llm:       0.80,
    validated_at:         '2026-09-01',
    created_at:           '2026-08-20',
    zscore_at_prediction: 1.2,
    zscore_at_validation: 2.1,
    direction_correct:    true,
    brier:                0.09,
    new_status:           'confirmed',
    ...overrides,
})

const _card = (overrides = {}) => ({
    card_id:          'pred1:energy_cost:XOM',
    prediction_id:    'pred1:energy_cost',
    ticker:           'XOM',
    channel_id:       'energy_cost',
    direction:        'up',
    ticker_direction: 'long',
    magnitude:        'medium',
    why:              'energy_cost confirmed ↑ UP (medium signal, brier=0.09): Oil cuts drive cost up. XOM: elasticity=+0.420 to energy_cost.',
    when:             'Lag 2–4w from FRED confirmation on 2026-09-01.',
    lag_weeks_min:    2,
    lag_weeks_max:    4,
    trade_type:       'swing',
    agent:            'mentor',
    risk_note:        'Short-lag signal (2–4w). Risk: market may have priced in the news already.',
    confidence_llm:   0.80,
    brier:            0.09,
    validated_at:     '2026-09-01',
    expires_at:       '2026-10-01',
    status:           'active',
    created_at:       '2026-09-01T12:00:00Z',
    ...overrides,
})

const _atlasCard = (overrides = {}) => _card({
    ticker:        'CVX',
    card_id:       'pred2:labor_cost:CVX',
    prediction_id: 'pred2:labor_cost',
    channel_id:    'labor_cost',
    lag_weeks_min: 6,
    lag_weeks_max: 8,
    trade_type:    'position',
    agent:         'atlas',
    ...overrides,
})

// ── formatValidationOutcomes ──────────────────────────────────────────────────

test('formatValidationOutcomes: null/empty → null', () => {
    assert.strictEqual(formatValidationOutcomes(null), null)
    assert.strictEqual(formatValidationOutcomes([]), null)
})

test('formatValidationOutcomes: confirmed outcome renders channel and direction', () => {
    const out = formatValidationOutcomes([_outcome()])
    assert.match(out, /energy_cost/)
    assert.match(out, /↑ UP/)
    assert.match(out, /conf=0\.80/)
    assert.match(out, /brier=0\.090/)
    assert.match(out, /2026-09-01/)
    assert.match(out, /✓/)
})

test('formatValidationOutcomes: rejected outcome shows ✗ icon', () => {
    const out = formatValidationOutcomes([_outcome({ new_status: 'rejected', direction_correct: false })])
    assert.match(out, /✗/)
})

test('formatValidationOutcomes: ↓ DOWN direction renders correctly', () => {
    const out = formatValidationOutcomes([_outcome({ direction: 'down' })])
    assert.match(out, /↓ DOWN/)
})

test('formatValidationOutcomes: → NEUTRAL direction renders correctly', () => {
    const out = formatValidationOutcomes([_outcome({ direction: 'neutral' })])
    assert.match(out, /→ NEUTRAL/)
})

test('formatValidationOutcomes: brier null renders without brier field', () => {
    const out = formatValidationOutcomes([_outcome({ brier: null })])
    assert.doesNotMatch(out, /brier=/)
})

test('formatValidationOutcomes: header counts confirmed and rejected correctly', () => {
    const docs = [
        _outcome({ channel_id: 'energy_cost' }),
        _outcome({ channel_id: 'credit_access', new_status: 'rejected' }),
        _outcome({ channel_id: 'labor_cost' }),
    ]
    const out = formatValidationOutcomes(docs)
    assert.match(out, /2 confirmed/)
    assert.match(out, /1 rejected/)
})

// ── formatOpportunityCards ────────────────────────────────────────────────────

test('formatOpportunityCards: null/empty → null', () => {
    assert.strictEqual(formatOpportunityCards(null), null)
    assert.strictEqual(formatOpportunityCards([]), null)
})

test('formatOpportunityCards: mentor card renders in swing section', () => {
    const out = formatOpportunityCards([_card()])
    assert.match(out, /SWING/)
    assert.match(out, /XOM/)
    assert.match(out, /long/)
    assert.match(out, /energy_cost/)
    assert.match(out, /lag=2–4w/)
    assert.match(out, /conf=0\.80/)
    assert.match(out, /brier=0\.090/)
    assert.match(out, /Oil cuts drive cost up/)
    assert.match(out, /Lag 2–4w from FRED confirmation/)
    assert.match(out, /Short-lag signal/)
})

test('formatOpportunityCards: atlas card renders in position section', () => {
    const out = formatOpportunityCards([_atlasCard()])
    assert.match(out, /POSITION/)
    assert.match(out, /CVX/)
    assert.match(out, /lag=6–8w/)
})

test('formatOpportunityCards: equal lag renders without dash', () => {
    const out = formatOpportunityCards([_card({ lag_weeks_min: 3, lag_weeks_max: 3 })])
    assert.match(out, /lag=3w/)
    assert.doesNotMatch(out, /lag=3–3w/)
})

test('formatOpportunityCards: mixed mentor and atlas — both sections present', () => {
    const out = formatOpportunityCards([_card(), _atlasCard()])
    assert.match(out, /SWING/)
    assert.match(out, /POSITION/)
    assert.match(out, /XOM/)
    assert.match(out, /CVX/)
    const header = out.split('\n')[0]
    assert.match(header, /2 active/)
    assert.match(header, /1 swing.*Mentor/)
    assert.match(header, /1 position.*Atlas/)
})

test('formatOpportunityCards: short direction renders correctly', () => {
    const out = formatOpportunityCards([_card({ ticker_direction: 'short', direction: 'down' })])
    assert.match(out, /short/)
})

// ── formatShockFeed ───────────────────────────────────────────────────────────

test('formatShockFeed: null outcomes and null cards → no-data messages', () => {
    const out = formatShockFeed(null, null)
    assert.match(out, /VALIDATION OUTCOMES: none yet/)
    assert.match(out, /OPPORTUNITY CARDS: none active/)
    assert.match(out, /get_name_exposure/)
})

test('formatShockFeed: real data renders both sections', () => {
    const out = formatShockFeed([_outcome()], [_card()])
    assert.match(out, /VALIDATION OUTCOMES/)
    assert.match(out, /energy_cost/)
    assert.match(out, /OPPORTUNITY CARDS/)
    assert.match(out, /XOM/)
    assert.match(out, /get_name_exposure/)
})

test('formatShockFeed: empty arrays → no-data messages (same as null)', () => {
    const out = formatShockFeed([], [])
    assert.match(out, /VALIDATION OUTCOMES: none yet/)
    assert.match(out, /OPPORTUNITY CARDS: none active/)
})

// ── Event cards (8-K sourced) ──────────────────────────────────────────────────
//
// Event cards land in the SAME aether_opportunities collection as macro cards but carry a
// different provenance: channel_id holds the filing item ("8-K:1.01") rather than a macro
// channel id, plus source_type/dimension/event_type that macro cards never have. The
// formatters used to render channel_id bare, so the agent saw an opaque code with nothing
// marking it as an idiosyncratic filing signal — while the frontend showed an EVENT badge.

const _eventCard = (overrides = {}) => ({
    ..._card(),
    card_id:      'event:0000100517-26-000045:YUM:revenue',
    ticker:       'YUM',
    channel_id:   '8-K:5.02',
    source_type:  'event',
    dimension:    'revenue',
    event_type:   '8-K:5.02',
    brier:        null,
    expires_at:   null,
    risk_note:    'Event-sourced signal — not FRED-validated.',
    ...overrides,
})

test('formatOpportunityCards: an event card is marked as event-sourced, not left bare', () => {
    const out = formatOpportunityCards([_eventCard()])
    assert.match(out, /8-K:5\.02/)
    assert.match(out, /revenue/, 'the dimension must reach the agent')
    assert.match(out, /EVENT cards are sourced from the company's own 8-K filing/)
})

test('formatOpportunityCards: the legend explains a missing brier means never, not pending', () => {
    const out = formatOpportunityCards([_eventCard()])
    assert.match(out, /never FRED-validated/)
    assert.match(out, /"never scored", not "pending"/)
})

test('formatOpportunityCards: the 8-K item number is decoded in the legend', () => {
    const out = formatOpportunityCards([_eventCard()])
    assert.match(out, /5\.02=officer\/director change/)
})

test('formatOpportunityCards: the header splits event-sourced from macro', () => {
    const out = formatOpportunityCards([_eventCard(), _card()])
    assert.match(out, /1 event-sourced, 1 macro/)
})

test('formatOpportunityCards: a pure macro feed carries no event legend or mix count', () => {
    const out = formatOpportunityCards([_card()])
    assert.ok(!out.includes('EVENT cards'), 'no legend when nothing is event-sourced')
    assert.ok(!out.includes('event-sourced,'), 'no mix count on a pure macro feed')
    assert.match(out, /energy_cost/, 'macro cards still render their channel id')
})

test('formatTickerSignals: event provenance survives the per-ticker view', () => {
    const out = formatTickerSignals('YUM', { opportunities: [_eventCard()], signals: [] })
    assert.match(out, /8-K:5\.02·revenue/)
    assert.match(out, /\[event\]/)
    assert.match(out, /EVENT cards are sourced/)
})

test('formatTickerSignals: a macro-only view is unchanged — no legend, no event tag', () => {
    const out = formatTickerSignals('XOM', { opportunities: [_card()], signals: [] })
    assert.ok(!out.includes('EVENT cards'))
    assert.match(out, /\[confirmed\]/)
    assert.match(out, /energy_cost/)
})
