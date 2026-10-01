import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSpans, spanIds, activeName, stageOf } from '../../services/mentorBuild.util.js'
import { normalizeChartLevels, MAX_CHART_LEVELS } from '../../services/chartRender/klineRender.provider.js'
import { mentorAgentService, emptyMentorState } from '../../services/agents/mentor.agent.service.js'

// The spans gate: the candidate trades, the ones that did not make it, and the lines drawn for them.

const span = (i) => ({
    id: `t${i}`, label: `way ${i}`, from: 'the shelf', to: 'the pool',
    from_price: 238.2, to_price: 246.5, why: 'swept twice', invalidation: 'close below 234.8',
    archetype: 'sweep_reclaim',
})

const turn = (raw, chatState = emptyMentorState()) => mentorAgentService.chatStream({
    messages: [{ role: 'user', content: 'hi' }],
    chatState,
    _run: async () => raw,
})

// ─── The candidates ───────────────────────────────────────────────────────────

test('a span keeps its words and its optional numbers', () => {
    const out = normalizeSpans({ candidates: [span(1)], discarded: [{ label: 'the gap', why_not: 'below my stop' }] })
    assert.deepEqual(out.candidates[0], {
        id: 't1', label: 'way 1', from: 'the shelf', to: 'the pool',
        from_price: 238.2, to_price: 246.5, why: 'swept twice', invalidation: 'close below 234.8',
        archetype: 'sweep_reclaim', recommended: false,
    })
    assert.deepEqual(out.discarded, [{ label: 'the gap', why_not: 'below my stop' }])
})

test('a span with no prices is legitimate — the lens decides what a place is', () => {
    const out = normalizeSpans({ candidates: [{ label: 'reclaim of the weekly VWAP', from: 'the weekly VWAP', to: 'the prior high' }] })
    assert.equal(out.candidates[0].from_price, null)
    assert.equal(out.candidates[0].to_price, null)
    assert.equal(out.candidates[0].id, 't1', 'an id is assigned when the model omits one')
})

test('FOUR candidates, hard — the cap is the server\'s, not the prompt\'s', () => {
    const out = normalizeSpans({ candidates: [1, 2, 3, 4, 5, 6].map(span) })
    assert.equal(out.candidates.length, 4)
    assert.deepEqual(spanIds(out), ['t1', 't2', 't3', 't4'])
})

test('a candidate missing the span itself is not a candidate', () => {
    const out = normalizeSpans({ candidates: [span(1), { label: 'vague', why: 'it feels right' }] })
    assert.equal(out.candidates.length, 1)
})

test('duplicate ids are separated rather than silently collapsed', () => {
    const out = normalizeSpans({ candidates: [span(1), { ...span(1), label: 'other' }] })
    assert.deepEqual(spanIds(out), ['t1', 't1x'])
})

test('an invented archetype is dropped, not invented into the taxonomy', () => {
    const out = normalizeSpans({ candidates: [{ ...span(1), archetype: 'the big squeeze' }] })
    assert.equal(out.candidates[0].archetype, null)
})

test('a discard with no reason is not shown — the clause IS the point', () => {
    const out = normalizeSpans({ candidates: [span(1)], discarded: [{ label: 'the gap' }] })
    assert.deepEqual(out.discarded, [])
})

test('junk in, null out', () => {
    assert.equal(normalizeSpans(null), null)
    assert.equal(normalizeSpans({ candidates: [] }), null)
    assert.equal(normalizeSpans('two ways in'), null)
})

// ─── Drawn levels ─────────────────────────────────────────────────────────────

test('a level is coloured by what it MEANS, and the stop is the one solid line', () => {
    const [from, to, stop, level] = normalizeChartLevels([
        { price: 238.2, kind: 'from', label: 'the shelf' },
        { price: 246.5, kind: 'to' },
        { price: 234.8, kind: 'stop' },
        { price: 250, kind: 'nonsense' },
    ])
    assert.equal(from.color, '#4c9aff')
    assert.equal(to.color, '#26a69a')
    assert.equal(stop.color, '#ef5350')
    assert.equal(level.kind, 'level', 'an unknown kind draws as plain structure')
    assert.equal(stop.dashed, false)
    assert.equal(from.dashed, true)
})

