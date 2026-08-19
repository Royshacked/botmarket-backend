import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSelfExecuted } from '../../services/venue.resolve.service.js'
import { getBrokerAdapter, SUPPORTED_BROKERS } from '../../api/broker/broker.factory.js'

// WHO EXECUTES is a property of the venue, not a string eleven modules recognise.
//
// `manual` is real money at an institution the app cannot reach: the account holder places and
// closes, and the app monitors, decides and asks. Eleven call sites branched on that — entry, exit,
// the setup monitor, exit routing, the manage hand-off, four rebalance paths and the two
// manual-portfolio reads — each spelling it `broker === 'manual'`. A second broker-less venue would
// have had to be added to all eleven, and the one that got missed would have placed a real order.
//
// So it is a capability now, and this is the test that keeps it honest.

test('the manual venue is the self-executed one', () => {
    assert.equal(isSelfExecuted('manual'), true)
})

test('every venue the app can actually trade at is NOT self-executed', () => {
    assert.equal(isSelfExecuted('ctrader'), false)
    assert.equal(isSelfExecuted('paper'), false)
})

test('IBKR is unwired, which is a different thing from hand-traded', () => {
    // The trap this exists to hold shut: IBKR is `trading:false` today, exactly like manual, so
    // anything that asked "can this venue trade?" would lump the two together and start telling
    // users to go place their IBKR orders by hand. The right answer for IBKR is to WAIT.
    const caps = getBrokerAdapter('ibkr').capabilities()
    assert.equal(caps.trading, false)
    assert.equal(isSelfExecuted('ibkr'), false)
})

// ── Never throws ──────────────────────────────────────────────────────────────

test('an absent or unknown broker answers false rather than throwing', () => {
    // Load-bearing, not defensive habit: getBrokerAdapter answers an unregistered type with a 400,
    // and the callers are monitors iterating live documents. A legacy doc with no broker, or one
    // naming a venue since removed, must resolve to "the app executes here" — which then fails
    // visibly at the broker call — rather than take down the tick for every other entity in the batch.
    for (const bad of [null, undefined, '', 'nope', 0, {}, []]) {
        assert.equal(isSelfExecuted(bad), false, `isSelfExecuted(${JSON.stringify(bad)}) should be false`)
    }
})

// ── Every adapter states it ───────────────────────────────────────────────────

test('every registered adapter names selfExecuted explicitly', () => {
    // Each capabilities() is a hand-written exhaustive literal rather than a spread of the base, so
    // an omitted key reads `undefined` — falsy, and therefore accidentally right for this flag but
    // not for the next one whose safe default is true. Assert the key is really there.
    for (const broker of SUPPORTED_BROKERS) {
        const caps = getBrokerAdapter(broker).capabilities()
        assert.equal(typeof caps.selfExecuted, 'boolean',
            `${broker}.capabilities() must state selfExecuted, got ${caps.selfExecuted}`)
    }
})

test('exactly one venue is self-executed today', () => {
    // Not a style check — it is the inventory. When a second broker-less venue is added this fails,
    // and the failure is the reminder to re-read the eleven call sites once (they ask the capability
    // now, so they should all just work) rather than to discover it from a mis-placed order.
    const selfExecuted = SUPPORTED_BROKERS.filter(b => getBrokerAdapter(b).capabilities().selfExecuted)
    assert.deepEqual(selfExecuted, ['manual'])
})
