import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSetupEntryConfirm } from '../../services/tradeNotify.service.js'

// The setup entry card. It fires ONLY on an `enter` verdict — a fulfilled setup, not merely a
// tripped zone (talos.monitor holds every other verdict at 'watching' and posts nothing). So the
// card is never hedged: there is no warning variant, because a declined setup never gets here.

const SETUP = { id: 'setup_NVDA_1', userId: 'u1', asset: 'NVDA', direction: 'long', armed_zone_id: 'ez1' }

test('the copy says the SETUP is confirmed, not merely that price tagged a zone', () => {
    const card = buildSetupEntryConfirm(SETUP, { verdict: 'enter', read: 'Trigger is live.' })
    assert.match(card.content, /LONG NVDA setup is confirmed/)
    assert.match(card.content, /Confirm to place your order\./)
})

test('the card carries NO warning channel — a hedged confirm is what the gate exists to prevent', () => {
    // Even handed a warning (a stale assessment, a caller mistake), the copy must not turn into
    // "confirm anyway": reaching this builder already means Talos said enter.
    const card = buildSetupEntryConfirm(SETUP, {
        verdict: 'enter', warning: 'SMH is red while NVDA taps the zone.', read: 'Semis diverging.',
    })
    assert.doesNotMatch(card.content, /Talos flags/)
    assert.equal(card.payload.warning, undefined)
})

test('the verdict and read ride in the payload for the detail view', () => {
    const card = buildSetupEntryConfirm(SETUP, { verdict: 'enter', read: 'Coiling under it.', zone_id: 'ez2' })
    assert.equal(card.payload.verdict, 'enter')
    assert.equal(card.payload.read, 'Coiling under it.')
    assert.equal(card.payload.zoneId, 'ez2', 'the assessment zone wins over the stored one')
})

test('the payload identifies the SETUP kind, so the confirm dialog routes correctly', () => {
    const card = buildSetupEntryConfirm(SETUP, null)
    assert.equal(card.payload.kind, 'setup')
    assert.equal(card.payload.setupId, 'setup_NVDA_1')
    assert.equal(card.type, 'entry_confirm')
    assert.equal(card.botId, 'mentor')
})

test('the zone falls back to the armed one when no assessment is attached', () => {
    assert.equal(buildSetupEntryConfirm(SETUP, null).payload.zoneId, 'ez1')
})

test('a card with no owner is built but carries a null userId for the poster to drop', () => {
    assert.equal(buildSetupEntryConfirm({ asset: 'NVDA' }, null).userId, null)
})
