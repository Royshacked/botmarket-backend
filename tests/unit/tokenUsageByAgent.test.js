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
import { calcCost, ceilingFor, overCeiling, chatSpend, searchesIn, WEB_SEARCH_USD } from '../../services/tokenUsage.service.js'
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

// ─── The ceiling does not read monitor spend ────────────────────────────────────
//
// The ceiling degrades a user's CHAT to the cheap model. Monitor spend is not chat: it is the
// mechanical cost of watching positions they already opened, it arrives on a clock they do not
// control, and it is deliberately never blocked (monitors bypass resolveAgentStream and call the
// provider directly, so an over-ceiling user still has their live position managed).
//
// That exemption used to come for free, because monitor spend was not recorded at all —
// resolveAgentStream's comment said so. bookAssessUsage then started booking it into the same
// `totalCost` the ceiling reads, and the stated design inverted in silence: a trader with several
// armed setups reached the cheap chat model faster than one with none, for spending nothing extra
// on chat. This is the check that the exemption is now a mechanism rather than an accident.

test('chatSpend subtracts what the monitors spent', () => {
    assert.equal(chatSpend({ totalCost: 20, monitorCost: 8 }), 12)
})

// Every document written before the fix has no `monitorCost`, so a historical month must compare
// exactly as it did — no migration, no month reset, no user suddenly un-degraded by accident.
test('chatSpend reads a document with no monitorCost as all-chat', () => {
    assert.equal(chatSpend({ totalCost: 20 }), 20)
    assert.equal(chatSpend({}), 0)
    assert.equal(chatSpend(null), 0)
})

// Never negative. A rounding drift or a double-booked monitor row must not produce a NEGATIVE chat
// spend, which would read as credit and hold a genuinely over-ceiling user under the line forever.
test('chatSpend floors at zero', () => {
    assert.equal(chatSpend({ totalCost: 3, monitorCost: 5 }), 0)
})

// The whole point, stated as the case that was wrong: a user at the ceiling ONLY because their
// monitors ran is not over it.
test('monitors alone cannot degrade a user\u2019s chat', () => {
    const doc = { totalCost: 25, monitorCost: 15 }   // $10 of chat, $15 of watching
    assert.equal(overCeiling(chatSpend(doc), 20), false)
    assert.equal(overCeiling(doc.totalCost, 20), true, 'the total WOULD have been over — that was the bug')
})

// The other half: the exemption is only real if the monitor path actually declares itself one.
// bookAssessUsage is the ONE function that books monitor spend, so this is where the flag has to
// be set — a future monitor booking through recordUsage directly would be counted as chat, which
// is exactly the drift this finding was.
test('bookAssessUsage marks its spend as a monitor’s', () => {
    const calls = []
    bookAssessUsage('u1', 'claude-sonnet-4-6', { input_tokens: 100 }, 'talosAssess', async (...a) => { calls.push(a) })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0][4], { monitor: true }, 'the 5th argument is what keeps it out of the ceiling')
})

// ─── the two lines that were never on the books ───────────────────────────────
// A web search is billed per SEARCH ($10 / 1,000) and rides in `usage.server_tool_use`, not in any
// token column; a structure-vision read is a second model call inside a tool. Both were $0 to the
// ledger until 2026-09-20. The cost of a missing line is not the line — it is every decision taken
// on a total that looked complete.

test('a web search is priced per search, on top of the tokens', () => {
    const tokensOnly = calcCost('claude-sonnet-4-6', { input_tokens: 1000 })
    const withSearch = calcCost('claude-sonnet-4-6', { input_tokens: 1000, server_tool_use: { web_search_requests: 3 } })
    assert.ok(Math.abs((withSearch - tokensOnly) - 3 * WEB_SEARCH_USD) < 1e-9)
    assert.equal(WEB_SEARCH_USD, 0.01, '$10 per 1,000 searches — the pricing page')
})

test('searchesIn reads the server-tool counter and tolerates its absence', () => {
    assert.equal(searchesIn({ server_tool_use: { web_search_requests: 2 } }), 2)
    assert.equal(searchesIn({ input_tokens: 5 }), 0)
    assert.equal(searchesIn(null), 0)
    assert.equal(searchesIn({ server_tool_use: { web_search_requests: 'x' } }), 0, 'a non-number never becomes NaN in a $inc')
})

test('a 1-hour cache write is priced at 2x, the 5-minute one at 1.25x, from the same total', () => {
    // The API reports the TOTAL written plus a split by TTL. The split is what tells a 2x write
    // from a 1.25x one; a response without it (the older shape) is priced as all-5-minute.
    const n = 1_000_000
    const fiveMin = calcCost('claude-sonnet-4-6', { cache_creation_input_tokens: n })
    const oneHour = calcCost('claude-sonnet-4-6', { cache_creation_input_tokens: n, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: n } })
    const mixed   = calcCost('claude-sonnet-4-6', { cache_creation_input_tokens: n, cache_creation: { ephemeral_5m_input_tokens: n / 2, ephemeral_1h_input_tokens: n / 2 } })
    assert.equal(fiveMin, 3.75)
    assert.equal(oneHour, 6)
    assert.equal(mixed, (3.75 + 6) / 2)
})

test('a 1-hour share larger than the total cannot over-bill', () => {
    // Defensive: the split should never exceed the total, but a cost function that trusts it
    // blindly turns a malformed usage into a phantom charge.
    const cost = calcCost('claude-sonnet-4-6', { cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } })
    assert.equal(cost, 100 * 6 / 1_000_000)
})

test('Sonnet 5 is priced at its standard $2 / $10 — the introductory rate that stayed', () => {
    // Carried at $3/$15 until 2026-09-20 on the announced Sept-1 increase, which Anthropic
    // withdrew. Over-reporting was the safe direction for a ceiling; it is simply wrong now.
    assert.equal(calcCost('claude-sonnet-5', { input_tokens: 1_000_000 }), 2)
    assert.equal(calcCost('claude-sonnet-5', { output_tokens: 1_000_000 }), 10)
    assert.equal(calcCost('claude-sonnet-5', { cache_read_input_tokens: 1_000_000 }), 0.2)
    assert.equal(calcCost('claude-sonnet-5', { cache_creation_input_tokens: 1_000_000 }), 2.5)
})

test('the desk hook books at the model the provider names, and at the turn’s model when it names none', async () => {
    // A structure-vision read inside a tool runs on VISION_MODEL whatever the desk is on. The
    // provider passes that model with the usage; booking it at the desk's model would price a
    // Sonnet read at Opus rates on an Opus thread — or the reverse.
    const booked = []
    const { onUsage, model } = await resolveAgentStream('claude-opus-5', 'u1', 'analystAgent',
        async () => null, async () => null, async (...a) => { booked.push(a) })

    onUsage({ input_tokens: 10 })                          // the loop's own turn
    onUsage({ input_tokens: 10 }, 'claude-sonnet-4-6')     // a tool's vision read
    await new Promise(r => setImmediate(r))

    assert.equal(model, 'claude-opus-5')
    assert.deepEqual(booked.map(a => a[1]), ['claude-opus-5', 'claude-sonnet-4-6'])
    assert.deepEqual(booked.map(a => a[3]), ['analystAgent', 'analystAgent'], 'same desk, same row')
})
