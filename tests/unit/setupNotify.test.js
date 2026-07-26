import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSetupEntryConfirm } from '../../services/tradeNotify.service.js'

// The setup entry card. Talos advises but never vetoes, so this card fires on ANY verdict — which
// makes the warning the only thing standing between a flagged setup and a one-click confirm. If it
// isn't in the visible copy, it may as well not exist.

const SETUP = { id: 'setup_NVDA_1', userId: 'u1', asset: 'NVDA', direction: 'long', armed_zone_id: 'ez1' }

test('a clean entry reads as a plain confirm', () => {
    const card = buildSetupEntryConfirm(SETUP, { verdict: 'enter', warning: null, read: 'Trigger is live.' })
    assert.match(card.content, /Price reached your zone — LONG NVDA\./)
    assert.match(card.content, /Confirm to place your order\./)
    assert.equal(card.payload.warning, null)
})

test("a flagged entry LEADS with the warning — the user sees it before the button", () => {
    const card = buildSetupEntryConfirm(SETUP, {
        verdict: 'stand_aside', warning: 'SMH is red while NVDA taps the zone.', read: 'Semis diverging.',
    })
    assert.match(card.content, /Talos flags: SMH is red while NVDA taps the zone\./)
    // The warning must appear before the call to action, not trail after it.
    assert.ok(card.content.indexOf('SMH is red') < card.content.indexOf('Confirm to place'))
})

test('the verdict and read ride in the payload for the detail view', () => {
    const card = buildSetupEntryConfirm(SETUP, { verdict: 'wait', warning: 'No reclaim yet.', read: 'Coiling under it.', zone_id: 'ez2' })
    assert.equal(card.payload.verdict, 'wait')
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
