import { test } from 'node:test'
import assert from 'node:assert/strict'
import { touchLeaf, routeExits } from '../../services/protectionPlan.service.js'
import { applyPriceLevels, ideaService } from '../../api/trade-ideas/tradeIdeas.service.js'
import { updateTradeIdea } from '../../api/trade-ideas/tradeIdeas.controller.js'
import { isRestingEntry, RESTING_ENTRY_TYPES } from '../../services/entity/vocabulary.js'
import { restingEntryPrice } from '../../api/trade-ideas/ideaExecution.service.js'
import { resolveConditionTree, extractLeaves } from '../../services/conditionTree.service.js'

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

// ── A LADDER: several rungs on one leg ────────────────────────────────────────
// The pad can state more than one stop or target, each closing a slice. One field carries both
// shapes, because a ladder and a single level are the same claim ("where this leg comes off"),
// and every rung has to survive the same silent seam a single level does.

test('a ladder becomes one touch leaf per rung, in the order it was authored', () => {
    const out = applyPriceLevels({ tp_price: [{ price: 210, quantity: 60 }, { price: 225 }] })
    assert.deepEqual(out.tp_conditions, [touchLeaf(210, 60), touchLeaf(225)])
    assert.equal(out.tp_conditions[0].quantity, 60)
    assert.equal('quantity' in out.tp_conditions[1], false, 'an unsized rung says nothing about size')
})

test('a bare-number ladder is the same statement without the sizes', () => {
    assert.deepEqual(applyPriceLevels({ stop_price: [185.5, 182] }).stop_conditions, [touchLeaf(185.5), touchLeaf(182)])
})

test('an empty ladder clears the leg, exactly as null does', () => {
    // "These are my levels: none" and "remove this leg" are one sentence, not two.
    assert.deepEqual(applyPriceLevels({ stop_price: [] }).stop_conditions, [])
    assert.deepEqual(applyPriceLevels({ stop_price: null }).stop_conditions, [])
})

test('one unreadable rung does not take the good rungs down with it', () => {
    const out = applyPriceLevels({ tp_price: [210, 'soon', { price: 225 }] })
    assert.deepEqual(out.tp_conditions, [touchLeaf(210), touchLeaf(225)])
})

test('a ladder of nothing but nonsense leaves the leg alone rather than clearing it', () => {
    // Distinct from `[]`: the caller tried to say something and it could not be read, which is
    // not the same as saying there is no leg. Wiping a resting stop on a typo is the bad outcome.
    assert.equal(applyPriceLevels({ stop_price: ['soon'] }).stop_conditions, undefined)
})

test('every rung rests at the broker — none is quietly left on the monitor', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 100,
        ...applyPriceLevels({ tp_price: [{ price: 210, quantity: 60 }, { price: 225, quantity: 40 }] }),
    })
    assert.deepEqual(route.tp.nativeOrders, [{ level: 210, quantity: 60 }, { level: 225, quantity: 40 }])
    assert.equal(route.tp.monitorTree, null)
})

test('rungs that name no size split what is left of the position equally', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 100,
        ...applyPriceLevels({ tp_price: [{ price: 210, quantity: 60 }, 220, 230] }),
    })
    assert.deepEqual(route.tp.nativeOrders, [
        { level: 210, quantity: 60 },
        { level: 220, quantity: 20 },
        { level: 230, quantity: 20 },
    ])
})

// ── The quantity guard ────────────────────────────────────────────────────────
// A leg's rungs are alternatives that each close part of ONE position, so together they can ask
// for the position at most. Over-asking is not a rounding annoyance: on a hedging account the
// excess does not bounce off the broker, it OPENS a position the other way — a "protective" order
// that puts on risk. It has to be caught at allocation, because the reconciler's _resyncExits asks
// whether ONE order exceeds what remains, and three 50-lot stops behind 100 are each under it.

test('a leg can never ask the broker for more than the position', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 100,
        ...applyPriceLevels({ stop_price: [{ price: 95, quantity: 60 }, { price: 92, quantity: 60 }] }),
    })
    const total = route.stop.nativeOrders.reduce((s, o) => s + o.quantity, 0)
    assert.equal(total, 100, 'not 120 — the second rung is trimmed to what is left')
    assert.deepEqual(route.stop.nativeOrders, [{ level: 95, quantity: 60 }, { level: 92, quantity: 40 }])
})

