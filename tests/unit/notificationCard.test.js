import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardActions, cardLifecycle, normalizeResolveStatus, isBot } from '../../api/chat/chat.service.js'
import { buildIdeaEntryConfirm, buildSetupEntryConfirm, buildCallReady, buildCallExpiry, buildCallManage, buildCallReentry } from '../../services/tradeNotify.service.js'
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
    const call = { id: 'c1', userId: 'u1', asset: 'AAPL', bias: 'long' }
    const cov  = { id: 'cov1', userId: 'u1', symbol: 'NVDA', price_target: { value: 200 } }

    for (const c of allCards()) {
        assert.ok(c.actions, `${c.type} should carry actions`)
        assert.equal(c.actions.dismiss, true, `${c.type} should offer dismiss`)
        assert.ok(c.actions.primary?.label, `${c.type} should have a primary "do something" label`)
    }
})

// Every card a builder emits, so a new producer is covered by the checks below the moment it is
// added to this list.
function allCards() {
    const idea  = { id: 'i1',  userId: 'u1', asset: 'NQ',   direction: 'long' }
    const setup = { id: 's1',  userId: 'u1', asset: 'AVGO', direction: 'long' }
    const call  = { id: 'c1',  userId: 'u1', asset: 'AAPL', bias: 'long' }
    const cov   = { id: 'cov1', userId: 'u1', symbol: 'NVDA', price_target: { value: 200 } }
    return [
        buildIdeaEntryConfirm(idea),
        buildSetupEntryConfirm(setup, { verdict: 'enter' }),
        buildCallReady(call, { proposal: { entry: 190, stop: 187 } }),
        buildCallExpiry(call, 'expired'),
        buildCallManage(call, { verdict: 'move_stop' }),
        buildCallReentry(call),
        buildCoverageEvent(cov, { state: 'target_hit' }),
    ]
}

// A card's botId decides which bot the social-chat message comes FROM. postBotCard does not
// reject an unregistered id — it silently falls back to Axl — so an unlisted agent doesn't error,
// it misattributes. That shipped: `mentor` was missing from BOT_IDS, so Talos's setup entry cards
// arrived from Axl. Assert every builder posts under a bot the registry actually knows.
test('every card builder posts under a REGISTERED bot (an unknown id silently becomes Axl)', () => {
    for (const c of allCards()) {
        assert.ok(c.botId, `${c.type} should name its authoring bot`)
        assert.ok(isBot(c.botId), `${c.type} posts as "${c.botId}" — not in BOT_IDS, so it would post as Axl`)
    }
})
