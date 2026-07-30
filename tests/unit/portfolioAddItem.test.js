import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _addItem } from '../../api/portfolio/portfolioRebalance.service.js'

// An accepted review's `add_item` must not park as a 'waiting' doc — it has to come back as an
// order the user confirms. These cover the sizing (weight → share count off the book's value),
// the immediate/market path, the conditional-add arm, and the manual (broker-less) branch.

// Fake db: the sibling holdings for find().toArray(), recording updateOne calls.
function fakeDb(siblings = []) {
    const updates = []
    return {
        _updates: updates,
        collection: () => ({
            find:      () => ({ toArray: async () => siblings }),
            updateOne: async (q, u) => { updates.push({ q, u }) },
        }),
    }
}

const sibling = (over = {}) => ({
    id: 's1', portfolioName: 'Core', accounts: ['a1', 'a2'], mainAccountId: 'a1', broker: 'ctrader', ...over,
})

// Fake ideaService.saveIdea: records the spec it was handed, answers with the doc(s) it would have
// inserted. `status`/`orderState` mimic what saveIdea's immediate path produces.
function fakeSave({ status = 'hit', orderState = 'awaiting_confirm', legs = 1, ok = true } = {}) {
    const calls = []
    const save = async (spec, userId) => {
        calls.push({ spec, userId })
        if (!ok) return { ok: false }
        const ideas = Array.from({ length: legs }, (_, i) => ({
            id: `new-${i + 1}`, asset: spec.asset, quantity: spec.quantity ?? null,
            status, orderState,
            ...(orderState ? { pendingOrder: { plan: [{ broker: 'ctrader', accountId: 'a1', quantity: spec.quantity, type: 'market' }] } } : {}),
        }))
        return { ok: true, idea: ideas[0], ideas }
    }
    save._calls = calls
    return save
}

function fakeUpdate() {
    const calls = []
    const update = async (id, patch, userId) => { calls.push({ id, patch, userId }); return { ok: true } }
    update._calls = calls
    return update
}

const quoteAt = (price) => {
    const q = async (asset) => { q._asked.push(asset); return { price } }
    q._asked = []
    return q
}

const SPEC = { asset: 'AVGO', direction: 'long', type: 'swing', allocationRatio: 0.2, notes: 'thesis' }

test('rejects a spec with no asset', async () => {
    const r = await _addItem(fakeDb(), 'p1', 'u1', { allocationRatio: 0.2 }, 100000)
    assert.deepEqual(r, { ok: false, reason: 'no_asset' })
})

test('sizes the weight off the book value and hands the item to the confirm dialog', async () => {
    const db = fakeDb([sibling()])
    const saveItem = fakeSave()
    const quote = quoteAt(200)
    // 100_000 × 0.2 / 200 = 100 shares
    const r = await _addItem(db, 'p1', 'u1', SPEC, 100000, { saveItem, updateItem: fakeUpdate(), quote })

    assert.equal(r.ok, true)
    assert.equal(r.itemId, 'new-1')
    assert.equal(r.awaitingConfirm, true)
    assert.equal(r.armed, false)
    assert.equal(r.planned, true)
    assert.equal(r.unsized, false)

    const { spec } = saveItem._calls[0]
    assert.equal(spec.quantity, 100)
    assert.equal(spec.immediate, true)                 // → saveIdea builds the plan + 'hit'
    assert.deepEqual(spec.accounts, ['a1', 'a2'])      // execution binding inherited from the book
    assert.equal(spec.mainAccountId, 'a1')
    assert.equal(spec.portfolioName, 'Core')
    assert.equal(spec.portfolioId, 'p1')
    assert.deepEqual(quote._asked, ['AVGO'])
})

