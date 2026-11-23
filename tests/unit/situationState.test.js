import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stateSchema, statePrompt, shapeAnswer, buildState, _setIO, WRITTEN, MAX_QUESTIONS } from '../../services/situation/state.js'

const articles = [
    { url: 'https://a/1', title: 'Fed holds rates', source: 'Reuters', published_at: '2025-01-29T19:00:00Z', text: '' },
    { url: 'https://a/2', title: 'Tariffs signed on Canada, Mexico, China', source: 'AP', published_at: '2025-02-01T22:00:00Z', text: '' },
]
const q = (over = {}) => ({ question: 'How broad are the tariffs by end of Q1?', tree: 'tariffs_trade', options: [{ key: 'threats', label: 'Threats' }, { key: 'broad', label: 'Broad' }], impact: 'high', uncertainty: 'high', why: 'x', ...over })

test('the schema asks for every written section and the questions, strictly', () => {
    const s = stateSchema()
    assert.deepEqual(s.required, [...WRITTEN, 'questions'])
    assert.equal(s.additionalProperties, false)
    assert.equal(s.properties.questions.items.additionalProperties, false)
})

test('the prompt carries the as-of date, the code sections with sources, the gaps and numbered articles', () => {
    const p = statePrompt('2025-02-04', { regime: [{ as_of: '2025-01-31', text: '10-year 4.5%', source: 'FRED DGS10' }] }, articles, ['FMP BTCUSD: 402'])
    assert.match(p, /AS-OF DATE: 2025-02-04/)
    assert.match(p, /- 2025-01-31: 10-year 4.5% \[FRED DGS10\]/)
    assert.match(p, /MISSING FROM THE DATA .*BTCUSD/)
    assert.match(p, /\[2\] 2025-02-01 · AP · Tariffs signed/)
    assert.match(p, /PRICES \(code, facts\):\n- \(none\)/)
})

test('shapeAnswer: a cited item takes its sources; an uncited reading is the model\'s; an uncited FACT is dropped', () => {
    const r = shapeAnswer({
        policy: [{ text: 'The Fed held at 4.25–4.50%.', as_of: '2025-01-29', cites: [1], tag: 'fact' }, { text: 'Unsourced claim', as_of: '2025-01-29', cites: [], tag: 'fact' }],
        regime: [{ text: 'Inflation is stuck near 3%.', as_of: 'soon', cites: [], tag: 'reading' }],
        money: [], stories: [{ text: 'late', as_of: '2025-03-01', cites: [2], tag: 'reading' }], calendar: [], questions: [],
    }, '2025-02-04', articles)
    assert.equal(r.sections.policy.length, 1)
    assert.match(r.sections.policy[0].source, /^Reuters, 2025-01-29: Fed holds rates/)
    assert.equal(r.sections.regime[0].source, "the model's reading of the data sections")
    assert.equal(r.sections.regime[0].as_of, '2025-02-04', 'a bad date falls back to the state date')
    assert.equal(r.sections.stories[0].as_of, '2025-02-04', 'a future date is clamped')
    assert.equal(r.dropped.items, 1)
})

test('shapeAnswer: questions keep 2–4 options with distinct snake keys and known levels; the rest are dropped', () => {
    const r = shapeAnswer({ ...Object.fromEntries(WRITTEN.map(s => [s, []])), questions: [
        q(), q({ options: [{ key: 'Imposed, then paused', label: 'Imposed then paused' }, { key: 'all_at_once', label: 'All at once' }], tree: 'Tariffs & trade' }),
        q({ options: [{ key: 'a', label: 'A' }] }), q({ options: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }] }), q({ impact: 'huge' }),
    ] }, '2025-02-04', articles)
    assert.equal(r.questions.length, 2)
    assert.equal(r.questions[1].options[0].key, 'imposed_then_paused')
    assert.equal(r.questions[1].tree, 'tariffs_trade')
    assert.equal(r.dropped.questions, 3)
    const many = shapeAnswer({ questions: Array.from({ length: MAX_QUESTIONS + 3 }, () => q()) }, '2025-02-04', articles)
    assert.equal(many.questions.length, MAX_QUESTIONS)
})

test('buildState: data + news + one call → a checked state with the code sections first, the cost measured and booked', async () => {
    const booked = []
    let asked = null
    _setIO({
        data: async () => ({ sections: { regime: [{ text: '10-year 4.5%', value: 4.5, as_of: '2025-01-31', source: 'FRED DGS10', tag: 'fact' }], prices: [], money: [], calendar: [] }, numbers: { x: 1 }, gaps: ['g1'] }),
        news: async () => ({ articles, gaps: ['g2'] }),
        payer: async () => 'roy',
        record: async (p, m, u) => { booked.push([p, m, u.output_tokens]) },
        system: () => 'SYSTEM',
        call: async (args) => {
            asked = args
            args.onUsage({ input_tokens: 10000, output_tokens: 2000 }, 'claude-opus-5-5')
            return { model: 'claude-opus-5-5', data: { regime: [{ text: 'Stuck inflation', as_of: '2025-02-04', cites: [], tag: 'reading' }], policy: [{ text: 'Tariffs signed', as_of: '2025-02-01', cites: [2], tag: 'fact' }], money: [], stories: [], calendar: [], questions: [q()] } }
        },
    })
    const r = await buildState('2025-02-04')
    assert.equal(r.ok, true)
    assert.equal(asked.systemPrompt, 'SYSTEM')
    assert.deepEqual(r.state.sections.regime.map(i => i.tag), ['fact', 'reading'], "the code's facts, then the model's readings")
    assert.equal(r.state.articles.length, 2, 'the articles are stored on the state')
    assert.deepEqual(r.gaps, ['g1', 'g2'])
    assert.equal(r.questions.length, 1)
    assert.ok(Math.abs(r.cost_usd - (10000 * 4 + 2000 * 20) / 1e6) < 1e-9)
    assert.deepEqual(booked, [['roy', 'claude-opus-5-5', 2000]])
})

test('buildState: a failed or empty call is a clear failure with the gaps, never a throw', async () => {
    _setIO({ call: async () => { throw new Error('overloaded') } })
    const r = await buildState('2025-02-04')
    assert.equal(r.ok, false)
    assert.match(r.reason, /overloaded/)
    _setIO({ call: async () => ({ data: null, stopReason: 'max_tokens' }) })
    assert.match((await buildState('2025-02-04')).reason, /max_tokens/)
})
