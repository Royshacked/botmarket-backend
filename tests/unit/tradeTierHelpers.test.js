import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingOrderFields } from '../../services/orderPlan.service.js'
import { placedStamp } from '../../api/trade-ideas/entryStamp.util.js'
import { nextCheckAt, untilOpenMs, MIN_GAP_MS } from '../../monitoring/monitorSchedule.util.js'

// Three pure helpers that each replaced several hand-written copies across the trade tier. What is
// pinned is the one rule each copy had to agree on and could have drifted from.

// ── pendingOrderFields — "entry fired, park the plan until the user confirms" ─────────────────
test('a plan on an OPEN venue awaits the confirm dialog now', () => {
    const f = pendingOrderFields([{ accountId: 'a1', quantity: 1 }], true, 1000)
    assert.deepEqual(f, { pendingOrder: { plan: [{ accountId: 'a1', quantity: 1 }], builtAt: 1000 }, orderState: 'awaiting_confirm' })
})

test('a plan on a SHUT venue parks for the market-open sweep — nothing executes off-hours', () => {
    assert.equal(pendingOrderFields([{ accountId: 'a1' }], false).orderState, 'awaiting_market')
})

test('no plan (no accounts) parks nothing — the trigger is recorded alone', () => {
    assert.deepEqual(pendingOrderFields([], true), {})
    assert.deepEqual(pendingOrderFields(null, true), {})
})

// ── placedStamp — the post-fill fields, whoever filled ───────────────────────────────────────
test('direction becomes status; placed + activated at the same instant; research rides when frozen', () => {
    const links = [{ broker: 'paper', accountId: 'p1', positionId: 'x', quantity: 2 }]
    const s = placedStamp({ direction: 'short', brokerOrders: links, at: 5, researchBasis: { pt: 100 } })
    assert.equal(s.status, 'short')
    assert.equal(s.ordersPlacedAt, 5)
    assert.equal(s.activatedAt, 5)
    assert.equal(s.orderState, 'placed')
    assert.equal(s.brokerOrders, links)
    assert.deepEqual(s.research_basis, { pt: 100 })
})

test('anything not short is long, and no basis means no research_basis key at all', () => {
    const s = placedStamp({ direction: null, brokerOrders: [], at: 1 })
    assert.equal(s.status, 'long')
    assert.ok(!('research_basis' in s), 'absent, not null — the reader treats the key as "was frozen"')
})

// ── monitorSchedule — the cadence both idea-tier loops must agree on ─────────────────────────
test('nextCheckAt floors the gap at a minute so a bound one second away cannot spin', () => {
    const now = Date.UTC(2026, 8, 15, 12, 0, 0)
    assert.equal(nextCheckAt(now, 1_000), new Date(now + MIN_GAP_MS).toISOString())
    assert.equal(nextCheckAt(now, NaN),   new Date(now + MIN_GAP_MS).toISOString())
    assert.equal(nextCheckAt(now, 4 * 60 * 60_000), new Date(now + 4 * 60 * 60_000).toISOString())
})

test('untilOpenMs sleeps to the open when the venue knows it, else the leg\'s own cadence', () => {
    assert.equal(untilOpenMs({ open: false, nextOpenMs: 10_000 }, 4_000, 300_000), 6_000)
    assert.equal(untilOpenMs({ open: false, nextOpenMs: 3_000 },  4_000, 300_000), 300_000, 'a stale open in the past falls back')
    assert.equal(untilOpenMs({ open: false }, 4_000, 300_000), 300_000)
    assert.equal(untilOpenMs(null, 4_000, 300_000), 300_000)
})
