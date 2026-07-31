import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkBrokerSymbol } from '../../services/tradingContext.service.js'
// The enforcement moved to the TOOL layer, where the renderer it shares with check_broker_symbol
// lives — see the note in tradingContext.service.js on why sitting next to the read broke it.
import { withBrokerAvailability, _clearAvailabilityCache } from '../../services/tradingContext.tools.js'
import { toolError } from '../../services/toolResult.util.js'

// "Can I actually trade this here?" — the venue fact a desk must never guess at.
// The load-bearing case is the THIRD state: an unreachable broker is UNKNOWN, not "unavailable".
// Reporting a timeout as "your broker doesn't list AVGO" would talk a trader out of a real trade.

// Fake brokerService. `resolve` decides per broker: true → listed, false → not listed,
// 'throw' → transport failure.
function fakeBroker({ connections, resolve = {}, trading = new Set(['ctrader']), accounts = {} } = {}) {
    const asked = []
    return {
        _asked: asked,
        listConnections: async () => connections,
        capabilities: (b) => ({ trading: trading.has(b) }),
        getTradingAccounts: async (b) => accounts[b] ?? { accounts: [{ id: `${b}-acct` }], selectedAccountId: `${b}-acct` },
        resolveSymbol: async (b, userId, accountId, symbol) => {
            asked.push({ broker: b, accountId, symbol })
            const r = resolve[b]
            if (r === 'throw') throw new Error('socket timeout')
            return r ? { found: true, symbol: `${symbol}.cash` } : { found: false, symbol }
        },
    }
}

const identity = (_broker, sym) => sym

test('a listed instrument comes back tradable, under the name the order will use', async () => {
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: true } })
    const r = await checkBrokerSymbol('u1', 'AVGO', { broker, mapSymbol: identity })

    assert.equal(r.ticker, 'AVGO')
    assert.deepEqual(r.venues, [{ broker: 'ctrader', tradable: true, brokerSymbol: 'AVGO.cash' }])
})

test('a broker that answers "not listed" is a definite NO', async () => {
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: false } })
    const r = await checkBrokerSymbol('u1', 'AVGO', { broker, mapSymbol: identity })

    assert.equal(r.venues[0].tradable, false)
    assert.equal(r.venues[0].brokerSymbol, null)
})

test('an UNREACHABLE broker is unknown (null) — never reported as unavailable', async () => {
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: 'throw' } })
    const r = await checkBrokerSymbol('u1', 'AVGO', { broker, mapSymbol: identity })

    assert.equal(r.venues[0].tradable, null, 'must be null, not false')
    assert.match(r.venues[0].error, /unknown/i)
})

test('the static alias map is applied first, and the original name is carried back', async () => {
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: true } })
    // Mirrors the real map bridging the semantic gap the broker cannot: NQ → US100.
    const r = await checkBrokerSymbol('u1', 'NQ', { broker, mapSymbol: () => 'US100' })

    assert.equal(broker._asked[0].symbol, 'US100', 'the broker is asked for the MAPPED name')
    assert.equal(r.venues[0].brokerSymbol, 'US100.cash')
    assert.equal(r.venues[0].mappedFrom, 'NQ')
})

test('the symbol list of the SELECTED account is the one asked', async () => {
    const broker = fakeBroker({
        connections: { ctrader: true }, resolve: { ctrader: true },
        accounts: { ctrader: { accounts: [{ id: 'a1' }, { id: 'a2' }], selectedAccountId: 'a2' } },
    })
    await checkBrokerSymbol('u1', 'AVGO', { broker, mapSymbol: identity })
    assert.equal(broker._asked[0].accountId, 'a2')
})

test('paper, manual and non-trading venues are not asked — the question is a live-broker one', async () => {
    const broker = fakeBroker({
        connections: { ctrader: true, paper: true, manual: true, ibkr: true },
        resolve: { ctrader: true, ibkr: true },
        trading: new Set(['ctrader']),   // ibkr connected but trading:false
    })
    const r = await checkBrokerSymbol('u1', 'AVGO', { broker, mapSymbol: identity })

    assert.deepEqual(r.venues.map(v => v.broker), ['ctrader'])
    assert.deepEqual(broker._asked.map(a => a.broker), ['ctrader'])
})

test('no connected live broker → no venues, and nothing is asked', async () => {
    const broker = fakeBroker({ connections: { paper: true }, trading: new Set(['paper']) })
    const r = await checkBrokerSymbol('u1', 'AVGO', { broker, mapSymbol: identity })
    assert.deepEqual(r.venues, [])
})

test('a missing user or ticker answers empty rather than throwing', async () => {
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: true } })
    assert.deepEqual((await checkBrokerSymbol(null, 'AVGO', { broker })).venues, [])
    assert.deepEqual((await checkBrokerSymbol('u1', '',    { broker })).venues, [])
    assert.deepEqual((await checkBrokerSymbol('u1', null,  { broker })).venues, [])
})

