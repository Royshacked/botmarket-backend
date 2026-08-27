import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardActions, cardLifecycle, cardSubject, normalizeResolveStatus, isBot } from '../../api/chat/chat.service.js'
import { isScaffoldOnlyPatch } from '../../api/_shared/entityController.util.js'
import { buildIdeaEntryConfirm, buildSetupEntryConfirm, buildCallReady, buildCallExpiry, buildCallManage, buildCallReentry } from '../../services/tradeNotify.service.js'

// The unified card contract: "actionable" is a property of the MESSAGE (does it carry `actions`?),
// not the sender. cardActions() defines the one two-button rule (do-something + dismiss); cardLifecycle()
// derives the persisted { actions, status } from it — shared by user DMs and every agent card.

// ── cardActions: the one two-button rule ──────────────────────────────────────
test('cardActions: primary label + dismiss', () => {
    assert.deepEqual(cardActions('Confirm order'),
        { primary: { label: 'Confirm order', resolvesOn: 'work' }, dismiss: true })
})

// THE DEFAULT IS THE RULE. A card carrying actions is by definition asking for something, so
// anything that does not explicitly opt out stays alive until the work lands or it is dismissed.
// If this default ever flips, every unmarked card silently starts dying on navigation again.
test('cardActions: resolution defaults to `work`, and only `open` opts out', () => {
    assert.equal(cardActions('Review').primary.resolvesOn, 'work')
    assert.equal(cardActions('Get the brief', { resolvesOn: 'open' }).primary.resolvesOn, 'open')
    // A typo must not silently create a card that resolves itself.
    assert.equal(cardActions('X', { resolvesOn: 'opened' }).primary.resolvesOn, 'work')
    assert.equal(cardActions('X', { resolvesOn: null }).primary.resolvesOn,     'work')
})

// ── cardSubject: what the card is ABOUT ───────────────────────────────────────
test('cardSubject: derives the entity from the payload the card already carries', () => {
    assert.deepEqual(cardSubject({ coverageId: 'cov_1' }), { kind: 'coverage', id: 'cov_1' })
    assert.deepEqual(cardSubject({ setupId: 'stp_1' }),    { kind: 'setup',    id: 'stp_1' })
    assert.deepEqual(cardSubject({ callId: 'cal_1' }),     { kind: 'call',     id: 'cal_1' })
    assert.deepEqual(cardSubject({ ideaId: 'idea_1' }),    { kind: 'idea',     id: 'idea_1' })
})

test('cardSubject: a coverage refresh raised mid-review belongs to the REVIEW', () => {
    // It carries both ids and its ask is "resume the review", so the portfolio is what satisfies
    // it. Getting this backwards would leave the review card open after the review was finished.
    assert.deepEqual(cardSubject({ coverageId: 'cov_1', portfolioId: 'pf_1' }),
        { kind: 'portfolio', id: 'pf_1' })
})

test('cardSubject: no usable id → null, never a half-subject', () => {
    assert.equal(cardSubject(null),               null)
    assert.equal(cardSubject({}),                 null)
    assert.equal(cardSubject({ coverageId: '' }), null)
    assert.equal(cardSubject({ coverageId: 7 }),  null)   // an id we cannot match on is not an id
})

// ── cardLifecycle: actions → { actions, status, subject } ─────────────────────
test('cardLifecycle: actions present → pending + carried through', () => {
    const a = cardActions('Review')
    assert.deepEqual(cardLifecycle(a, { setupId: 'stp_9' }),
        { actions: a, status: 'pending', subject: { kind: 'setup', id: 'stp_9' } })
})

test('cardLifecycle: no actions → inert (null actions, status AND subject)', () => {
    // An inert message gets no subject either: without actions there is no lifecycle, so nothing
    // may supersede it and nothing may resolve it.
    const inert = { actions: null, status: null, subject: null }
    assert.deepEqual(cardLifecycle(null,      { setupId: 'stp_9' }), inert)
    assert.deepEqual(cardLifecycle(undefined, { setupId: 'stp_9' }), inert)
    // a non-object (defensive) is treated as no actions, never a half-card
    assert.deepEqual(cardLifecycle('nope',    { setupId: 'stp_9' }), inert)
})

// ── normalizeResolveStatus: two terminal states, plus a touch ─────────────────
test('normalizeResolveStatus: done and pending survive; everything else is dismissed', () => {
    assert.equal(normalizeResolveStatus('done'),      'done')
    assert.equal(normalizeResolveStatus('dismissed'), 'dismissed')
    // `pending` is not a resolution — it is "opened, still outstanding", and it has to be
    // expressible or the client's only word for "I opened it" is `done` again.
    assert.equal(normalizeResolveStatus('pending'),   'pending')
    assert.equal(normalizeResolveStatus('garbage'),   'dismissed')
    assert.equal(normalizeResolveStatus(undefined),   'dismissed')
    assert.equal(normalizeResolveStatus(null),        'dismissed')
})

// ── every producer card now carries the standard actions ──────────────────────
test('trade/coverage builders all emit the do/dismiss actions', () => {
    // Fixtures live in allCards() — it builds its own idea/setup/call/coverage inputs.
    for (const c of allCards()) {
        assert.ok(c.actions, `${c.type} should carry actions`)
        assert.equal(c.actions.dismiss, true, `${c.type} should offer dismiss`)
        assert.ok(c.actions.primary?.label, `${c.type} should have a primary "do something" label`)
    }
})

// ── What a patch has to CHANGE before it can close a card ─────────────────────
// The bug this pins, seen on a live run: a re-draw card sent the user to Mentor, Mentor saved the
// build conversation on the next turn (a PATCH carrying only `chat_state`), and the card that asked
// for the re-draw was marked done — by a write whose entire purpose is to NOT rewrite the plan.
// Meanwhile the actual re-draw goes through POST /generate and closed nothing at all.
test('a scaffolding-only patch is not the work — it cannot close a card', () => {
    assert.equal(isScaffoldOnlyPatch({ chat_state: { messages: [], draft: {} } }), true)
})

test('a patch that changed the ENTITY is the work, scaffolding riding along or not', () => {
    assert.equal(isScaffoldOnlyPatch({ status: 'looking' }), false)
    // Mixed: the plan moved. Scaffolding in the same body does not make it scaffolding.
    assert.equal(isScaffoldOnlyPatch({ status: 'looking', chat_state: {} }), false)
})

// An empty body is a no-op the service refuses (`nothing_to_patch`) before the resolve is reached.
// Reporting it as scaffolding-only would be a lie about a request that changed nothing at all —
// and would quietly make "resolve unless scaffolding" depend on a case that cannot occur.
test('an empty patch is not scaffolding-only', () => {
    assert.equal(isScaffoldOnlyPatch({}),        false)
    assert.equal(isScaffoldOnlyPatch(null),      false)
    assert.equal(isScaffoldOnlyPatch(undefined), false)
})

// Every card a builder emits, so a new producer is covered by the checks below the moment it is
// added to this list.
function allCards() {
    const idea  = { id: 'i1',  userId: 'u1', asset: 'NQ',   direction: 'long' }
    const setup = { id: 's1',  userId: 'u1', asset: 'AVGO', direction: 'long' }
    const call  = { id: 'c1',  userId: 'u1', asset: 'AAPL', bias: 'long' }
    return [
        buildIdeaEntryConfirm(idea),
        buildSetupEntryConfirm(setup, { verdict: 'enter' }),
        buildCallReady(call, { proposal: { entry: 190, stop: 187 } }),
        buildCallExpiry(call, 'expired'),
        buildCallManage(call, { verdict: 'move_stop' }),
        buildCallReentry(call),
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
