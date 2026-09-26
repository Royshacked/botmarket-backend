import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSetupEntryConfirm, buildSetupInvalidation } from '../../services/tradeNotify.service.js'

// The setup entry card. It fires ONLY on an `enter` verdict — a fulfilled setup, not merely a
// tripped zone (talos.monitor holds every other verdict at 'watching' and posts nothing). So the
// card is never hedged: there is no warning variant, because a declined setup never gets here.

const SETUP = { id: 'setup_NVDA_1', userId: 'u1', asset: 'NVDA', direction: 'long', armed_leg_id: 'ez1' }

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
    const card = buildSetupEntryConfirm(SETUP, { verdict: 'enter', read: 'Coiling under it.', leg_id: 'ez2' })
    assert.equal(card.payload.verdict, 'enter')
    assert.equal(card.payload.read, 'Coiling under it.')
    assert.equal(card.payload.legId, 'ez2', 'the assessment leg wins over the stored one')
})

test('the payload identifies the SETUP kind, so the confirm dialog routes correctly', () => {
    const card = buildSetupEntryConfirm(SETUP, null)
    assert.equal(card.payload.kind, 'setup')
    assert.equal(card.payload.setupId, 'setup_NVDA_1')
    assert.equal(card.type, 'entry_confirm')
    assert.equal(card.botId, 'mentor')
})

test('the leg falls back to the armed one when no assessment is attached', () => {
    assert.equal(buildSetupEntryConfirm(SETUP, null).payload.legId, 'ez1')
})

test('a card with no owner is built but carries a null userId for the poster to drop', () => {
    assert.equal(buildSetupEntryConfirm({ asset: 'NVDA' }, null).userId, null)
})

// ─── Invalidation cards ───────────────────────────────────────────────────────
// Five events, five messages. Merging them would produce copy that is wrong for four of the five:
// "you missed it and want another look" is not "you missed it and said you'd let it go", and neither
// of those is "the premise broke".

test('a runaway opens the plan back up, and says why now', () => {
    // Phase 4 of docs/design/mentor-challenge.md OVERTURNED this card's old contract, which was "asks
    // for nothing, because a chase is the user's own decision from a clean slate". The clean slate is
    // where FOMO lives: the honest outcomes are wait, a measured continuation, or close it, and the
    // user should not be triaging those alone while the move runs.
    const card = buildSetupInvalidation(SETUP, { card: 'ran_away', side: 'away', price: 247, edge: 'upper' })
    assert.match(card.content, /ran past 247/)
    assert.match(card.content, /read wasn't wrong/)
    assert.match(card.content, /while the move is live/)
    assert.equal(card.actions?.primary?.label, 'Re-draw with Mentor')
    assert.equal(card.payload.event, 'ran_away')
})

test('a runaway names the continuation worth looking at, from the way in that missed', () => {
    // A QUESTION, not a level: the card names an archetype, and the price for it gets measured in the
    // conversation off structure that has actually printed.
    const card = buildSetupInvalidation(SETUP, { card: 'ran_away', price: 247, archetype: 'sweep_reclaim' })
    assert.match(card.content, /off a sweep reclaim, the continuation to look at is the retest/)
    assert.equal(card.payload.archetype, 'sweep_reclaim')
})

test('a way in with no continuation says the level moved, and stops there', () => {
    // A `fade` that ran away is evidence for the OTHER direction — a different plan, not this one's
    // sibling. Offering one would walk the user into a reversal wearing the missed trade's label.
    const fade = buildSetupInvalidation(SETUP, { card: 'ran_away', price: 247, archetype: 'fade' })
    assert.match(fade.content, /measured rather than remembered/)
    assert.doesNotMatch(fade.content, /continuation to look at/)

    // Same copy when nothing was filed at all, so an older document degrades quietly.
    const bare = buildSetupInvalidation(SETUP, { card: 'ran_away', price: 247 })
    assert.match(bare.content, /measured rather than remembered/)
    assert.ok(bare.actions, 'the re-draw is still on offer')
})

test('`pass` is honoured: the user is told and asked nothing', () => {
    // They answered this exact question while the plan was being built. Re-asking it is the thing
    // `on_away: pass` exists to prevent.
    const card = buildSetupInvalidation(SETUP, { card: 'ran_away_fyi', side: 'away', price: 247, archetype: 'pullback' })
    assert.match(card.content, /ran past 247/)
    assert.match(card.content, /you said to let that one go/)
    assert.equal(card.actions, undefined, 'no primary, and nothing to clear')
    assert.doesNotMatch(card.content, /continuation to look at/, 'a pass does not get a suggestion')
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
    for (const kind of ['ran_away', 'ran_away_fyi', 'invalidated', 'invalidated_fyi', 'stale_map']) {
        const card = buildSetupInvalidation(SETUP, { card: kind })
        assert.equal(card.userId, SETUP.userId, kind)
        assert.equal(card.botId, 'mentor', kind)
        assert.equal(card.payload.setupId, SETUP.id, kind)
    }
})
