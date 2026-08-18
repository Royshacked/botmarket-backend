import { test } from 'node:test'
import assert from 'node:assert/strict'
import { touchLeaf, routeExits } from '../../services/protectionPlan.service.js'
import { applyPriceLevels, ideaService } from '../../api/trade-ideas/tradeIdeas.service.js'
import { updateTradeIdea } from '../../api/trade-ideas/tradeIdeas.controller.js'
import { isRestingEntry, RESTING_ENTRY_TYPES } from '../../services/entity/vocabulary.js'
import { restingEntryPrice } from '../../api/trade-ideas/ideaExecution.service.js'

// The immediate-trade ticket states its levels as PRICES — that is the whole gesture. These tests
// cover the seam that turns a number into something the broker can rest, because every step of it
// is silent when it goes wrong: a leaf typed `structured` instead of `touch` doesn't error, it
// just quietly leaves the position unprotected on the software monitor.

// ── touchLeaf: the writer paired with the parser ──────────────────────────────

test('a bare price becomes a leaf that ROUTES to the broker, not to the monitor', async () => {
    // The round trip is the contract: what touchLeaf writes, routeExits must read back as a
    // native order. Asserting the string alone would pass even if the parser stopped agreeing.
    const route = await routeExits({
        direction: 'long', quantity: 10,
        stop_conditions: [touchLeaf(21500)],
        tp_conditions:   [touchLeaf(22000)],
    })
    assert.equal(route.stop.nativeOrders[0].level, 21500)
    assert.equal(route.tp.nativeOrders[0].level, 22000)
    assert.equal(route.stop.monitorTree, null, 'a bare price has no residual for the monitor')
})

test('the leaf is typed `touch` — the single source of truth for resting at the broker', () => {
    const leaf = touchLeaf(150.25)
    assert.equal(leaf.type, 'touch')
    assert.equal(leaf.timeframe, null, 'a price level is intra-candle; a timeframe would imply a close')
})

// The Kairos half of this pairing — that buildIdeaFromCall emits the SAME leaf as the ticket,
// rather than the private _touch copy it once carried — went to archive/tests with the desk on
// 2026-08-18. `touchLeaf` below is still the one builder; there is simply one caller fewer.

// ── applyPriceLevels: the numeric API the client actually uses ────────────────

test('a bare *_price expands into the leg the rest of the system reads', () => {
    const out = applyPriceLevels({ asset: 'AAPL', stop_price: 185.5, tp_price: 210 })
    assert.deepEqual(out.stop_conditions, [touchLeaf(185.5)])
    assert.deepEqual(out.tp_conditions,   [touchLeaf(210)])
    assert.equal(out.stop_price, undefined, 'the numeric field is consumed, never persisted')
    assert.equal(out.asset, 'AAPL', 'everything else passes through untouched')
})

test('authored conditions WIN over a stray price field', () => {
    // The agents and the chat build path send real conditions that say things a price cannot.
    // A price field arriving alongside them must never overwrite that.
    const authored = [{ condition: 'RSI closes below 30', type: 'structured' }]
    const out = applyPriceLevels({ stop_price: 100, stop_conditions: authored })
    assert.deepEqual(out.stop_conditions, authored)
})

test('null clears a leg; nonsense is ignored rather than persisted', () => {
    assert.deepEqual(applyPriceLevels({ stop_price: null }).stop_conditions, [])
    const junk = applyPriceLevels({ tp_price: 'soon' })
    assert.equal(junk.tp_conditions, undefined, 'a leg nothing can evaluate is worse than no leg')
    assert.equal(junk.tp_price, undefined)
})

test('the caller\'s request body is never mutated', () => {
    const body = { stop_price: 99 }
    applyPriceLevels(body)
    assert.equal(body.stop_price, 99)
    assert.equal(body.stop_conditions, undefined)
})

test('an absent leg is left alone — a stop edit must not wipe the target', () => {
    // handleTicketAttachExits sends ONE leg. If the other came back as [] the server would cancel
    // a target the user never touched.
    const out = applyPriceLevels({ stop_price: 185 })
    assert.equal(out.tp_conditions, undefined)
    assert.equal(out.entry_conditions, undefined)
})