test('a rung with nothing left for it is zeroed, and placeExits drops a zero', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 100,
        ...applyPriceLevels({ stop_price: [{ price: 95, quantity: 100 }, { price: 92, quantity: 50 }] }),
    })
    assert.deepEqual(route.stop.nativeOrders, [{ level: 95, quantity: 100 }, { level: 92, quantity: 0 }])
})

test('an over-asking leg is TRIMMED, never refused — a partial stop beats no stop', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 10,
        ...applyPriceLevels({ stop_price: [{ price: 95, quantity: 999 }] }),
    })
    assert.deepEqual(route.stop.nativeOrders, [{ level: 95, quantity: 10 }])
})

test('the two legs are capped independently — a stop does not eat the target\'s size', async () => {
    // They are alternatives to each other, not slices of one budget: the stop covers the whole
    // position and so does the target, and whichever fires first cancels the other.
    const route = await routeExits({
        direction: 'long', quantity: 100,
        ...applyPriceLevels({ stop_price: [{ price: 95, quantity: 100 }], tp_price: [{ price: 110, quantity: 100 }] }),
    })
    assert.equal(route.stop.nativeOrders[0].quantity, 100)
    assert.equal(route.tp.nativeOrders[0].quantity, 100)
})

test('a leg with no over-ask is untouched — the cap only ever bites when it must', async () => {
    const route = await routeExits({
        direction: 'long', quantity: 100,
        ...applyPriceLevels({ tp_price: [{ price: 210, quantity: 30 }, { price: 220, quantity: 30 }] }),
    })
    assert.deepEqual(route.tp.nativeOrders, [{ level: 210, quantity: 30 }, { level: 220, quantity: 30 }])
})

