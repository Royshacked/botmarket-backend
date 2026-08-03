import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSetupEntryConfirm, buildSetupInvalidation } from '../../services/tradeNotify.service.js'

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

// ─── Invalidation cards ───────────────────────────────────────────────────────
// Four events, four messages. Merging them would produce copy that is wrong for three of the four:
// "you missed it" is not a problem to solve, and "the premise broke" is not an FYI.

test('a runaway says nothing was wrong, and asks for nothing', () => {
    const card = buildSetupInvalidation(SETUP, { card: 'ran_away', side: 'away', price: 247, edge: 'upper' })
    assert.match(card.content, /ran past 247/)
    assert.match(card.content, /Nothing was wrong with the read/)
    assert.equal(card.actions, undefined, 'a missed entry is not a task')
    assert.equal(card.payload.event, 'ran_away')
})

test('an invalidation offers the re-draw, and quotes the close', () => {
    const card = buildSetupInvalidation(SETUP, { card: 'invalidated', side: 'adverse', price: 233, edge: 'lower' })
    assert.match(card.content, /no longer valid/)
    assert.match(card.content, /closed at 233/)
    assert.ok(card.actions, 'revise means the user is being offered the re-draw')
})

test('notify_only tells without asking', () => {
    const card = buildSetupInvalidation(SETUP, { card: 'invalidated_fyi', side: 'adverse', price: 233, edge: 'lower' })
    assert.match(card.content, /Heads up/)
    assert.equal(card.actions, undefined, 'the user chose to be told, not asked')
})

test('a stale map leads with WHY, since that is the whole content of the offer', () => {
    const card = buildSetupInvalidation(SETUP, { card: 'stale_map', reason: 'the 238 shelf is now 242', edit_proposal: { why: 'x' } })
    assert.match(card.content, /the 238 shelf is now 242/)
    assert.ok(card.actions)
    assert.ok(card.payload.edit_proposal, 'the proposal rides along so the re-draw has somewhere to start')
})

// ─── Rival premises ───────────────────────────────────────────────────────────
// A setup can hold two ways in at different levels with different sizes. Copy that says "your NVDA
// setup" is ambiguous when one of them fired, and outright false when one of them died.

const RIVALS = {
    ...SETUP, armed_scenario_id: 's2',
    scenarios: [{ id: 's1', name: 'false break' }, { id: 's2', name: 'break and go' }],
}

test('the confirm names WHICH way in fired', () => {
    const card = buildSetupEntryConfirm(RIVALS, { verdict: 'enter', read: 'It broke.', scenario_id: 's2' })
    assert.match(card.content, /the break and go way in/)
    assert.equal(card.payload.scenario, 'break and go')
    assert.equal(card.payload.scenarioId, 's2')
})

test('a single-premise setup is never made to sound like it had a choice', () => {
    const one  = { ...SETUP, armed_scenario_id: 's1', scenarios: [{ id: 's1', name: 'false break' }] }
    const card = buildSetupEntryConfirm(one, { verdict: 'enter' })
    assert.doesNotMatch(card.content, /way in/)
    assert.equal(card.payload.scenario, 'false break', 'the payload still says which, for the dialog')
})

test('a breach names the premise and says what is still armed', () => {
    const card = buildSetupInvalidation(RIVALS, {
        card: 'invalidated', side: 'adverse', price: 233, edge: 'lower', scenario: 'false break', remaining: 1,
    })
    assert.match(card.content, /"false break" way into your LONG NVDA/)
    assert.match(card.content, /other scenario is still armed/)
    assert.doesNotMatch(card.content, /Want to re-draw it\?/, 'nothing to re-draw while a rival is live')
    assert.equal(card.payload.remaining, 1)
})

test('with nothing left standing the copy is about the setup again', () => {
    const card = buildSetupInvalidation(RIVALS, {
        card: 'invalidated', side: 'adverse', price: 233, edge: 'lower', scenario: 'break and go', remaining: 0,
    })
    assert.doesNotMatch(card.content, /still armed/)
    assert.match(card.content, /Want to re-draw it\?/)
})

test('every invalidation card is owner-scoped and routes to Mentor', () => {
    for (const kind of ['ran_away', 'invalidated', 'invalidated_fyi', 'stale_map']) {
        const card = buildSetupInvalidation(SETUP, { card: kind })
        assert.equal(card.userId, SETUP.userId, kind)
        assert.equal(card.botId, 'mentor', kind)
        assert.equal(card.payload.setupId, SETUP.id, kind)
    }
})
