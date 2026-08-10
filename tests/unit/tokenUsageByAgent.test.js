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
import { calcCost, ceilingFor, overCeiling } from '../../services/tokenUsage.service.js'
import { resolveAgentStream } from '../../services/agentUtils.js'
import { bookAssessUsage } from '../../monitoring/assess.shared.js'

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

test('a user turn is booked exactly once, however many tool rounds follow', async () => {
    // The whole point of the second counter: if it ever rode along with onUsage it would equal
    // `turns`, the ratio would be a constant 1, and the measurement would silently say nothing.
    const calls = []
    const { onUsage } = await resolveAgentStream(undefined, 'u1', 'analystAgent',
        async (...a) => { calls.push(a); return null }, async () => null)

    onUsage?.({ input_tokens: 10 })   // tool round 1
    onUsage?.({ input_tokens: 10 })   // tool round 2
    onUsage?.({ input_tokens: 10 })   // tool round 3

    assert.equal(calls.length, 1, 'one resolve = one user turn, regardless of rounds')
    assert.deepEqual(calls[0], ['u1', 'analystAgent'])
})

test('an anonymous run books no turn, and is never degraded', async () => {
    // Headless/scheduled work (the coverage refresh, the market brief) has no reader. Booking a
    // turn for it would inflate the denominator and make every desk look artificially efficient —
    // and there is no account whose ceiling it could be measured against.
    const calls = []
    const { onUsage, degraded } = await resolveAgentStream(undefined, null, 'analystAgent',
        async (...a) => { calls.push(a); return null }, async () => 0.01)
    assert.equal(degraded, false, 'no user, no ceiling, no degrade')

    assert.equal(calls.length, 0)
    assert.equal(onUsage, undefined, 'no userId means no usage recorder either — the two agree')
})

test('a failed turn write never reaches the caller', async () => {
    // Accounting is best-effort on purpose: a Mongo hiccup must never take down a user's reply, and
    // an unreadable ceiling must read as "no ceiling" rather than as a degrade.
    const out = await resolveAgentStream(undefined, 'u1', 'analystAgent',
        async () => { throw new Error('mongo down') },
        async () => { throw new Error('mongo down') })
    assert.ok(out.streamFn, 'the turn still runs')
    assert.equal(out.degraded, false, 'a failed read never degrades the user')
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

// ─── The spend ceiling ────────────────────────────────────────────────────────
// DEGRADE, not refuse: past the line the chat keeps working on the cheap model. A hard block reads
// as an outage, and this is a cost control rather than a safety one.

test('no ceiling configured means no ceiling — the default, deliberately', () => {
    // TOKEN_DEGRADE_USD is unset by default because the DISPLAY budget is a placeholder nobody
    // ratified. Enforcing a number no one chose would quietly re-model every user.
    assert.equal(ceilingFor({}, null), null)
    assert.equal(overCeiling(9999, null), false, 'no ceiling can never be exceeded')
})

test("a user's own budget overrides the configured one, in both directions", () => {
    assert.equal(ceilingFor({ budgetUsd: 100 }, 20), 100)
    assert.equal(ceilingFor({ budgetUsd: 5 },  20), 5)
})

test('an exempt account has no ceiling, whatever else is set', () => {
    // The escape hatch is a field on the account, NOT `isAdmin` — auth.middleware force-sets that
    // to false on every request by design, so reading it would silently revive a disabled flag.
    assert.equal(ceilingFor({ exemptFromBudget: true, budgetUsd: 5 }, 20), null)
})

test('a zero or junk override reads as unlimited, never as "blocked at $0"', () => {
    // A 0 that meant "no spend allowed" would brick an account on a typo.
    assert.equal(ceilingFor({ budgetUsd: 0 }, 20), null)
    assert.equal(ceilingFor({ budgetUsd: 'lots' }, 20), 20, 'unparseable falls back to configured')
    assert.equal(ceilingFor(null, 20), 20, 'no user doc at all → configured')
})

test('the line is crossed AT the ceiling, not past it', () => {
    assert.equal(overCeiling(19.99, 20), false)
    assert.equal(overCeiling(20, 20), true)
    assert.equal(overCeiling(undefined, 20), false, 'no spend recorded yet is not over')
})

test('an over-ceiling user is moved to the cheap model, not cut off', () => {
    const spent = { totalCost: 25 }
    assert.equal(overCeiling(spent.totalCost, ceilingFor({}, 20)), true)
    assert.equal(overCeiling(spent.totalCost, ceilingFor({ exemptFromBudget: true }, 20)), false)
})

test('past the ceiling the turn runs on the cheap model instead of failing', () => {
    // End to end through the seam: the same call that books the turn reads the month's spend back,
    // so the check costs no extra round trip.
    return resolveAgentStream('claude-opus-5', 'u1', 'kairosAgent',
        async () => ({ totalCost: 25 }), async () => 20,
    ).then(out => {
        assert.equal(out.degraded, true)
        assert.equal(out.model, 'claude-haiku-4-5-20251001', 'routed to the cheap model')
        assert.ok(out.streamFn, 'and still runs — degrade, not refuse')
    })
})

test('under the ceiling the requested model is honoured untouched', async () => {
    const out = await resolveAgentStream('claude-opus-5', 'u1', 'kairosAgent',
        async () => ({ totalCost: 4 }), async () => 20)
    assert.equal(out.degraded, false)
    assert.equal(out.model, 'claude-opus-5')
})

test('an exempt account keeps its model however much it has spent', async () => {
    const out = await resolveAgentStream('claude-opus-5', 'u1', 'kairosAgent',
        async () => ({ totalCost: 9999 }), async () => null)   // null ceiling = exempt/unset
    assert.equal(out.degraded, false)
    assert.equal(out.model, 'claude-opus-5')
})

// ─── Monitor spend ────────────────────────────────────────────────────────────
// The ceiling shipped counting CHAT only: resolveAgentStream was the sole recorder and the
// assessments call the provider directly. That left the half which scales with users — and which
// in-position management just added a call per open position to — invisible.

test('a monitor wake books against the entity owner', async () => {
    const calls = []
    bookAssessUsage('u1', 'claude-sonnet-4-6', { input_tokens: 100 }, 'talosAssess', async (...a) => { calls.push(a) })
    assert.deepEqual(calls[0]?.slice(0, 2), ['u1', 'claude-sonnet-4-6'])
    assert.equal(calls[0]?.[3], 'talosAssess', 'its own row — monitor spend is not blended into the desk chat')
})

test('an ownerless or usage-less call books nothing', async () => {
    // A wake with no owner has no account to charge, and a failed call has nothing to count.
    const calls = []
    bookAssessUsage(null, 'm', { input_tokens: 1 }, 'talosAssess', async (...a) => { calls.push(a) })
    bookAssessUsage('u1', 'm', null, 'talosAssess', async (...a) => { calls.push(a) })
    assert.equal(calls.length, 0)
})

test('a failed booking never reaches the wake', () => {
    // Accounting must never take down a monitor: the position it is watching is real.
    assert.doesNotThrow(() =>
        bookAssessUsage('u1', 'm', { input_tokens: 1 }, 'talosAssess', async () => { throw new Error('mongo down') }))
})