test('a broken connections read degrades to empty, not an exception', async () => {
    const broker = fakeBroker({ connections: {} })
    broker.listConnections = async () => { throw new Error('db down') }
    const r = await checkBrokerSymbol('u1', 'AVGO', { broker, mapSymbol: identity })
    assert.deepEqual(r.venues, [])
})

// ─── The enforced half: availability rides along with every quote ──────────────

test('a quote on a live book carries broker availability without being asked', async () => {
    _clearAvailabilityCache()
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: false } })
    const out = await withBrokerAvailability({ price: 312.4 }, 'u1', 'AVGO', { broker, mapSymbol: identity })

    assert.equal(out.price, 312.4, 'the quote itself is untouched')
    assert.equal(out.broker_availability[0].tradable, false)
})

test('with no live venue the payload is returned untouched — nothing to enforce', async () => {
    _clearAvailabilityCache()
    const broker = fakeBroker({ connections: { paper: true }, trading: new Set(['paper']) })
    const quote = { price: 312.4 }
    const out = await withBrokerAvailability(quote, 'u1', 'AVGO', { broker, mapSymbol: identity })

    assert.deepEqual(out, quote)
    assert.equal('broker_availability' in out, false)
})

test('the check is cached per user+ticker, so riding on every quote is cheap', async () => {
    _clearAvailabilityCache()
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: true } })

    await withBrokerAvailability({ price: 1 }, 'u1', 'AVGO', { broker, mapSymbol: identity })
    await withBrokerAvailability({ price: 2 }, 'u1', 'avgo', { broker, mapSymbol: identity })   // case-insensitive
    assert.equal(broker._asked.length, 1, 'second read served from cache')

    await withBrokerAvailability({ price: 3 }, 'u1', 'NVDA', { broker, mapSymbol: identity })
    assert.equal(broker._asked.length, 2, 'a different ticker is a real read')

    await withBrokerAvailability({ price: 4 }, 'u2', 'AVGO', { broker, mapSymbol: identity })
    assert.equal(broker._asked.length, 3, 'cache is per user — never cross-user')
})

test('a failing availability check never takes the quote down with it', async () => {
    _clearAvailabilityCache()
    const broker = fakeBroker({ connections: { ctrader: true } })
    broker.listConnections = async () => { throw new Error('db down') }
    const out = await withBrokerAvailability({ price: 312.4 }, 'u1', 'AVGO', { broker, mapSymbol: identity })
    assert.deepEqual(out, { price: 312.4 })
})

// ─── THE REGRESSION: the enforced half never actually fired ───────────────────
// This block used to assert the opposite — "a non-object payload passes straight through" — written
// on the belief that a string payload meant a tool ERROR. But get_quote, the ONLY caller, returns a
// formatted STRING on success, so the early return swallowed every real quote and the rule that a
// desk "cannot discuss AVGO without being told whether AVGO is listed" never once ran.

test('a QUOTE (text, the real shape) comes back carrying availability', async () => {
    _clearAvailabilityCache()
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: true } })
    const quote = 'AVGO (Broadcom)\nPrice : $312.40'
    const out = await withBrokerAvailability(quote, 'u1', 'AVGO', { broker, mapSymbol: identity })

    assert.ok(out.startsWith(quote), 'the quote itself is untouched')
    assert.match(out, /At the user's live broker — ctrader: TRADABLE as AVGO\.cash/)
})

test('a quote for an instrument the broker does not list says so, on the quote', async () => {
    _clearAvailabilityCache()
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: false } })
    const out = await withBrokerAvailability('AVGO\nPrice : $312.40', 'u1', 'AVGO', { broker, mapSymbol: identity })
    assert.match(out, /ctrader: NOT LISTED/)
})

test('an unreachable broker rides along as UNKNOWN, never as "not listed"', async () => {
    // The third state has to survive this trip too — it is the whole reason the state exists.
    _clearAvailabilityCache()
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: 'throw' } })
    const out = await withBrokerAvailability('AVGO\nPrice : $312.40', 'u1', 'AVGO', { broker, mapSymbol: identity })
    assert.match(out, /ctrader: UNKNOWN/)
    assert.match(out, /NEVER as unavailable/)
    assert.doesNotMatch(out, /NOT LISTED/)
})

test('a FAILED call is never decorated — an error must not be dressed up as data', async () => {
    _clearAvailabilityCache()
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: true } })
    const err = toolError('Could not fetch quote for AVGO')
    assert.equal(await withBrokerAvailability(err, 'u1', 'AVGO', { broker, mapSymbol: identity }), err)
    assert.equal(await withBrokerAvailability(null, 'u1', 'AVGO', { broker }), null)
})

test('no userId (a monitor, not a chat) leaves the payload alone', async () => {
    _clearAvailabilityCache()
    const broker = fakeBroker({ connections: { ctrader: true }, resolve: { ctrader: true } })
    const out = await withBrokerAvailability({ price: 1 }, null, 'AVGO', { broker, mapSymbol: identity })
    assert.deepEqual(out, { price: 1 })
    assert.equal(broker._asked.length, 0)
})
