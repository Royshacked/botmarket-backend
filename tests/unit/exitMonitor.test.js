import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _checkExit, _cadence, hasMonitoredWork } from '../../monitoring/exit.monitor.js'

// The loop that gives `positionMonitor.checkPosition` an owner again.
//
// Two things here are worth more than the rest. The PRE-GATE decides whether a position costs three
// candle fetches or one Mongo write, and it is wrong in both directions: too permissive and this
// loop — which sees every open position in the app — throttles us off our own price provider, the
// way our own polling did once before; too strict and a stop silently stops being watched, which is
// the entire failure this loop exists to end. And the CADENCE has to follow the fastest leg, or a
// 5-minute stop is read at a daily target's pace.

const NOW = Date.parse('2026-08-18T14:00:00.000Z')

const OPEN = { open: true, nextOpenMs: null }
const SHUT = { open: false, nextOpenMs: NOW + 3 * 3_600_000 }

const pos = (over = {}) => ({
    id: 'e1', asset: 'SPY', asset_class: 'stock', status: 'long', direction: 'long',
    quantity: 10, broker: 'paper', timeframe: 'day', ...over,
})

const RESIDUAL = { operator: 'OR', children: [{ condition: 'RSI(14) below 30', quantity: 10 }] }

/** Records every side effect, and answers with an open venue and one usable candle by default. */
function harness({ market = OPEN, candles = [{ o: 1, h: 2, l: 1, c: 2, t: NOW }] } = {}) {
    const patches = [], fetched = [], checks = []
    const deps = {
        getDb:           async () => ({}),
        getMarketStatus: () => market,
        fetchCandles:    async (id, asset, tf) => { fetched.push(tf); return candles },
        checkPosition:   async (db, idea, s, t, a, onClose) => { checks.push({ id: idea.id, onClose }) },
        patch:           async (id, fields) => { patches.push({ id, fields }) },
    }
    return { deps, patches, fetched, checks, nextAt: () => patches.at(-1)?.fields['monitor_state.next_check_at'] }
}

const gapMs = (h) => Date.parse(h.nextAt()) - NOW

// ── the pre-gate ─────────────────────────────────────────────────────────────

test('a residual monitor tree is work — this is the leg the loop exists for', () => {
    assert.equal(hasMonitoredWork(pos({ stopMonitorTree: RESIDUAL, monitorStop: true })), true)
})

test('a leg the BROKER holds is not work', () => {
    // routeExits found only touch leaves, so the exits are resting orders. `monitorStop === false`
    // is exactly what `_evaluateExit` reads to skip the leg.
    assert.equal(hasMonitoredWork(pos({ monitorStop: false, monitorTp: false })), false)
})

test('an ABSENT flag is not the same as a false one', () => {
    // A document written before the flag existed has no opinion, and skipping it would unwatch the
    // oldest positions in the book — the ones nobody is looking at.
    assert.equal(hasMonitoredWork(pos({ stop_conditions: [{ condition: 'close below 400' }] })), true)
})

test('MANUAL: the whole leg is work, because there is no venue to rest any of it at', () => {
    // `confirmManualEntry` writes `monitorStop = hasAny` and NO residual tree, so the pre-gate has
    // to fall through to the authored tree or every manual position reads as "nothing to do".
    const manual = pos({ broker: 'manual', monitorStop: true, stop_condition_tree: { operator: 'OR', children: [] }, stop_conditions: [] })
    assert.equal(hasMonitoredWork(manual), true)
})

test('a pending additional entry is work on its own', () => {
    assert.equal(hasMonitoredWork(pos({ monitorStop: false, monitorTp: false, additional_entries: [{ quantity: 5 }] })), true)
    assert.equal(hasMonitoredWork(pos({ monitorStop: false, monitorTp: false, additional_entries: [{ filledAt: 1 }] })), false)
    assert.equal(hasMonitoredWork(pos({ monitorStop: false, monitorTp: false, additional_entries: [{ triggeredAt: 1 }] })), false)
})

test('a bare position is not work', () => {
    assert.equal(hasMonitoredWork(pos()), false)
    assert.equal(hasMonitoredWork(null), false)
})

// ── the cadence ──────────────────────────────────────────────────────────────

test('the gap follows the FASTEST leg, not the slowest', () => {
    const c = _cadence(pos({ stop_timeframe: '5min', tp_timeframe: 'day', timeframe: 'day' }))
    assert.equal(c.gap, 5 * 60_000, 'a daily target must not slow a 5-minute stop down')
    assert.equal(c.needsLiveTape, true)
})

test('a daily-only position needs no live tape', () => {
    const c = _cadence(pos({ timeframe: 'day' }))
    assert.equal(c.needsLiveTape, false, 'its candle is already closed — a shut venue changes nothing')
})

