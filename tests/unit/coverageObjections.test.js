import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _buildSystemPrompt } from '../../services/agents/analyst.agent.service.js'

// Making the plausibility flags BITE. They already rode into update mode on the stored doc — as two
// unlabelled objects inside a 60-line JSON dump, which is the same as not showing them at all. The
// proof: the re-model that read a flagged 30x bear leg moved it FURTHER out (TSLA, 42 → 36, widening
// the band to 11.7x). So they come out of the dump and get named as standing objections.

const text = chatState => _buildSystemPrompt(chatState).map(b => b.text).join('\n')

const FLAGS = [
    { code: 'band_contradicts_conviction', leg: null, detail: 'The bear/bull band spans 36–420 — a 11.7x spread — while conviction is `high`.' },
    { code: 'multiple_outside_history', leg: 'bear', detail: 'The bear leg applies a 30x multiple — BELOW the entire range this name has traded at.' },
]
const DOC = { symbol: 'TSLA', rating: 'sell', price_target: { value: 210 }, flags: FLAGS }

test('the flags are named as unanswered objections, not left in the JSON', () => {
    const out = text({ existing_coverage: DOC, active_symbol: 'TSLA' })
    assert.match(out, /STANDING OBJECTIONS/)
    assert.match(out, /UNANSWERED/)
    for (const f of FLAGS) assert.ok(out.includes(f.detail), `objection missing: ${f.code}`)
    // The leg is labelled, so a per-leg objection is attributable to the leg it is about.
    assert.match(out, /\[bear leg\] The bear leg applies a 30x/)
})

test('the raw flags array is stripped from the dump — said once, in the framing that asks for an answer', () => {
    const out = text({ existing_coverage: DOC, active_symbol: 'TSLA' })
    assert.doesNotMatch(out, /"flags"/)
    assert.doesNotMatch(out, /band_contradicts_conviction/)   // the CODE is machine vocabulary, not prose
    // ...and the rest of the thesis still reaches the agent intact.
    assert.match(out, /"symbol": "TSLA"/)
    assert.match(out, /"rating": "sell"/)
})

test('a clean thesis raises no objections block at all', () => {
    const out = text({ existing_coverage: { symbol: 'MSFT', rating: 'buy', flags: [] }, active_symbol: 'MSFT' })
    assert.doesNotMatch(out, /STANDING OBJECTIONS/)
    assert.match(out, /EXISTING COVERAGE/)
})

test('a doc predating the flags (no field at all) is handled like a clean one', () => {
    const out = text({ existing_coverage: { symbol: 'MSFT', rating: 'buy' }, active_symbol: 'MSFT' })
    assert.doesNotMatch(out, /STANDING OBJECTIONS/)
    assert.match(out, /"symbol": "MSFT"/)
})

test('malformed flags are dropped rather than rendered as empty bullets', () => {
    const out = text({ existing_coverage: { symbol: 'X', flags: [null, {}, { code: 'x' }, { detail: '   ' }] } })
    assert.doesNotMatch(out, /STANDING OBJECTIONS/)
})

test('fresh research (no existing coverage) is untouched by any of this', () => {
    const out = text({ active_symbol: 'NVDA' })
    assert.doesNotMatch(out, /EXISTING COVERAGE/)
    assert.doesNotMatch(out, /STANDING OBJECTIONS/)
    assert.match(out, /Active name: NVDA/)
})