test('touchLeaf stamps a size only when there is one — 0 is not a slice', () => {
    assert.equal('quantity' in touchLeaf(100), false)
    assert.equal('quantity' in touchLeaf(100, 0), false)
    assert.equal('quantity' in touchLeaf(100, null), false)
    assert.equal(touchLeaf(100, 40).quantity, 40)
    assert.equal(touchLeaf(100, 40).type, 'touch', 'a sized rung is still a level the broker holds')
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

// ── The whole wire, as the pad rides it ──────────────────────────────────────
// `{ stop_price: 95 }` → applyPriceLevels → a `touch` leg → routeExits → a native order. Every
// hop is silent when it breaks, so this pins the chain rather than any one hop.

/** The routing the service performs between applyPriceLevels and execution, without a database. */
async function routeTicket(body) {
    const input = applyPriceLevels(body)
    const idea  = {
        asset: input.asset, direction: input.direction, quantity: input.quantity,
        stop_condition_tree: resolveConditionTree(input.stop_loss,   input.stop_conditions, input.stop_logic ?? 'OR'),
        tp_condition_tree:   resolveConditionTree(input.take_profit, input.tp_conditions,   input.tp_logic   ?? 'OR'),
    }
    idea.stop_conditions = extractLeaves(idea.stop_condition_tree)
    idea.tp_conditions   = extractLeaves(idea.tp_condition_tree)
    return routeExits(idea)
}

test('a market ticket\'s levels reach the broker at the size it is trading', async () => {
    const route = await routeTicket({ asset: 'AAPL', direction: 'long', quantity: 100, immediate: true, stop_price: 95, tp_price: 110 })
    assert.deepEqual(route.stop.nativeOrders, [{ level: 95,  quantity: 100 }])
    assert.deepEqual(route.tp.nativeOrders,   [{ level: 110, quantity: 100 }])
    assert.equal(route.stop.monitorTree, null, 'the broker holds the whole position')
})

test('a stop alone is routed, and the untouched leg stays empty rather than inventing one', async () => {
    const route = await routeTicket({ asset: 'AAPL', direction: 'long', quantity: 100, stop_price: 95 })
    assert.equal(route.stop.hasAny, true)
    assert.equal(route.tp.hasAny, false, 'a blank target box is no target, not a target at 0')
    assert.deepEqual(route.tp.nativeOrders, [])
})

test('a ticket with neither level routes to nothing — a naked entry stays possible', async () => {
    const route = await routeTicket({ asset: 'AAPL', direction: 'long', quantity: 100, immediate: true })
    // exitFields writes `nativeExit` only when a leg has orders; this is what keeps it absent.
    assert.equal(route.stop.nativeOrders.length + route.tp.nativeOrders.length, 0)
})

test('a resting-entry ticket routes its exits exactly like a market one', async () => {
    // The two paths place at different moments (inline on confirm vs on the fill event), but they
    // ask routeExits the same question — the entry type must not change the protection.
    const route = await routeTicket({
        asset: 'AAPL', direction: 'short', quantity: 50,
        entry_order_type: 'limit', entry_price: 105, stop_price: 110, tp_price: 90,
    })
    assert.deepEqual(route.stop.nativeOrders, [{ level: 110, quantity: 50 }])
    assert.deepEqual(route.tp.nativeOrders,   [{ level: 90,  quantity: 50 }])
})

// ── Taking a leg OFF ──────────────────────────────────────────────────────────
// `stop_price: null` is how the pad removes a stop. Both halves of the leg have to go: the flat
// list AND the tree. routeExits reads the TREE, so clearing only the list wrote a document that
// showed no stop while handing the broker back the order the user had just removed — and every
// later read disagreed with the broker from then on.

/** The leg-clearing step of updateIdea, in isolation: what the patch becomes before it is written. */
function clearingPatch(rawPatch) {
    const patch = applyPriceLevels(rawPatch)
    for (const [leg, defaultLogic] of [['entry', 'AND'], ['stop', 'OR'], ['tp', 'OR']]) {
        const condKey = `${leg}_conditions`
        const treeKey = `${leg}_condition_tree`
        const tree    = resolveConditionTree(patch[treeKey], patch[condKey], patch[`${leg}_logic`] ?? defaultLogic)
        if (tree) { patch[treeKey] = tree; patch[condKey] = extractLeaves(tree) }
        else if (Array.isArray(patch[condKey]) && patch[condKey].length === 0) patch[treeKey] = null
    }
    return patch
}

test('clearing a stop empties BOTH the list and the tree', () => {
    const patch = clearingPatch({ stop_price: null })
    assert.deepEqual(patch.stop_conditions, [])
    assert.equal(patch.stop_condition_tree, null, 'the tree is what routeExits reads')
})

test('a cleared leg routes to nothing, so nothing is re-placed at the broker', async () => {
    const live  = { direction: 'long', quantity: 100, ...applyPriceLevels({ stop_price: 95 }) }
    const before = await routeExits({ ...live, stop_condition_tree: resolveConditionTree(null, live.stop_conditions, 'OR') })
    assert.equal(before.stop.nativeOrders.length, 1, 'it was there to begin with')

    // The merge updateIdea performs: the live document with the clearing patch over it.
    const merged = { ...live, stop_condition_tree: resolveConditionTree(null, live.stop_conditions, 'OR'), ...clearingPatch({ stop_price: null }) }
    const after  = await routeExits(merged)
    assert.deepEqual(after.stop.nativeOrders, [], 'the stop the user removed does not come back')
    assert.equal(after.stop.hasAny, false)
})

test('clearing ONE leg leaves the other exactly where it was', () => {
    const patch = clearingPatch({ stop_price: null })
    assert.equal(patch.tp_conditions, undefined, 'an untouched leg is never emptied')
    assert.equal(patch.tp_condition_tree, undefined)
    assert.equal(patch.entry_condition_tree, undefined, 'and the entry is not collateral')
})

test('a leg being SET still resolves its tree as before', () => {
    const patch = clearingPatch({ stop_price: [95, 92] })
    assert.equal(patch.stop_conditions.length, 2)
    assert.equal(patch.stop_condition_tree.operator, 'OR')
    assert.equal(patch.stop_condition_tree.children.length, 2)
})