// ── The route has to LET the price through ────────────────────────────────────
// applyPriceLevels is only reachable if the update whitelist keeps the numeric fields. It didn't,
// so a ticket that sent nothing but `tp_price` arrived as an empty patch and was refused with
// "Nothing to update" — a 400 on a request that was perfectly well formed. Every assertion above
// about the price → leaf expansion passed the whole time; the number never got that far.

/** Drive the controller with a stubbed service, and hand back what the route decided. */
async function callUpdate(body) {
    const sent = {}
    const res = {
        status(code) { sent.code = code; return this },
        send(payload) { sent.body = payload; sent.code ??= 200; return this },
    }
    const real = ideaService.updateIdea
    ideaService.updateIdea = async (id, patch) => { sent.patch = patch; return { ok: true, idea: { id } } }
    try {
        await updateTradeIdea({ params: { id: 'i1' }, body, user: { _id: 'u1' } }, res)
    } finally {
        ideaService.updateIdea = real
    }
    return sent
}

test('a target stated as a bare price reaches the service instead of being refused', async () => {
    const sent = await callUpdate({ tp_price: 210 })
    assert.equal(sent.code, 200, 'this used to be a 400 "Nothing to update"')
    assert.equal(sent.patch.tp_price, 210)
})

test('the stop leg travels the same road, and one leg alone is enough', async () => {
    const sent = await callUpdate({ stop_price: 185.5 })
    assert.equal(sent.code, 200)
    assert.equal(sent.patch.stop_price, 185.5)
    assert.equal(sent.patch.tp_price, undefined, 'the untouched leg is not invented by the route')
})

test('clearing a leg is an edit too — null must not read as nothing to update', async () => {
    // `null` is how the ticket REMOVES a stop; if the guard rejected it, a stop could be set
    // but never taken off.
    const sent = await callUpdate({ stop_price: null })
    assert.equal(sent.code, 200)
    assert.equal(sent.patch.stop_price, null)
})

test('the whitelist still holds — an unknown field is not smuggled in with a price', async () => {
    const sent = await callUpdate({ tp_price: 210, userId: 'someone-else', status: 'closed' })
    assert.equal(sent.patch.userId, undefined, 'ownership is not client-editable')
    assert.equal(sent.patch.status, 'closed', 'a field that IS editable still passes')
})

test('a body with nothing editable in it is still a 400', async () => {
    const sent = await callUpdate({ nonsense: 1 })
    assert.equal(sent.code, 400)
})

// ── Resting entry types ───────────────────────────────────────────────────────

test('both limit and stop rest at the broker; a monitored entry does not', () => {
    assert.equal(isRestingEntry('stop'), true)
    assert.equal(isRestingEntry('limit'), true, 'the pullback entry rests too — it is still just a level')
    assert.equal(isRestingEntry(null), false)
    assert.equal(isRestingEntry('market'), false, 'a market order has no level to leave anywhere')
    assert.equal(RESTING_ENTRY_TYPES.size, 2)
})

test('a resting entry carries the price field its own order type reads', () => {
    // The adapters read limitPrice for a limit and stopPrice for a stop, and IGNORE the other.
    // Sending the wrong one doesn't error — the order just arrives with no trigger, which is the
    // failure this mapping exists to prevent.
    assert.deepEqual(restingEntryPrice('limit', 21500), { limitPrice: 21500 })
    assert.deepEqual(restingEntryPrice('stop',  21500), { stopPrice:  21500 })
})

test('the resting price is the SHIFTED one — the basis offset is applied once, by the caller', () => {
    // Aliased index futures (NQ vs US100) live in two price spaces. The persisted trigger stays
    // the real level for display; only the order carries the shift, and it must not be applied
    // a second time here.
    const authored = 21500
    const offset   = 12.5
    assert.deepEqual(restingEntryPrice('stop', authored + offset), { stopPrice: 21512.5 })
})
