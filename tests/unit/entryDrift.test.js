import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entryDrift, ENTRY_DRIFT_TOLERANCE_R } from '../../services/setup.schema.js'
import { priceMovedRefusal } from '../../api/trade-ideas/ideaExecution.service.js'

// A confirmed entry goes out at MARKET, so it fills where the market is, not where the plan was
// drawn. entryDrift is the one measure of that gap — the card states it, the confirm guard refuses
// on it (ideaExecution.placeOrdersForIdea). The EXPD trade (2026-10-20) is the case it exists for:
// planned 196, stop 190.01, target 207.14; read at 198.60, filled at 198.81.

const LONG = {
    direction: 'long', armed_leg_id: 'e1',
    entry_legs:  [{ id: 'e1', price: 196 }],
    stop_legs:   [{ id: 's1', price: 190.01 }],
    target_legs: [{ id: 't1', price: 207.14 }],
}

test('EXPD: 2.81 above a 5.99 risk is adverse, and the R:R falls below 1', () => {
    const d = entryDrift(LONG, 198.81)
    assert.equal(d.planned, 196)
    assert.equal(d.slippage, 2.81)
    assert.equal(d.slippageR, 0.47)
    assert.equal(d.plannedRr, 1.86)
    assert.equal(d.liveRr, 0.95)
    assert.equal(d.adverse, true)
    assert.equal(d.pastStop, false)
})

test('inside the tolerance (a tenth of the plan\'s risk) is not adverse', () => {
    const edge = 196 + 5.99 * ENTRY_DRIFT_TOLERANCE_R
    assert.equal(entryDrift(LONG, edge - 0.01).adverse, false)
    assert.equal(entryDrift(LONG, edge + 0.01).adverse, true)
})

test('a BETTER price is never adverse — until it is past the stop', () => {
    assert.equal(entryDrift(LONG, 193).adverse, false, 'cheaper than planned is a gift')
    const broken = entryDrift(LONG, 189.5)
    assert.equal(broken.pastStop, true)
    assert.equal(broken.adverse, true, 'below the stop there is no trade at any price')
    assert.equal(broken.liveRr, null)
})

test('a short mirrors it: a HIGHER price is the better one', () => {
    const SHORT = { direction: 'short', entry_legs: [{ id: 'e1', price: 100 }], stop_legs: [{ price: 105 }], target_legs: [{ price: 90 }] }
    assert.equal(entryDrift(SHORT, 101).adverse, false, 'sold higher than planned')
    const d = entryDrift(SHORT, 98)
    assert.equal(d.slippage, 2)
    assert.equal(d.adverse, true)
    assert.equal(entryDrift(SHORT, 106).pastStop, true)
})

test('measured from the ARMED leg, not the first one', () => {
    const two = { ...LONG, armed_leg_id: 'e2', entry_legs: [{ id: 'e1', price: 196 }, { id: 'e2', price: 199 }] }
    assert.equal(entryDrift(two, 198.81).adverse, false, '198.81 is under the armed 199')
})

test('nothing to compare → null, so the caller places as before', () => {
    assert.equal(entryDrift(LONG, null), null, 'no live price')
    assert.equal(entryDrift(LONG, 0), null)
    assert.equal(entryDrift({ ...LONG, stop_legs: [] }, 198), null, 'no stop')
    assert.equal(entryDrift({ ...LONG, entry_legs: [{ id: 'e1', price: null }] }, 198), null, 'no priced entry')
    assert.equal(entryDrift({ ...LONG, stop_legs: [{ price: 197 }] }, 198), null, 'an entry inside its own stop has no risk to measure by')
})

// ── The confirm guard (ideaExecution.placeOrdersForIdea) ─────────────────────

test('confirm guard: EXPD at 198.81 is refused WITH the numbers, for the dialog to show', () => {
    const r = priceMovedRefusal(LONG, 198.81)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'price_moved')
    assert.equal(r.drift.liveRr, 0.95)
})

test('confirm guard: at the plan, or with no price to judge by, it lets the order through', () => {
    assert.equal(priceMovedRefusal(LONG, 196.2), null)
    assert.equal(priceMovedRefusal(LONG, null), null, 'a feed outage must not block every confirm')
})
