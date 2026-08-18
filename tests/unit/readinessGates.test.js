import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    isPreActive, isExpiring, isPastExpiry, effectiveVerdict, nextStatus, clampGap, gradedGap,
} from '../../monitoring/readinessGates.js'
import * as talos from '../../monitoring/talos.monitor.service.js'

// The chores both readiness monitors do before they can think. Each one used to exist twice, and
// the copies had already drifted — Talos's "too early" chore gained a line that disarmed the entity
// (orphaning every setup with a future start), and its expiry chore was missing entirely (expired
// setups paid for a full vision read every cadence, forever).
//
// These tests cover the shared behaviour. The DIFFERENCES stay parameters, and the bottom section
// pins them so neither monitor can be "tidied" into the other by accident.

const T = Date.parse('2026-07-26T12:00:00Z')
const MIN15 = 15 * 60_000

test('too early is a fact about the clock, and a junk date is never a gate', () => {
    assert.equal(isPreActive({ active_from: '2026-07-28T00:00:00Z' }, T), true)
    assert.equal(isPreActive({ active_from: '2026-07-01T00:00:00Z' }, T), false)
    // A garbage date must never silently stop something being watched.
    for (const v of [null, undefined, '', 'someday']) {
        assert.equal(isPreActive({ active_from: v }, T), false, String(v))
    }
})

test('expiry opens a review window and never closes it again', () => {
    assert.equal(isExpiring({ valid_until: '2026-07-26T12:10:00Z' }, T, MIN15), true, 'inside the window')
    assert.equal(isExpiring({ valid_until: '2026-07-26T14:00:00Z' }, T, MIN15), false, 'not yet')
    assert.equal(isExpiring({ valid_until: '2026-07-26T09:00:00Z' }, T, MIN15), true, 'long past — still true')
    assert.equal(isExpiring({ valid_until: null }, T, MIN15), false)
})

test('past expiry is a stricter question than expiring', () => {
    // The distinction is what makes a terminator possible: "reviewing" is not "over".
    assert.equal(isExpiring({ valid_until: '2026-07-26T12:10:00Z' }, T, MIN15), true)
    assert.equal(isPastExpiry({ valid_until: '2026-07-26T12:10:00Z' }, T), false)
    assert.equal(isPastExpiry({ valid_until: '2026-07-26T11:59:00Z' }, T), true)
})

test('let_expire is only on the menu for an expiry review', () => {
    // Otherwise a zone trip could terminally kill an entity still inside its validity window.
    assert.equal(effectiveVerdict('let_expire', 'zone_trip', false), 'stand_aside')
    assert.equal(effectiveVerdict('let_expire', 'expiry_review', false), 'let_expire')
})

test('a past-expiry review that will not commit is terminated', () => {
    // isExpiring never goes false again, so without this every later wake pays for another full
    // read — forever, on a plan whose window has closed.
    assert.equal(effectiveVerdict('wait', 'expiry_review', true), 'let_expire')
    assert.equal(effectiveVerdict('stand_aside', 'expiry_review', true), 'let_expire')
    assert.equal(effectiveVerdict('enter', 'expiry_review', true), 'enter', 'a late trigger is still a trigger')
    // Inside the window (not yet past) these stay legitimate.
    assert.equal(effectiveVerdict('wait', 'expiry_review', false), 'wait')
})

test('only entry moves the lifecycle', () => {
    assert.equal(nextStatus('enter'), 'hit')
    for (const v of ['wait', 'stand_aside', 'edit', 'let_expire']) assert.equal(nextStatus(v), 'looking', v)
})

test('a self-chosen gap is clamped into the band', () => {
    const band = { min: 5, max: 30, fallback: 5 }
    assert.equal(clampGap(1, band), 5, 'too eager → floor')
    assert.equal(clampGap(9999, band), 30, 'too lazy → ceiling')
    assert.equal(clampGap(12, band), 12, 'in band → honoured')
})

test('cadence tightens toward a zone and relaxes away from it', () => {
    const band = { min: 5, max: 30, near: 1, far: 8 }
    assert.equal(gradedGap(0, band), 5, 'inside → floor')
    assert.equal(gradedGap(1, band), 5, 'at the near band → floor')
    assert.equal(gradedGap(8, band), 30, 'at the far band → ceiling')
    assert.equal(gradedGap(20, band), 30, 'beyond → ceiling')
    const mid = gradedGap(4.5, band)
    assert.ok(mid > 5 && mid < 30, `graded between: ${mid}`)
})

test('an unmeasurable distance polls lazily, never flat out', () => {
    // Polling hard on a broken feed burns quota for nothing.
    const band = { min: 5, max: 30, near: 1, far: 8 }
    for (const d of [null, undefined, NaN, Infinity]) assert.equal(gradedGap(d, band), 30, String(d))
})

test('the gap is monotonic — approaching price never polls lazier', () => {
    const band = { min: 5, max: 30, near: 1, far: 8 }
    const gaps = [20, 8, 6, 4, 2, 1, 0].map(d => gradedGap(d, band))
    for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] <= gaps[i - 1], `${gaps}`)
})

// ─── The differences, pinned ──────────────────────────────────────────────────
// Where the two monitors genuinely disagree the difference is a PARAMETER, not a second copy.
// These assert it stays a deliberate choice rather than being "tidied" into a single answer.

// Each test below used to PAIR its assertion with Hermes's opposite one — that contrast was the
// point of the section. Hermes was archived on 2026-08-18 and took its half with it (the paired
// versions are in archive/tests/hermesMonitor.test.js). What is kept is the live monitor's
// behaviour, which is what a regression would actually break.
test('a setup with no next check named falls back to the EAGER end', () => {
    // Its band is already horizon-scaled, so the floor is cheap. (Hermes went the other way, to
    // the ceiling, so as not to burn quota re-reading a quiet name.)
    const setup = { cadence: { min: 30, max: 240 } }
    const eager = talos._nextCheckAt(setup, T, undefined)
    assert.equal(eager, new Date(T + 30 * 60_000).toISOString(), 'setup → floor')
})

test('Talos does NOT spare `edit` from the past-expiry cutoff', () => {
    // Talos latches only on the branch that fires the card, so sparing edit here would reopen the
    // forever-loop. (A call could be spared because its edit latches the invalidation axis.)
    assert.equal(talos._effectiveVerdict('edit', 'expiry_review', true), 'let_expire')
})

test('a zero-width zone IS a zone to Talos', () => {
    // A setup zone may legally be an exact level the user named, so Talos measures distance to it.
    // (Hermes read the same shape as no usable band and fell to its lazy cadence.)
    const zone = [{ id: 'z', lower: 100, upper: 100 }]
    assert.ok(Number.isFinite(talos.zoneDistance(zone, 105)), 'setup: an exact level, measurable')
})
