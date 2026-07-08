import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entryLegFromIdea, exitLegFromIdea } from '../../services/manualNotify.service.js'

// The FillCard's per-leg meta is built from an idea doc. entry legs carry the planned size
// (editable qty input); exit legs carry the open position to close.

test('entryLegFromIdea: maps id/asset/direction/quantity', () => {
    const leg = entryLegFromIdea({ id: 'i1', asset: 'AAPL', direction: 'long', quantity: 100 })
    assert.deepEqual(leg, { ideaId: 'i1', asset: 'AAPL', direction: 'long', quantity: 100 })
})

test('entryLegFromIdea: missing quantity → null', () => {
    const leg = entryLegFromIdea({ id: 'i1', asset: 'AAPL', direction: 'short' })
    assert.equal(leg.quantity, null)
})

test('exitLegFromIdea: picks the linked positionId from brokerOrders', () => {
    const idea = {
        id: 'i1', asset: 'NVDA', direction: 'long', quantity: 40,
        brokerOrders: [{ broker: 'manual', accountId: 'manual-u-1', positionId: 'pos-9', quantity: 40 }],
    }
    assert.deepEqual(exitLegFromIdea(idea), {
        ideaId: 'i1', asset: 'NVDA', direction: 'long', positionId: 'pos-9', quantity: 40,
    })
})

test('exitLegFromIdea: no linked position → positionId null', () => {
    const idea = { id: 'i1', asset: 'NVDA', direction: 'long', brokerOrders: [{ positionId: null }] }
    assert.equal(exitLegFromIdea(idea).positionId, null)
})

test('exitLegFromIdea: missing brokerOrders → positionId null (no throw)', () => {
    assert.equal(exitLegFromIdea({ id: 'i1', asset: 'X', direction: 'short' }).positionId, null)
})
