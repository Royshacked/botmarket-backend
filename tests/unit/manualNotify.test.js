import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entryLegFromIdea, exitLegFromIdea, _sender } from '../../services/manualNotify.service.js'
import { isBot } from '../../api/chat/chat.service.js'

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

// ── Attribution ─────────────────────────────────────────────────────────────
// These two cards are the shared PIPE for every desk's manual fills, so the sender is the
// caller's, never this module's. It used to be hardcoded `portfolioId ? 'portfolio' : 'idea'` —
// which meant a Talos setup and a Kairos call both announced their own fills as "Idea".

test('the caller\'s own botId wins outright', () => {
    assert.equal(_sender({ botId: 'mentor' }), 'mentor')
    assert.equal(_sender({ botId: 'kairos', kind: 'setup', portfolioId: 'p1' }), 'kairos')
})

test('a kind picks its desk — the regression: setups and calls are not Idea\'s', () => {
    assert.equal(_sender({ kind: 'setup' }), 'mentor')
    assert.equal(_sender({ kind: 'call' }),  'kairos')
    assert.equal(_sender({ kind: 'portfolio_item' }), 'portfolio')
})

test('a basket is Atlas\'s by construction, and everything else lands on Axl', () => {
    assert.equal(_sender({ portfolioId: 'p1' }), 'portfolio')
    assert.equal(_sender({}), 'axl', 'the Idea desk is retired — an unowned card must not post into a dead feed')
    assert.equal(_sender({ kind: 'idea' }), 'axl')
})

test('every sender this module can produce is a REGISTERED bot', () => {
    // postBotCard silently rewrites an unregistered sender to Axl, so a wrong id here would be
    // invisible rather than loud.
    for (const opts of [{}, { kind: 'setup' }, { kind: 'call' }, { kind: 'idea' }, { portfolioId: 'p' }]) {
        assert.ok(isBot(_sender(opts)), `${JSON.stringify(opts)} → '${_sender(opts)}' is not registered`)
    }
})
