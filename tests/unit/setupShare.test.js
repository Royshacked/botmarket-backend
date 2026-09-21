import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shareSetup, _setDeps, SETUP_SHARED_TYPE, SHARE_NOTE_MAX } from '../../api/setups/setupShare.service.js'
import { cardSubject, cardLifecycle } from '../../api/chat/chat.service.js'

// Sharing a setup = the sender's document, snapshotted as a blueprint, posted as a card into a DM.
// These pin what the card CARRIES and what it must never carry, with every reach (the owned read,
// price, chat, users) stubbed through the service's own seam.

const OWNED = {
    id: 'setup_NVDA_a1b2', userId: 'u_roy', kind: 'setup', status: 'looking', mode: 'live',
    broker: 'ctrader', brokerSymbol: 'US100', accounts: ['acc_1'], mainAccountId: 'acc_1',
    asset: 'NVDA', direction: 'long', type: 'swing', trade_mode: 'smc', timeframe: '1hr', entry_mode: 'limit',
    thesis: 'reclaim of the weekly shelf', rr: 3.2,
    conditions: [{ id: 'c1', text: 'holds above the 4hr VWAP', weight: 'primary', mode: 'measured', persistence: 'live' }],
    scenarios: [{
        id: 's1', name: 'the fade', quantity: 50,
        entry_zones: [{ id: 'e1', lower: 178, upper: 180, quantity: 50, note: 'Tuesday shelf' }],
        stop_zones:  [{ id: 's1s', lower: 173, upper: 174, quantity: 50 }],
        tp_zones:    [{ id: 't1', lower: 196, upper: 200, quantity: 50 }],
        conditions:  [],
    }],
    monitor_state: { conditions: { c1: { met: true } } },
    armed_scenario_id: 's1',
}

function harness({ doc = OWNED, price = 187.5, sender = { id: 'u_roy', username: 'roy', fullname: 'Roy' }, post } = {}) {
    const posted = []
    const restore = _setDeps({
        // The owned read in the crud's own shape — someone else's is `forbidden`, a missing one `not_found`.
        getSetup:  async (id, userId) => (!doc ? { ok: false, reason: 'not_found' } : doc.userId !== userId ? { ok: false, reason: 'forbidden' } : { ok: true, doc }),
        lastPrice: typeof price === 'function' ? price : async () => price,
        sender:    async () => sender,
        postCard:  post ?? (async (card) => { posted.push(card); return { ok: true, message: { id: 'msg_1', ...card } } }),
    })
    return { posted, restore }
}

test('the card carries the plan, the note, the price and who sent it — and nothing personal', async () => {
    const { posted, restore } = harness()
    try {
        const res = await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: 'conv_1', note: '  wait for the retest  ' })
        assert.equal(res.ok, true)
        assert.equal(posted.length, 1)
        const card = posted[0]

        assert.equal(card.conversationId, 'conv_1')
        assert.equal(card.senderId, 'u_roy')
        assert.equal(card.type, SETUP_SHARED_TYPE)
        assert.equal(card.content, 'wait for the retest', 'the note is the message line')
        assert.equal(card.payload.note, 'wait for the retest')
        assert.equal(card.payload.drawn_price, 187.5)
        assert.equal(card.payload.rr, 3.2)
        assert.equal(card.payload.source_setup_id, 'setup_NVDA_a1b2')
        assert.deepEqual(card.payload.blueprint.from, { userId: 'u_roy', username: 'roy', fullname: 'Roy' })
        assert.equal(card.payload.blueprint.asset, 'NVDA')
        assert.equal(card.payload.blueprint.entry_mode, 'limit')
        assert.equal(card.payload.blueprint.scenarios[0].entry_zones[0].note, 'Tuesday shelf')

        // The invariant: no size, no account, no workspace, no monitor state, anywhere in the card.
        const text = JSON.stringify(card.payload)
        for (const leaked of ['quantity', 'accounts', 'mainAccountId', 'broker', 'monitor_state', 'armed_scenario_id', '"status"', '"kind"']) {
            assert.equal(text.includes(leaked), false, `the card leaked ${leaked}`)
        }
        // `mode` is a condition's tag too (measured | judgment), so the WORKSPACE one is checked by key.
        assert.equal('mode' in card.payload.blueprint, false, 'the workspace mode must not travel')
        assert.equal('userId' in card.payload.blueprint, false, 'ownership is provenance (`from`), never a field')
    } finally { restore() }
})

