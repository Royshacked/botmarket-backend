// A news signal now stands for a whole day's coverage of one channel, not one article.
//
// Before consolidation, sixteen energy stories produced sixteen DAL/energy_cost signals
// pointing both ways, and the only thing collapsing them was a supersession bug in which
// the batch ate itself. Now one signal carries the netted view — which means the card has
// to say what it stands for, or an agent reading conf=0.55 cannot tell a lone confident
// article from thirteen that nearly cancelled out. Those are different position sizes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatConsensus, formatTickerSignals } from '../../services/tools/aether.tools.js'

const signal = (over = {}) => ({
    ticker: 'DAL', channel_id: 'energy_cost', ticker_direction: 'short',
    direction: 'up', magnitude: 'large', lag_weeks_min: 1, lag_weeks_max: 2,
    confidence_llm: 0.55, why: 'Iran escalation', when: '1–2w',
    contributing_count: 13, agreement: 0.42, ...over,
})

test('a single-article signal claims no consensus', () => {
    assert.equal(formatConsensus(signal({ contributing_count: 1, agreement: 1 })), null)
})

test('a legacy signal with no consensus fields renders nothing', () => {
    // Signals written before consolidation carry neither field; they must not print
    // "undefined articles" into an agent's context.
    assert.equal(formatConsensus({ ticker: 'DAL' }), null)
})

test('a consolidated signal reports both how many articles and how divided they were', () => {
    assert.equal(formatConsensus(signal()), '13 articles, 42% net agreement')
})

test('a unanimous batch reads as 100%', () => {
    assert.equal(formatConsensus(signal({ contributing_count: 4, agreement: 1 })), '4 articles, 100% net agreement')
})

test('a missing agreement still reports the article count', () => {
    assert.equal(formatConsensus(signal({ agreement: undefined })), '13 articles')
})

test('the basis line reaches the rendered signal block', () => {
    const out = formatTickerSignals('DAL', { signals: [signal()] })
    assert.match(out, /Basis: 13 articles, 42% net agreement/)
})

test('a single-article signal adds no basis line', () => {
    const out = formatTickerSignals('DAL', { signals: [signal({ contributing_count: 1 })] })
    assert.ok(!out.includes('Basis:'), 'should not print a basis for one article')
})