test('cumulative volume pulls the cadence to the floor whatever the leg claims', () => {
    const c = _cadence(pos({
        timeframe: 'day',
        stopMonitorTree: { operator: 'OR', children: [{ condition: 'volume above 2000000', type: 'volume', mode: 'cumulative' }] },
    }))
    assert.equal(c.gap, 60_000, 'measured from the session open, so it is only meaningful minute by minute')
    assert.equal(c.needsLiveTape, true)
})

// ── the check ────────────────────────────────────────────────────────────────

test('nothing monitored → no fetch, no check, and a schedule written', async () => {
    const h = harness()
    const r = await _checkExit(pos({ monitorStop: false, monitorTp: false }), NOW, h.deps)
    assert.equal(r, 'nothing_monitored')
    assert.deepEqual(h.fetched, [], 'the pre-gate must run BEFORE any IO — this is the quota guard')
    assert.equal(h.checks.length, 0)
    assert.ok(h.nextAt(), 'still rescheduled, or the lease expires and it re-reads every 90s forever')
})

test('no venue → parked cheaply rather than dropped', async () => {
    const h = harness()
    const r = await _checkExit(pos({ broker: null, stopMonitorTree: RESIDUAL }), NOW, h.deps)
    assert.equal(r, 'no_venue')
    assert.deepEqual(h.fetched, [])
    assert.equal(gapMs(h), 60 * 60_000)
})

test('an UNDEFINED broker is still watched — only an explicit null is venue-less', async () => {
    const h = harness()
    const legacy = pos({ stopMonitorTree: RESIDUAL })
    delete legacy.broker
    assert.equal(await _checkExit(legacy, NOW, h.deps), 'checked')
})

test('an intraday leg on a shut venue sleeps until the open', async () => {
    const h = harness({ market: SHUT })
    const r = await _checkExit(pos({ stop_timeframe: '5min', stopMonitorTree: RESIDUAL }), NOW, h.deps)
    assert.equal(r, 'market_closed')
    assert.deepEqual(h.fetched, [], 'a shut venue has no live tape to read')
    assert.equal(gapMs(h), 3 * 3_600_000, 'not the 5-minute cadence — there is nothing to see until it opens')
})

test('a DAILY leg is checked on a shut venue — its candle is already closed', async () => {
    const h = harness({ market: SHUT })
    assert.equal(await _checkExit(pos({ timeframe: 'day', stopMonitorTree: RESIDUAL }), NOW, h.deps), 'checked')
})

test('legs sharing a timeframe are fetched ONCE', async () => {
    const h = harness()
    await _checkExit(pos({ timeframe: 'day', stopMonitorTree: RESIDUAL }), NOW, h.deps)
    assert.deepEqual(h.fetched, ['day'], 'stop, tp and additional-entry candles are the same candles here')
})

test('differing timeframes are each fetched', async () => {
    const h = harness()
    await _checkExit(pos({ stop_timeframe: '5min', tp_timeframe: '1hr', timeframe: 'day', stopMonitorTree: RESIDUAL }), NOW, h.deps)
    assert.deepEqual(h.fetched, ['5min', '1hr', 'day'])
})

test('a provider that cannot answer is a reason to come back, not to give up on the leg', async () => {
    const h = harness({ candles: null })
    const r = await _checkExit(pos({ timeframe: 'day', stopMonitorTree: RESIDUAL }), NOW, h.deps)
    assert.equal(r, 'no_candles')
    assert.equal(h.checks.length, 0)
    assert.equal(gapMs(h), 4 * 3_600_000, 'rescheduled on its own cadence rather than left leaseless')
})

test('the schedule is written AFTER the check, and floors at a minute', async () => {
    const h = harness()
    const order = []
    h.deps.checkPosition = async () => { order.push('check') }
    h.deps.patch = async () => { order.push('patch') }
    await _checkExit(pos({ stop_timeframe: '1min', stopMonitorTree: RESIDUAL }), NOW, h.deps)
    assert.deepEqual(order, ['check', 'patch'], 'the check decides whether this position still exists')

    const h2 = harness()
    await _checkExit(pos({ stop_timeframe: '1min', stopMonitorTree: RESIDUAL }), NOW, h2.deps)
    assert.equal(gapMs(h2), 60_000, 'the poll interval is a minute — asking for less buys nothing')
})

test('onClose marks the entity closed — the alert-only path with no broker position', async () => {
    const h = harness()
    await _checkExit(pos({ timeframe: 'day', stopMonitorTree: RESIDUAL }), NOW, h.deps)
    await h.checks[0].onClose('e1', 'stop')
    const closed = h.patches.find(p => p.fields.status === 'closed')
    assert.ok(closed, 'the monitor must be able to close a position it cannot send anywhere')
    assert.equal(closed.fields.closedReason, 'stop')
    assert.ok(Number.isFinite(closed.fields.closedAt))
})