test('the card resolves on OPEN and has no subject, so the sender’s later writes cannot close it', async () => {
    const { posted, restore } = harness()
    try {
        await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: 'conv_1' })
        const card = posted[0]
        assert.equal(card.actions.primary.label, 'Open in Mentor')
        assert.equal(card.actions.primary.resolvesOn, 'open')
        assert.equal(card.actions.dismiss, true)
        // `setupId` is a cardSubject key; `source_setup_id` deliberately is not.
        assert.equal('setupId' in card.payload, false)
        assert.equal(cardSubject(card.payload), null)
        assert.equal(cardLifecycle(card.actions, card.payload).subject, null)
    } finally { restore() }
})

test('no note → a default line; a long note is capped', async () => {
    const { posted, restore } = harness()
    try {
        await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: 'conv_1' })
        assert.equal(posted[0].content, 'Shared a NVDA long setup')
        assert.equal(posted[0].payload.note, null)

        await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: 'conv_1', note: 'x'.repeat(SHARE_NOTE_MAX + 50) })
        assert.equal(posted[1].payload.note.length, SHARE_NOTE_MAX)
        assert.equal(posted[1].content.length, SHARE_NOTE_MAX)
    } finally { restore() }
})

test('a failed price read never blocks the send', async () => {
    const { posted, restore } = harness({ price: async () => { throw new Error('quote down') } })
    try {
        const res = await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: 'conv_1' })
        assert.equal(res.ok, true)
        assert.equal(posted[0].payload.drawn_price, null)
    } finally { restore() }

    // A non-positive print is no print either — zero would read as "already broke every stop".
    const zero = harness({ price: 0 })
    try {
        await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: 'conv_1' })
        assert.equal(zero.posted[0].payload.drawn_price, null)
    } finally { zero.restore() }
})

test('a sender the users collection cannot find is still named by id', async () => {
    const { posted, restore } = harness({ sender: null })
    try {
        await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: 'conv_1' })
        assert.deepEqual(posted[0].payload.blueprint.from, { userId: 'u_roy', username: null, fullname: null })
    } finally { restore() }
})

test('only the owner can share it; someone else’s is forbidden, a missing one is not found', async () => {
    const theirs = harness({ doc: { ...OWNED, userId: 'u_marce' } })
    try {
        const res = await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: 'conv_1' })
        assert.deepEqual(res, { ok: false, reason: 'forbidden' })
        assert.equal(theirs.posted.length, 0, 'nothing may be posted for a refused share')
    } finally { theirs.restore() }

    const gone = harness({ doc: null })
    try {
        const res = await shareSetup('setup_nope', 'u_roy', { conversationId: 'conv_1' })
        assert.equal(res.ok, false)
        assert.equal(res.reason, 'not_found')
        assert.equal(gone.posted.length, 0)
    } finally { gone.restore() }
})

test('a missing conversation is refused before anything is read', async () => {
    const { posted, restore } = harness()
    try {
        for (const bad of [undefined, null, '', '   ', 42]) {
            const res = await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: bad })
            assert.deepEqual(res, { ok: false, reason: 'invalid_conversation' })
        }
        assert.equal(posted.length, 0)
    } finally { restore() }
})

test('the chat pipe’s refusal is passed through untouched', async () => {
    const { restore } = harness({ post: async () => ({ ok: false, reason: 'bot_recipient' }) })
    try {
        const res = await shareSetup('setup_NVDA_a1b2', 'u_roy', { conversationId: 'conv_axl' })
        assert.deepEqual(res, { ok: false, reason: 'bot_recipient' })
    } finally { restore() }
})
