import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardActions, cardLifecycle, normalizeResolveStatus } from '../../api/chat/chat.service.js'
import { buildIdeaEntryConfirm, buildCallReady, buildCallExpiry, buildCallManage, buildCallReentry } from '../../services/tradeNotify.service.js'
import { buildCoverageEvent } from '../../services/coverageNotify.service.js'

// The unified card contract: "actionable" is a property of the MESSAGE (does it carry `actions`?),
// not the sender. cardActions() defines the one two-button rule (do-something + dismiss); cardLifecycle()
// derives the persisted { actions, status } from it — shared by user DMs and every agent card.

// ── cardActions: the one two-button rule ──────────────────────────────────────
test('cardActions: primary label + dismiss', () => {
    assert.deepEqual(cardActions('Confirm order'), { primary: { label: 'Confirm order' }, dismiss: true })
})

// ── cardLifecycle: actions → { actions, status } ──────────────────────────────
test('cardLifecycle: actions present → pending + carried through', () => {
    const a = cardActions('Review')
    assert.deepEqual(cardLifecycle(a), { actions: a, status: 'pending' })
})

test('cardLifecycle: no actions → inert (null actions + null status)', () => {
    assert.deepEqual(cardLifecycle(null),      { actions: null, status: null })
    assert.deepEqual(cardLifecycle(undefined), { actions: null, status: null })
    // a non-object (defensive) is treated as no actions, never a half-card
    assert.deepEqual(cardLifecycle('nope'),    { actions: null, status: null })
})

// ── normalizeResolveStatus: two terminal states only ──────────────────────────
test('normalizeResolveStatus: only done survives; everything else is dismissed', () => {
    assert.equal(normalizeResolveStatus('done'),      'done')
    assert.equal(normalizeResolveStatus('dismissed'), 'dismissed')
    assert.equal(normalizeResolveStatus('garbage'),   'dismissed')
    assert.equal(normalizeResolveStatus(undefined),   'dismissed')
    assert.equal(normalizeResolveStatus(null),        'dismissed')
})

// ── every producer card now carries the standard actions ──────────────────────
test('trade/coverage builders all emit the do/dismiss actions', () => {
    const idea = { id: 'i1', userId: 'u1', asset: 'NQ', direction: 'long' }
    const call = { id: 'c1', user_id: 'u1', asset: 'AAPL', bias: 'long' }
    const cov  = { id: 'cov1', user_id: 'u1', symbol: 'NVDA', price_target: { value: 200 } }

    const cards = [
        buildIdeaEntryConfirm(idea),
        buildCallReady(call, { proposal: { entry: 190, stop: 187 } }),
        buildCallExpiry(call, 'expired'),
        buildCallManage(call, { verdict: 'move_stop' }),
        buildCallReentry(call),
        buildCoverageEvent(cov, { state: 'target_hit' }),
    ]
    for (const c of cards) {
        assert.ok(c.actions, `${c.type} should carry actions`)
        assert.equal(c.actions.dismiss, true, `${c.type} should offer dismiss`)
        assert.ok(c.actions.primary?.label, `${c.type} should have a primary "do something" label`)
    }
})
