import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    HORIZONS, DEFAULT_HORIZON, normalizeHorizon, toIso, addMonths, openWindow, windowProgress,
} from '../../services/forecastClock.js'

// The clock every graded forecast runs on (pure). Shared by the Analyst's price target
// (set_at → target_date) and the strategy desk's per-sector stances (set_at → review_date).

// ── the horizon vocabulary ──────────────────────────────────────────────────
test('normalizeHorizon: the vocabulary passes; anything else becomes the house default', () => {
    for (const h of HORIZONS) assert.equal(normalizeHorizon(h), h)
    // The shapes that used to persist verbatim and left a call unscoreable.
    assert.equal(normalizeHorizon('12 months'), DEFAULT_HORIZON)
    assert.equal(normalizeHorizon('end of 2027'), DEFAULT_HORIZON)
    assert.equal(normalizeHorizon(''), DEFAULT_HORIZON)
    assert.equal(normalizeHorizon(undefined), DEFAULT_HORIZON)
    assert.equal(normalizeHorizon(12), DEFAULT_HORIZON)
    assert.equal(DEFAULT_HORIZON, '12m')
})

// ── date arithmetic ─────────────────────────────────────────────────────────
test('addMonths: plain shifts', () => {
    assert.equal(addMonths('2026-03-10T12:00:00.000Z', 3),  '2026-06-10T12:00:00.000Z')
    assert.equal(addMonths('2026-03-10T12:00:00.000Z', 12), '2027-03-10T12:00:00.000Z')
    assert.equal(addMonths('2026-03-10T12:00:00.000Z', 24), '2028-03-10T12:00:00.000Z')
})

test('addMonths: clamps to the landing month instead of overflowing past it', () => {
    // Naive date math turns Aug 31 + 6m into Mar 3. The clamp is the whole reason this isn't inline.
    assert.equal(addMonths('2026-08-31T00:00:00.000Z', 6),  '2027-02-28T00:00:00.000Z')
    assert.equal(addMonths('2028-02-29T00:00:00.000Z', 12), '2029-02-28T00:00:00.000Z')   // leap day
    assert.equal(addMonths('2026-05-31T00:00:00.000Z', 3),  '2026-08-31T00:00:00.000Z')   // 31-day month
    assert.equal(addMonths('2026-01-31T00:00:00.000Z', 3),  '2026-04-30T00:00:00.000Z')
})

test('addMonths / toIso: unparseable input is null, never a crash or an epoch', () => {
    assert.equal(addMonths('nonsense', 12), null)
    assert.equal(addMonths(null, 12), null)
    assert.equal(toIso('nonsense'), null)
    assert.equal(toIso(null), null)
    assert.equal(toIso(1767225600000), null)          // a timestamp is not an ISO string
    assert.equal(toIso('  2026-03-10T12:00:00Z  '), '2026-03-10T12:00:00.000Z')   // trimmed
})

// ── the window, and the rule it encodes ─────────────────────────────────────
test('openWindow: derives ends_at from set_at + horizon', () => {
    assert.deepEqual(openWindow({ set_at: '2026-03-10T12:00:00.000Z', horizon: '6m' }, 'ignored'), {
        horizon: '6m', set_at: '2026-03-10T12:00:00.000Z', ends_at: '2026-09-10T12:00:00.000Z',
    })
})

test('openWindow: REAFFIRMING keeps the clock, AUTHORING starts a new one', () => {
    const now  = '2026-08-06T00:00:00.000Z'
    const held = openWindow({ set_at: '2026-01-01T00:00:00.000Z', horizon: '12m' }, now)
    assert.equal(held.set_at,  '2026-01-01T00:00:00.000Z')   // survives — the deadline holds
    assert.equal(held.ends_at, '2027-01-01T00:00:00.000Z')

    // No set_at = a freshly authored call. This is what makes a daily monitor tick (which spreads the
    // stored window through) unable to push its own deadline out one day at a time.
    const fresh = openWindow({ horizon: '12m' }, now)
    assert.equal(fresh.set_at,  now)
    assert.equal(fresh.ends_at, '2027-08-06T00:00:00.000Z')
})

test('openWindow: an input ends_at is IGNORED — a deadline can never disagree with its horizon', () => {
    const w = openWindow({ set_at: '2026-03-10T12:00:00.000Z', horizon: '6m', ends_at: '2099-01-01T00:00:00.000Z' }, 'x')
    assert.equal(w.ends_at, '2026-09-10T12:00:00.000Z')
})

test('openWindow: no args at all still yields a usable default window', () => {
    const now = '2026-08-06T00:00:00.000Z'
    assert.deepEqual(openWindow(undefined, now), {
        horizon: DEFAULT_HORIZON, set_at: now, ends_at: '2027-08-06T00:00:00.000Z',
    })
})

// ── progress through the window ─────────────────────────────────────────────
const W = { set_at: '2026-01-01T00:00:00.000Z', ends_at: '2027-01-01T00:00:00.000Z' }
const at = iso => Date.parse(iso)

test('windowProgress: 0 at the call, ~1 at the deadline, >1 once overdue', () => {
    assert.equal(windowProgress(W, at('2026-01-01T00:00:00.000Z')), 0)
    assert.equal(windowProgress(W, at('2027-01-01T00:00:00.000Z')), 1)
    assert.ok(windowProgress(W, at('2027-07-01T00:00:00.000Z')) > 1)
    const half = windowProgress(W, at('2026-07-02T12:00:00.000Z'))
    assert.ok(half > 0.49 && half < 0.51, `expected ~0.5, got ${half}`)
})

test('windowProgress: ABSTAINS (null) rather than guessing — never early, never late', () => {
    assert.equal(windowProgress(W, undefined), null)                       // no clock
    assert.equal(windowProgress(W, 0), null)
    assert.equal(windowProgress(W, NaN), null)
    assert.equal(windowProgress({}, at('2026-06-01T00:00:00.000Z')), null) // a call with no window
    assert.equal(windowProgress(undefined, at('2026-06-01T00:00:00.000Z')), null)
    assert.equal(windowProgress({ set_at: 'nonsense', ends_at: W.ends_at }, at('2026-06-01T00:00:00.000Z')), null)
    // A zero-length or inverted window can't be measured through.
    assert.equal(windowProgress({ set_at: W.ends_at, ends_at: W.set_at }, at('2026-06-01T00:00:00.000Z')), null)
    assert.equal(windowProgress({ set_at: W.set_at, ends_at: W.set_at }, at('2026-06-01T00:00:00.000Z')), null)
})

test('windowProgress: scales with the horizon, which is why it is a fraction', () => {
    // The same 30 days is a third of a 3m call but a twenty-fourth of a 24m one.
    const short = { set_at: '2026-01-01T00:00:00.000Z', ends_at: '2026-04-01T00:00:00.000Z' }
    const long  = { set_at: '2026-01-01T00:00:00.000Z', ends_at: '2028-01-01T00:00:00.000Z' }
    const when  = at('2026-01-31T00:00:00.000Z')
    assert.ok(windowProgress(short, when) > 0.3)
    assert.ok(windowProgress(long,  when) < 0.05)
})
