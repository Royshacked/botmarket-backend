// Per-AGENT spend attribution.
//   node --test tests/unit/tokenUsageByAgent.test.js
//
// WHY THIS DIMENSION EXISTS. The month totals already showed that caching pays — Aug 2026 ran
// ~3.7 cache reads per write — but they also showed a QUARTER of all prompt tokens arriving
// uncached, at full price, and said nothing about where. That distinction is the whole question:
// an uncached first turn is unavoidable, while a desk whose volatile system tail sits AHEAD of the
// history breakpoint re-reads its own conversation at full price on every turn, forever. The two
// are the same number in a monthly total and different problems entirely, so the fix has to be
// aimed with a per-desk count rather than with a guess about which desk is worst.
//
// The attribution is taken from the agent's LOG TAG, which every agent already passes to
// runAgentStream — so it costs zero edits at the eight call sites and a NEW agent is counted the
// moment it exists. That is also the risk this file covers: a tag is a display string, and it ends
// up inside a Mongo field PATH.

import test from 'node:test'
import assert from 'node:assert/strict'

import { agentKeyFromLog } from '../../services/agentIO.js'
import { calcCost } from '../../services/tokenUsage.service.js'
import { resolveAgentStream } from '../../services/agentUtils.js'

// ─── the log tag → field key ──────────────────────────────────────────────────

test('an ordinary agent tag becomes its bare name', () => {
    assert.equal(agentKeyFromLog('[analystAgent]'), 'analystAgent')
    assert.equal(agentKeyFromLog('[kairos]'), 'kairos')
    assert.equal(agentKeyFromLog('[marketBrief]'), 'marketBrief')
})

test('a dot can never reach the field path', () => {
    // Field paths are dot-delimited: a tag containing one would silently nest a subdocument
    // instead of naming a counter, and the desk's spend would land somewhere nobody reads.
    assert.equal(agentKeyFromLog('[foo.bar]'), 'foo_bar')
    assert.doesNotMatch(agentKeyFromLog('[a.b.c]'), /\./)
})

test('a `$` can never reach the field path either', () => {
    // Mongo reads a leading `$` as an operator — the whole update would be rejected, taking the
    // month totals down with it, not just this one desk's row.
    assert.doesNotMatch(agentKeyFromLog('[$set]'), /\$/)
})

test('an unusable tag books to `unknown` rather than vanishing', () => {
    // Spend is never dropped because a caller's tag was odd — an unattributed desk is precisely
    // the thing this dimension exists to end, so it must show up as a row you can go and explain.
    assert.equal(agentKeyFromLog(''), 'unknown')
    assert.equal(agentKeyFromLog('[]'), 'unknown')
    assert.equal(agentKeyFromLog(null), 'unknown')
    assert.equal(agentKeyFromLog(undefined), 'unknown')
})

test('the key is stable across tags that differ only in spacing or brackets', () => {
    // The same desk must not split into two rows because a tag was written slightly differently.
    assert.equal(agentKeyFromLog('  [axlAgent]  '), 'axlAgent')
    assert.equal(agentKeyFromLog('axlAgent'), 'axlAgent')
})

// ─── the cost model the rows are summed with ──────────────────────────────────

test('a cached read is an order of magnitude cheaper than the same tokens uncached', () => {
    // The 0.1x / 1.25x multipliers are the reason the per-agent split is worth having at all: the
    // same prompt costs ~12x more on a miss than a hit, so WHERE the misses are is the finding.
    const n = 1_000_000
    const uncached = calcCost('claude-sonnet-4-6', { input_tokens: n })
    const cached   = calcCost('claude-sonnet-4-6', { cache_read_input_tokens: n })
    const written  = calcCost('claude-sonnet-4-6', { cache_creation_input_tokens: n })

    assert.equal(uncached, 3)
    assert.equal(cached, 0.3)
    assert.equal(written, 3.75)
    assert.ok(cached * 10 <= uncached, 'a cache read must be ≥10x cheaper than an uncached read')
    assert.ok(written > uncached, 'a cache WRITE carries a premium over an uncached read')
})

test('an unpriced model falls back rather than costing nothing', () => {
    // A silent zero would make a new model look free and quietly under-report every total that
    // includes it — worse than an approximate number, because nothing looks wrong.
    const cost = calcCost('some-unreleased-model', { input_tokens: 1_000_000 })
    assert.ok(cost > 0, 'an unknown model must still be costed')
})

// ─── turns (API calls) vs userTurns (people talking) ──────────────────────────
// `onUsage` fires once per API call and a tool loop makes many per turn, so `turns` alone cannot
// separate a wordy desk from a tool-heavy one — and those want opposite fixes. `userTurns` is the
// denominator that makes the ratio readable, so what matters is that it counts turns and NOT rounds.

test('a user turn is booked exactly once, however many tool rounds follow', () => {
    // The whole point of the second counter: if it ever rode along with onUsage it would equal
    // `turns`, the ratio would be a constant 1, and the measurement would silently say nothing.
    const calls = []
    const { onUsage } = resolveAgentStream(undefined, 'u1', 'analystAgent', async (...a) => { calls.push(a) })

    onUsage?.({ input_tokens: 10 })   // tool round 1
    onUsage?.({ input_tokens: 10 })   // tool round 2
    onUsage?.({ input_tokens: 10 })   // tool round 3

    assert.equal(calls.length, 1, 'one resolve = one user turn, regardless of rounds')
    assert.deepEqual(calls[0], ['u1', 'analystAgent'])
})

test('an anonymous run books no turn', () => {
    // Headless/scheduled work (the coverage refresh, the market brief) has no reader. Booking a
    // turn for it would inflate the denominator and make every desk look artificially efficient.
    const calls = []
    const { onUsage } = resolveAgentStream(undefined, null, 'analystAgent', async (...a) => { calls.push(a) })

    assert.equal(calls.length, 0)
    assert.equal(onUsage, undefined, 'no userId means no usage recorder either — the two agree')
})

test('a failed turn write never reaches the caller', () => {
    // Accounting is fire-and-forget on purpose: a Mongo hiccup must never take down a user's reply.
    // An unhandled rejection here would surface as a crash far from this line.
    assert.doesNotThrow(() =>
        resolveAgentStream(undefined, 'u1', 'analystAgent', async () => { throw new Error('mongo down') }))
})

test('a usage payload missing the cache fields costs the same as explicit zeros', () => {
    // Not every provider returns them; a missing field must not become NaN and poison `totalCost`
    // for the whole month via $inc.
    const bare = calcCost('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 100 })
    const full = calcCost('claude-sonnet-4-6', {
        input_tokens: 1000, output_tokens: 100,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    })
    assert.equal(bare, full)
    assert.ok(Number.isFinite(bare))
})
