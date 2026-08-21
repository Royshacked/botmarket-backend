import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _buildReceipt } from '../../services/rebalanceNotify.service.js'
import { isBot } from '../../api/chat/chat.service.js'

// The receipt for an accepted portfolio review — the record that did not exist until 2026-08-21.
// The bug it closes: a review that trimmed AVGO and scaled into MU on a paper book left NOTHING
// behind but a toast, so once the toast was gone the user could not tell whether it had happened.

const applied = (action, asset, over = {}) => ({ action, asset, itemId: `${asset}-1`, ok: true, ...over })

test('names every applied move — the whole point of the card', () => {
    const card = _buildReceipt('u1', {
        portfolioId: 'p1', portfolioName: 'Growth',
        results: [applied('trim_item', 'AVGO'), applied('add_to_item', 'MU')],
    })
    assert.equal(card.content, 'Review applied on "Growth" — I trimmed AVGO and added to MU.')
    assert.equal(card.type, 'portfolio_rebalanced')
    assert.equal(card.userId, 'u1')
    assert.deepEqual(card.payload.applied.map(a => a.asset), ['AVGO', 'MU'])
})

test('the sender is Atlas, and Atlas is a registered bot', () => {
    const card = _buildReceipt('u1', { portfolioId: 'p1', results: [applied('trim_item', 'AVGO')] })
    assert.equal(card.botId, 'portfolio')
    assert.ok(isBot(card.botId), 'a card from an unregistered bot posts into a dead feed')
})

test('three or more moves read as a list, not a comma jam', () => {
    const card = _buildReceipt('u1', {
        portfolioId: 'p1', portfolioName: 'Growth',
        results: [applied('trim_item', 'AVGO'), applied('exit_item', 'XLU'), applied('update_item', 'MSFT')],
    })
    assert.equal(card.content, 'Review applied on "Growth" — I trimmed AVGO, exited XLU and updated MSFT.')
})

test('an unnamed book still gets a sentence', () => {
    const card = _buildReceipt('u1', { portfolioId: 'p1', results: [applied('trim_item', 'AVGO')] })
    assert.equal(card.content, 'Review applied on your portfolio — I trimmed AVGO.')
})

// ── The failed bucket ────────────────────────────────────────────────────────
// The half a toast is too small to carry. The EME scale-in the paper venue refused for want of a
// price reached the user as a bare "1 change couldn't be applied", with no asset and no reason.

test('a failure names the asset AND the reason', () => {
    const card = _buildReceipt('u1', {
        portfolioId: 'p1', portfolioName: 'Growth',
        results: [
            applied('trim_item', 'REGN'),
            { action: 'add_to_item', asset: 'EME', itemId: 'e1', ok: false, reason: 'broker_rejected' },
        ],
    })
    assert.match(card.content, /I trimmed REGN; couldn't add to EME \(the venue rejected it\)/)
    assert.deepEqual(card.payload.failed, [
        { action: 'add_to_item', itemId: 'e1', asset: 'EME', reason: 'broker_rejected' },
    ])
})

test('a thrown change reports its error text rather than a bare "failed"', () => {
    const card = _buildReceipt('u1', {
        portfolioId: 'p1',
        results: [{ action: 'exit_item', asset: 'X', itemId: 'x1', ok: false, error: 'boom' }],
    })
    assert.match(card.content, /\(boom\)/)
    assert.equal(card.payload.failed[0].reason, 'boom')
})

// ── The queued bucket ────────────────────────────────────────────────────────
// Three outcomes, not two. A change the shut market parked is neither applied nor failed, and
// counting it as either is the exact lie the applyRebalance buckets exist to prevent.

test('queued moves are reported as queued, not applied', () => {
    const card = _buildReceipt('u1', {
        portfolioId: 'p1', portfolioName: 'Growth',
        results: [{ action: 'trim_item', asset: 'AVGO', itemId: 'a1', ok: true, deferred: true, queuedId: 'q1' }],
    })
    assert.match(card.content, /trim AVGO — queued for the open/,
        'a queued change has not happened — reporting it in the past tense is the lie the buckets exist to prevent')
    assert.equal(card.payload.applied.length, 0)
    assert.deepEqual(card.payload.queued, [{ action: 'trim_item', itemId: 'a1', asset: 'AVGO', queuedId: 'q1' }])
})

test('a LOST queue write is a failure, never a queued row', () => {
    // `deferred && ok:false` is a decision whose queue write failed — there is no row to go and
    // look at, so a card that said "queued for the open" would point at nothing.
    const card = _buildReceipt('u1', {
        portfolioId: 'p1',
        results: [{ action: 'trim_item', asset: 'AVGO', itemId: 'a1', ok: false, deferred: true, reason: 'queue_failed' }],
    })
    assert.equal(card.payload.queued.length, 0)
    assert.equal(card.payload.failed.length, 1)
})

// ── Manual books ─────────────────────────────────────────────────────────────

test('manual legs are excluded — manualNotify already sent them a Fill card', () => {
    const card = _buildReceipt('u1', {
        portfolioId: 'p1',
        results: [{ action: 'exit_item', asset: 'AAPL', itemId: 'a1', ok: true, manual: true }],
    })
    assert.equal(card, null, 'a manual-only review must not be reported twice')
})

test('a MIXED book reports only its non-manual half', () => {
    const card = _buildReceipt('u1', {
        portfolioId: 'p1', portfolioName: 'Mixed',
        results: [
            { action: 'exit_item', asset: 'AAPL', itemId: 'a1', ok: true, manual: true },
            applied('trim_item', 'AVGO'),
        ],
    })
    assert.equal(card.content, 'Review applied on "Mixed" — I trimmed AVGO.')
    assert.deepEqual(card.payload.applied.map(a => a.asset), ['AVGO'])
})

// ── Degenerate input ─────────────────────────────────────────────────────────

test('no user, no results, or an empty set → no card', () => {
    assert.equal(_buildReceipt(null, { portfolioId: 'p1', results: [applied('trim_item', 'A')] }), null)
    assert.equal(_buildReceipt('u1', { portfolioId: 'p1', results: [] }), null)
    assert.equal(_buildReceipt('u1', { portfolioId: 'p1' }), null)
    assert.equal(_buildReceipt('u1', { portfolioId: 'p1', results: null }), null)
})

test('a null entry in results does not throw', () => {
    const card = _buildReceipt('u1', { portfolioId: 'p1', results: [null, applied('trim_item', 'AVGO')] })
    assert.match(card.content, /trimmed AVGO/)
})

test('an unresolved asset degrades to a phrase rather than "undefined"', () => {
    const card = _buildReceipt('u1', {
        portfolioId: 'p1',
        results: [{ action: 'trim_item', asset: null, itemId: 'a1', ok: true }],
    })
    assert.equal(card.content, 'Review applied on your portfolio — I trimmed a holding.')
})