test('an explicit quantity wins and no quote is fetched', async () => {
    const saveItem = fakeSave()
    const quote = quoteAt(200)
    const r = await _addItem(fakeDb([sibling()]), 'p1', 'u1', { ...SPEC, quantity: 7 }, 100000, { saveItem, updateItem: fakeUpdate(), quote })

    assert.equal(r.ok, true)
    assert.equal(saveItem._calls[0].spec.quantity, 7)
    assert.deepEqual(quote._asked, [])
})

test('a sub-1 size rounds up to one share (mirrors _sizePlan)', async () => {
    const saveItem = fakeSave()
    // 1000 × 0.01 / 200 = 0.05
    await _addItem(fakeDb([sibling()]), 'p1', 'u1', { ...SPEC, allocationRatio: 0.01 }, 1000, { saveItem, updateItem: fakeUpdate(), quote: quoteAt(200) })
    assert.equal(saveItem._calls[0].spec.quantity, 1)
})

test('no book value → the holding is recorded unsized rather than given an invented size', async () => {
    const saveItem = fakeSave()
    const quote = quoteAt(200)
    const r = await _addItem(fakeDb([sibling()]), 'p1', 'u1', SPEC, null, { saveItem, updateItem: fakeUpdate(), quote })

    assert.equal(r.ok, true)
    assert.equal(r.unsized, true)
    assert.equal('quantity' in saveItem._calls[0].spec, false)
    assert.deepEqual(quote._asked, [])   // nothing to size against, so no quote burned
})

test('a failed price fetch leaves it unsized but still saved', async () => {
    const saveItem = fakeSave()
    const quote = async () => { throw new Error('quote provider down') }
    const r = await _addItem(fakeDb([sibling()]), 'p1', 'u1', SPEC, 100000, { saveItem, updateItem: fakeUpdate(), quote })

    assert.equal(r.ok, true)
    assert.equal(r.unsized, true)
    assert.equal('quantity' in saveItem._calls[0].spec, false)
})

test('a zero/absent price is not divided by', async () => {
    const saveItem = fakeSave()
    const r = await _addItem(fakeDb([sibling()]), 'p1', 'u1', SPEC, 100000, { saveItem, updateItem: fakeUpdate(), quote: quoteAt(0) })
    assert.equal(r.unsized, true)
    assert.equal('quantity' in saveItem._calls[0].spec, false)
})

test('a conditional add is ARMED, not parked as waiting', async () => {
    // saveIdea refuses the immediate path when the spec carries gating entry conditions → 'waiting'.
    const saveItem   = fakeSave({ status: 'waiting', orderState: null })
    const updateItem = fakeUpdate()
    const r = await _addItem(fakeDb([sibling()]), 'p1', 'u1',
        { ...SPEC, entry_conditions: [{ condition: 'price breaks above 150' }] }, 100000,
        { saveItem, updateItem, quote: quoteAt(200) })

    assert.equal(r.ok, true)
    assert.equal(r.armed, true)
    assert.equal(r.awaitingConfirm, false)
    assert.deepEqual(updateItem._calls, [{ id: 'new-1', patch: { status: 'looking' }, userId: 'u1' }])
})

test('a forked (multi-broker) book reports every leg and arms them all', async () => {
    const saveItem   = fakeSave({ status: 'waiting', orderState: null, legs: 2 })
    const updateItem = fakeUpdate()
    const r = await _addItem(fakeDb([sibling()]), 'p1', 'u1', SPEC, 100000, { saveItem, updateItem, quote: quoteAt(200) })

    assert.deepEqual(r.itemIds, ['new-1', 'new-2'])
    assert.equal(updateItem._calls.length, 2)
})

