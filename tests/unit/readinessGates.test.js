import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    isPreActive, isExpiring, isPastExpiry, effectiveVerdict, nextStatus,
} from '../../monitoring/readinessGates.js'
import { guardFires } from '../../services/setup.schema.js'
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
    assert.equal(effectiveVerdict('let_expire', 'candle', false), 'stand_aside')
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



// ─── The differences, pinned ──────────────────────────────────────────────────
// Where the two monitors genuinely disagree the difference is a PARAMETER, not a second copy.
// These assert it stays a deliberate choice rather than being "tidied" into a single answer.

// Each test below used to PAIR its assertion with Hermes's opposite one — that contrast was the
// point of the section. Hermes was archived on 2026-08-18 and took its half with it (the paired
// versions are in archive/tests/hermesMonitor.test.js). What is kept is the live monitor's
// behaviour, which is what a regression would actually break.
test('the next read is the next candle close of the rung, plus the provider lag', () => {
    // There is no cadence band any more: the rung IS the pace (docs/design/talos-per-candle.md).
    const setup = { asset: 'BTCUSD', status: 'looking', valid_until: null }
    const deps  = { nextCandleCloseMs: (_s, _c, rung, now) => now + (rung === '1hr' ? 3600_000 : 300_000) }
    assert.equal(talos._nextReadAt(setup, T, '1hr', deps),  new Date(T + 3600_000 + talos.READ_LAG_MS).toISOString())
    assert.equal(talos._nextReadAt(setup, T, '5min', deps), new Date(T + 300_000 + talos.READ_LAG_MS).toISOString())
})

test('pre-entry, a coarse rung never sleeps through the expiry review', () => {
    const deps  = { nextCandleCloseMs: (_s, _c, _r, now) => now + 24 * 3600_000 }
    const setup = { asset: 'AAPL', status: 'looking', valid_until: new Date(T + 2 * 3600_000).toISOString() }
    assert.equal(talos._nextReadAt(setup, T, 'day', deps), new Date(T + 2 * 3600_000 - 15 * 60_000).toISOString(), 'the review window wins')
    // A limit order awaiting its fill still has an expiry to honour.
    assert.equal(talos._nextReadAt({ ...setup, status: 'hit' }, T, 'day', deps), new Date(T + 2 * 3600_000 - 15 * 60_000).toISOString())
    // In position there is no expiry to review — the candle close stands.
    const pos = { ...setup, status: 'long' }
    assert.equal(talos._nextReadAt(pos, T, 'day', deps), new Date(T + 24 * 3600_000 + talos.READ_LAG_MS).toISOString())
})

test('Talos does NOT spare `edit` from the past-expiry cutoff', () => {
    // Talos latches only on the branch that fires the card, so sparing edit here would reopen the
    // forever-loop. (A call could be spared because its edit latches the invalidation axis.)
    assert.equal(talos._effectiveVerdict('edit', 'expiry_review', true), 'let_expire')
})

test('a zero-width level IS watchable by Talos', () => {
    // The claim is unchanged and the mechanism is not. A setup level may legally be an exact price
    // the user named, and it used to need a distance RULER (`zoneDistance`, with a 0.1%-of-price
    // fallback so a zero band did not divide by zero). Talos arms a guard on it now, and a guard
    // needs no width at all — which is the point of docs/desks/talos-guards.md: an exact level
    // became as catchable as a wide band, so the widths could go.
    const touch = { price: 100, direction: 'any' }
    assert.equal(guardFires(touch, { high: 105, low: 99 }), true, 'reached during the window')
    assert.equal(guardFires(touch, { high: 105, low: 101 }), false, 'never came back to it')
})
