// The monitors' shared read mechanics: how hard they may think, and how their prefix is cached.
//   node --test tests/unit/assessShared.test.js
//
// Both were set from the September 2026 ledger. Output was 46% of what Talos cost and the ONE user
// on `high` paid a third more per read than the users on `off`; cache WRITES were another 43%,
// because a prefix that is identical for every setup was re-written on nearly every wake — the
// wakes are paced by candle closes, which outlive the 5-minute default.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capEffort, ASSESS_MAX_EFFORT, ALLOWED_EFFORTS, ASSESS_PREFIX_CACHE, assessSystem } from '../../monitoring/assess.shared.js'
import { _thinkingConfig } from '../../providers/anthropic.provider.js'

// ─── the effort cap ───────────────────────────────────────────────────────────

test('the cap is `low` — thinking, but the affordable kind', () => {
    assert.equal(ASSESS_MAX_EFFORT, 'low')
    assert.ok(ALLOWED_EFFORTS.has(ASSESS_MAX_EFFORT), 'the cap must be a real level or nothing could ever reach it')
})

test('a stored `high` reads as `low`; anything at or under the cap is untouched', () => {
    assert.equal(capEffort('high'), 'low')
    assert.equal(capEffort('low'),  'low')
    assert.equal(capEffort('off'),  'off')
})

test('an unknown or missing preference is `off`, exactly as before the cap', () => {
    assert.equal(capEffort(undefined), 'off')
    assert.equal(capEffort(null), 'off')
    assert.equal(capEffort('max'), 'off')
    assert.equal(capEffort(''), 'off')
})

test('lifting the cap is one argument — the user’s own choice comes back', () => {
    // The preference is never rewritten, so a premium tier that raises the ceiling restores what
    // the user actually chose rather than what the cap left them with.
    assert.equal(capEffort('high', 'high'), 'high')
    assert.equal(capEffort('high', 'off'), 'off')
})

test('at the cap, a read still thinks — on Sonnet 4.6 that is an explicit adaptive block', () => {
    // The point of capping to `low` rather than to `off`: the user asked for reasoning. On a model
    // that does not think unasked, `low` has to produce a thinking block or the cap silently
    // became an off-switch.
    const cfg = _thinkingConfig(capEffort('high'), 'claude-sonnet-4-6')
    assert.equal(cfg?.thinking?.type, 'adaptive')
    assert.equal(cfg?.output_config?.effort, 'low')
})

// ─── the prefix marker ────────────────────────────────────────────────────────

test('the assessment prefix is cached for an hour', () => {
    assert.deepEqual(ASSESS_PREFIX_CACHE, { type: 'ephemeral', ttl: '1h' })
})

test('the assessment system block is one text block carrying that marker', () => {
    // What Talos sends. The marker sits on the LAST block of the prefix, so tools + system are
    // cached together for the hour; `messages` after it keep the 5-minute tool-loop stamp, which
    // is the order the API requires (longer TTL first).
    const system = assessSystem('You are Talos…')
    assert.equal(system.length, 1)
    assert.equal(system[0].type, 'text')
    assert.equal(system[0].text, 'You are Talos…')
    assert.deepEqual(system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('the marker is frozen — it is spread into every request, and a mutation would be silent', () => {
    assert.ok(Object.isFrozen(ASSESS_PREFIX_CACHE))
    assert.throws(() => { 'use strict'; ASSESS_PREFIX_CACHE.ttl = '5m' })
})