test('manual book: no order plan — the leg awaits the user reported fill', async () => {
    const db = fakeDb([sibling({ broker: 'manual' })])
    const saveItem = fakeSave({ status: 'waiting', orderState: null })
    const updateItem = fakeUpdate()
    const r = await _addItem(db, 'p1', 'u1', SPEC, 100000, { saveItem, updateItem, quote: quoteAt(200) })

    assert.equal(r.ok, true)
    assert.equal(r.manual, true)
    assert.equal(saveItem._calls[0].spec.immediate, false)   // never plan against a manual book
    assert.deepEqual(updateItem._calls, [])                  // and never arm it either

    const set = db._updates.find(u => u.u.$set)
    assert.equal(set.q.id, 'new-1')
    assert.equal(set.u.$set.status, 'hit')
    assert.equal(set.u.$set.orderState, 'awaiting_manual_fill')
    assert.ok(set.u.$set.entryTriggeredAt > 0)

    // The leg applyRebalance folds into the one entry Fill card.
    assert.equal(r.manualEntryLeg.ideaId, 'new-1')
    assert.equal(r.manualEntryLeg.asset, 'AVGO')
    assert.equal(r.manualEntryLeg.quantity, 100)
})

test('a book with no siblings still records the holding, with no execution binding', async () => {
    const saveItem = fakeSave({ orderState: null })
    const r = await _addItem(fakeDb([]), 'p1', 'u1', SPEC, 100000, { saveItem, updateItem: fakeUpdate(), quote: quoteAt(200) })

    assert.equal(r.ok, true)
    assert.deepEqual(saveItem._calls[0].spec.accounts, [])
    assert.equal(saveItem._calls[0].spec.mainAccountId, null)
    assert.equal(r.planned, false)        // nothing to confirm — say so
    assert.equal(r.awaitingConfirm, false)
})

test('a spec carrying its own immediate flag cannot make a manual book build a plan', async () => {
    const saveItem = fakeSave({ status: 'waiting', orderState: null })
    await _addItem(fakeDb([sibling({ broker: 'manual' })]), 'p1', 'u1', { ...SPEC, immediate: true }, 100000,
        { saveItem, updateItem: fakeUpdate(), quote: quoteAt(200) })
    assert.equal(saveItem._calls[0].spec.immediate, false)
})

test('refuses to open a second position in a name the book already holds', async () => {
    const saveItem = fakeSave()
    const r = await _addItem(fakeDb([sibling({ asset: 'AVGO', direction: 'long', status: 'long' })]), 'p1', 'u1', SPEC, 100000,
        { saveItem, updateItem: fakeUpdate(), quote: quoteAt(200) })

    assert.deepEqual(r, { ok: false, reason: 'already_held_use_add_to_item' })
    assert.equal(saveItem._calls.length, 0)   // nothing written, nothing ordered
})

test('the duplicate guard matches on case and direction, and ignores closed holdings', async () => {
    const held = (over) => sibling({ asset: 'AVGO', direction: 'long', status: 'long', ...over })

    // Same name, lower case → still a duplicate.
    let r = await _addItem(fakeDb([held({ asset: 'avgo' })]), 'p1', 'u1', SPEC, 100000,
        { saveItem: fakeSave(), updateItem: fakeUpdate(), quote: quoteAt(200) })
    assert.equal(r.reason, 'already_held_use_add_to_item')

    // Opposite side is a different exposure → allowed.
    r = await _addItem(fakeDb([held()]), 'p1', 'u1', { ...SPEC, direction: 'short' }, 100000,
        { saveItem: fakeSave(), updateItem: fakeUpdate(), quote: quoteAt(200) })
    assert.equal(r.ok, true)

    // The book has been out of the name → re-entering is a legitimate add.
    r = await _addItem(fakeDb([held({ status: 'closed' })]), 'p1', 'u1', SPEC, 100000,
        { saveItem: fakeSave(), updateItem: fakeUpdate(), quote: quoteAt(200) })
    assert.equal(r.ok, true)
})

test('a failed save reports save_failed', async () => {
    const r = await _addItem(fakeDb([sibling()]), 'p1', 'u1', SPEC, 100000,
        { saveItem: fakeSave({ ok: false }), updateItem: fakeUpdate(), quote: quoteAt(200) })
    assert.deepEqual(r, { ok: false, reason: 'save_failed' })
})
