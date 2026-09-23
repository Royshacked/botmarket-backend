// WHICH TIER a wake runs on (docs/design/talos-two-tier.md §Phase 5).
//   node --test tests/unit/talosTiers.test.js
//
// Until 2026-09-23 every pre-entry wake was a full read at ~$0.165. Measured on 95 recorded reads,
// 78% of them needed no such thing. What this file pins is the routing — and, more importantly,
// every case that must NOT be routed away from the expensive read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tierFor, clampExpensiveGap, tickExpensiveDue, MAX_EXPENSIVE_GAP } from '../../monitoring/talos.tiers.js'

/** A setup mid-life: an expensive read has run, set a countdown and left a watch. */
const mid = (over = {}, ms = {}) => ({
    read_mode: 'cheap_then_expensive',
    monitor_state: { expensive_due: 3, watch: { rung: '15min', indicators: ['vwap'] }, ...ms },
    ...over,
})

// ─── What is never triaged ────────────────────────────────────────────────────

test('an expiry review is ALWAYS expensive — it is a decision, not a "did something happen"', () => {
    // The 95-read replay found this the hard way: the cheap tier's one missed action was a
    // let_expire it slept through.
    assert.equal(tierFor(mid(), { reason: 'expiry_review' }), 'expensive')
    assert.equal(tierFor(mid({ read_mode: 'cheap_only' }), { reason: 'expiry_review' }), 'expensive')
})

test('a first look is ALWAYS expensive — there is nothing yet to triage against', () => {
    assert.equal(tierFor(mid(), { reason: 'first_look' }), 'expensive')
    assert.equal(tierFor(mid({ read_mode: 'cheap_only' }), { reason: 'first_look' }), 'expensive')
})

test('a fired guard is ALWAYS expensive — it is the expensive read\'s own alarm', () => {
    // It armed that level precisely because it wanted waking there. Triaging it would be asking a
    // cheaper model to second-guess the stated reason for the wake.
    const woke = { price: 238.5, direction: 'above', means: 'entry' }
    assert.equal(tierFor(mid(), { reason: 'guard', woke }), 'expensive')
    assert.equal(tierFor(mid({ read_mode: 'cheap_only' }), { reason: 'candle', woke }), 'expensive')
})

// ─── The countdown ────────────────────────────────────────────────────────────

test('a setup no expensive read has ever touched is expensive, never asleep', () => {
    // Only an expensive read writes `expensive_due`, which is what stops a brand-new document
    // falling into the sleep branch and never being looked at.
    assert.equal(tierFor({ monitor_state: {} }, { reason: 'candle' }), 'expensive')
    assert.equal(tierFor({}, { reason: 'candle' }), 'expensive')
    assert.equal(tierFor(mid({}, { expensive_due: 0 }), { reason: 'candle' }), 'expensive')
    assert.equal(tierFor(mid({}, { expensive_due: 'soon' }), { reason: 'candle' }), 'expensive')
})

test('inside the countdown, a declared watch means a cheap read', () => {
    assert.equal(tierFor(mid(), { reason: 'candle' }), 'cheap')
})

test('inside the countdown with watch NULL, the setup costs nothing at all', () => {
    // The expensive read said no numbers-only pass could help — a shape still forming. Guards are
    // still watching prices; this wake is free.
    assert.equal(tierFor(mid({}, { watch: null }), { reason: 'candle' }), 'sleep')
})

// ─── read_mode as an override ─────────────────────────────────────────────────

test('expensive_only never triages', () => {
    assert.equal(tierFor(mid({ read_mode: 'expensive_only' }), { reason: 'candle' }), 'expensive')
    assert.equal(tierFor(mid({ read_mode: 'expensive_only' }, { watch: null }), { reason: 'candle' }), 'expensive')
})

test('cheap_only never sleeps and never runs the expensive read on a SCHEDULE', () => {
    // It still escalates — that is the cheap tier's own doing, not this function's — and it runs
    // without a declared watch, because cheapWatch falls back to the premise rung.
    assert.equal(tierFor(mid({ read_mode: 'cheap_only' }, { watch: null }), { reason: 'candle' }), 'cheap')
    assert.equal(tierFor(mid({ read_mode: 'cheap_only' }, { expensive_due: 0 }), { reason: 'candle' }), 'cheap')
    assert.equal(tierFor({ read_mode: 'cheap_only', monitor_state: {} }, { reason: 'candle' }), 'cheap')
})

test('the three middle modes are the SAME machine — the countdown is what differs them', () => {
    for (const m of ['cheap_then_expensive', 'expensive_then_cheap', 'both']) {
        assert.equal(tierFor(mid({ read_mode: m }), { reason: 'candle' }), 'cheap', m)
        assert.equal(tierFor(mid({ read_mode: m }, { expensive_due: 0 }), { reason: 'candle' }), 'expensive', m)
    }
})

// ─── The countdown arithmetic ─────────────────────────────────────────────────

test('an absent or junk countdown means "read me next close" — the safe direction', () => {
    for (const bad of [null, undefined, 0, -3, NaN, 'soon', {}]) {
        assert.equal(clampExpensiveGap(bad), 1, String(bad))
    }
})

test('the countdown is capped — the backstop for a setup whose completion has no price', () => {
    // Most chart patterns finish AT a level and a guard covers those. "RSI divergence forming" has
    // nothing to arm a guard at, and this cap is all that stands behind it.
    assert.equal(clampExpensiveGap(1000), MAX_EXPENSIVE_GAP)
    assert.equal(clampExpensiveGap(MAX_EXPENSIVE_GAP), MAX_EXPENSIVE_GAP)
    assert.equal(clampExpensiveGap(20), 20)
    assert.equal(clampExpensiveGap(6.7), 6, 'truncated, never rounded up past the cap')
})

test('a cheap wake ticks the countdown down and floors at zero', () => {
    assert.equal(tickExpensiveDue({ monitor_state: { expensive_due: 3 } }), 2)
    assert.equal(tickExpensiveDue({ monitor_state: { expensive_due: 1 } }), 0)
    // A document that sat through a restart cannot come back owing reads.
    assert.equal(tickExpensiveDue({ monitor_state: { expensive_due: -5 } }), 0)
    assert.equal(tickExpensiveDue({}), 0)
})