test('a price that is not a price is not a line', () => {
    assert.deepEqual(normalizeChartLevels([{ price: 0 }, { price: -5 }, { price: 'the shelf' }, {}]), [])
    assert.deepEqual(normalizeChartLevels(null), [])
})

test('the lines are capped — a chart with twenty is a ruler, not a trade', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ price: 100 + i, kind: 'level' }))
    assert.equal(normalizeChartLevels(many).length, MAX_CHART_LEVELS)
})

// ─── Through the desk ─────────────────────────────────────────────────────────

// A spans turn always knows its ticker: the <asset> tag sets it on the first turn and the client
// sends it back on every one after. Without a name there is nothing to hang a candidate on.
const AT_NVDA = { active_asset: 'NVDA', draft: null, coverage: [] }

test('the <spans> block rides home on the draft and claims its ids', async () => {
    const out = await turn(`<spans>${JSON.stringify({ candidates: [span(1), span(2)] })}</spans>`, AT_NVDA)
    assert.deepEqual(spanIds(out.setup.spans), ['t1', 't2'])
    assert.deepEqual(activeName(out.build).claimed.spans.value, ['t1', 't2'])
    assert.equal(stageOf(activeName(out.build)), 'opening', 'claiming spans does not skip the opening')
})

test('a later turn that emits no spans keeps the ones on the table', async () => {
    const first  = await turn(`<spans>${JSON.stringify({ candidates: [span(1)] })}</spans>`, AT_NVDA)
    const second = await turn('The first one, then.', { active_asset: 'NVDA', draft: first.setup, coverage: [] })
    assert.deepEqual(spanIds(second.setup.spans), ['t1'])
})

test('the block never reaches the user as text', async () => {
    const out = await turn(`Two ways in.\n<spans>${JSON.stringify({ candidates: [span(1)] })}</spans>`, AT_NVDA)
    assert.equal(out.reply, 'Two ways in.')
})

test('spans with no ticker anywhere are simply not carried — nothing to attach them to', async () => {
    const out = await turn(`<spans>${JSON.stringify({ candidates: [span(1)] })}</spans>`)
    assert.equal(out.setup, undefined)
})

test('a spans block where nothing survives leaves the table as it was', async () => {
    const first  = await turn(`<spans>${JSON.stringify({ candidates: [span(1)] })}</spans>`, AT_NVDA)
    const junk   = await turn('<spans>{"candidates":[{"label":"vague"}]}</spans>',
        { active_asset: 'NVDA', draft: first.setup, coverage: [] })
    assert.deepEqual(spanIds(junk.setup.spans), ['t1'], 'an empty gate is worse than a stale one')
})

// ─── The rejects are authored once, at the gate ───────────────────────────────

import { alternativesFromSpans } from '../../services/mentorBuild.util.js'

test('the discarded spans BECOME the alternatives on the setup — one judgment, one place', () => {
    const out = normalizeSpans({
        candidates: [span(1)],
        discarded: [
            { label: 'the gap fill at 231.8', why_not: 'it sits below my invalidation', archetype: 'gap_fill' },
            { label: 'the breakout', why_not: 'worse fill, no tighter stop' },
        ],
    })
    assert.deepEqual(alternativesFromSpans(out), [
        { archetype: 'gap_fill', label: 'the gap fill at 231.8', why_not: 'it sits below my invalidation' },
        { label: 'the breakout', why_not: 'worse fill, no tighter stop' },
    ])
})

test('a reject with no reason is not one — the reason IS the content', () => {
    const out = normalizeSpans({ candidates: [span(1)], discarded: [{ label: 'the gap' }] })
    assert.deepEqual(alternativesFromSpans(out), [])
    assert.deepEqual(alternativesFromSpans(null), [])
})

test('the rejects reach the worksheet without the model writing them twice', async () => {
    const out = await turn(`<spans>${JSON.stringify({
        candidates: [span(1)],
        discarded: [{ label: 'the gap fill', why_not: 'below my invalidation', archetype: 'gap_fill' }],
    })}</spans>`, AT_NVDA)
    assert.equal(out.setup.alternatives.length, 1)
    assert.equal(out.setup.alternatives[0].why_not, 'below my invalidation')
})
