import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import webPush from 'web-push'
import { _deps, notificationForMessage, isValidSubscription, pushToUser, addSubscription, removeSubscription, normalizePublicKey, isEnabled } from '../../services/push.service.js'

// Web push is the second delivery of a chat message. The rules these tests hold:
//   - the notification is the CARD's copy under the DESK's name — nothing is authored here
//   - a tap lands on that message, like the in-app toast does
//   - a dead subscription is dropped, a flaky one is kept, and NOTHING here ever throws

// A real key pair: setVapidDetails validates the format, so a placeholder string would fail
// for the wrong reason.
const KEYS = webPush.generateVAPIDKeys()
beforeEach(() => {
    process.env.VAPID_PUBLIC_KEY  = KEYS.publicKey
    process.env.VAPID_PRIVATE_KEY = KEYS.privateKey
})

const SUB = (n) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } })

/** A users collection holding one user, recording the $pull that drops dead endpoints. */
function fakeDb(subs) {
    const calls = { pulled: [], pulledEverywhere: [], updateOne: [] }
    const db = {
        collection: () => ({
            findOne: async () => ({ id: 'u1', pushSubscriptions: subs }),
            updateOne: async (q, update) => { calls.updateOne.push(update); calls.pulled.push(update.$pull?.pushSubscriptions?.endpoint ?? null); return { modifiedCount: 1 } },
            updateMany: async (q) => { calls.pulledEverywhere.push(q['pushSubscriptions.endpoint']); return { modifiedCount: 0 } },
            findOneAndUpdate: async () => ({ pushSubscriptions: subs }),
        }),
    }
    return { db, calls }
}

// ── the notification ──────────────────────────────────────────────────────────

test('a bot card is titled by the desk, bodied by the card, and opens on the message', () => {
    const n = notificationForMessage(
        { id: 'm1', conversationId: 'c1', senderId: 'mentor', content: 'Your LONG NVDA setup is confirmed — price reached the zone.', payload: { setupId: 's1' } },
        { tag: 'setup:s1' },
    )
    assert.equal(n.title, 'Mentor')
    assert.equal(n.body,  'Your LONG NVDA setup is confirmed — price reached the zone.')
    assert.equal(n.url,   '/?chat=c1&msg=m1')
    assert.equal(n.tag,   'setup:s1')
    assert.deepEqual(n.data, { conversationId: 'c1', messageId: 'm1' })
})

test('a human DM is titled by the sender name; no name falls back rather than blanks', () => {
    assert.equal(notificationForMessage({ id: 'm', senderId: 'u2', content: 'hey' }, { senderName: 'Dana' }).title, 'Dana')
    assert.equal(notificationForMessage({ id: 'm', senderId: 'u2', content: 'hey' }).title, 'New message')
})

test('a long card is cut to one notification line; whitespace collapses; empty content still reads', () => {
    const long = 'x'.repeat(300)
    const n = notificationForMessage({ id: 'm', senderId: 'axl', content: long })
    assert.ok(n.body.length <= 140)
    assert.ok(n.body.endsWith('…'))
    assert.equal(notificationForMessage({ id: 'm', senderId: 'axl', content: '  a \n\n b  ' }).body, 'a b')
    assert.equal(notificationForMessage({ id: 'm', senderId: 'axl', content: '' }).body, 'New message')
})

test('no subject → the notification tags by its own id and stacks', () => {
    assert.equal(notificationForMessage({ id: 'm9', senderId: 'axl', content: 'hi' }).tag, 'msg:m9')
})

// ── subscriptions ─────────────────────────────────────────────────────────────

test('only a browser-shaped subscription is stored', () => {
    assert.equal(isValidSubscription(SUB(1)), true)
    assert.equal(isValidSubscription({ endpoint: 'http://insecure', keys: { p256dh: 'p', auth: 'a' } }), false)
    assert.equal(isValidSubscription({ endpoint: 'https://ok', keys: { p256dh: 'p' } }), false)
    assert.equal(isValidSubscription(null), false)
    assert.equal(isValidSubscription('https://ok'), false)
})

test('a malformed subscription is a 400, not a stored row', async () => {
    _deps.getDb = async () => { throw new Error('must not reach the db') }
    await assert.rejects(addSubscription('u1', { endpoint: 'nope' }), err => err.status === 400 && err.expose === true)
})

// ── sending ───────────────────────────────────────────────────────────────────

test('every device gets the same payload; a 410 drops its row, a 500 keeps it, and nothing throws', async () => {
    const { db, calls } = fakeDb([SUB(1), SUB(2), SUB(3)])
    _deps.getDb = async () => db
    const sent = []
    _deps.send = async (sub, payload) => {
        sent.push(payload)
        if (sub.endpoint.endsWith('/2')) throw Object.assign(new Error('gone'), { statusCode: 410 })
        if (sub.endpoint.endsWith('/3')) throw Object.assign(new Error('boom'), { statusCode: 500 })
    }
    const out = await pushToUser('u1', { title: 'Mentor', body: 'go', url: '/', tag: 't' })
    assert.deepEqual(out, { sent: 1, dropped: 1, failed: 1 })
    assert.equal(new Set(sent).size, 1, 'one payload for all devices')
    // Only the dead endpoint is pulled — the flaky one lives to be retried on the next card.
    assert.deepEqual(calls.pulled, [{ $in: ['https://push.example/2'] }])
})

test('without a key pair push is simply off — zero sends, no error', async () => {
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
    _deps.send  = async () => { throw new Error('must not send') }
    _deps.getDb = async () => { throw new Error('must not read') }
    // `_configured` may already be true from an earlier test in this process; the guard is on
    // isEnabled() at first configure, so this only proves the never-throws contract holds either way.
    const out = await pushToUser('u1', { title: 't', body: 'b' })
    assert.equal(out.sent, 0)
})

test('a user with no devices, or a db that fails, is a quiet no-op', async () => {
    const { db } = fakeDb([])
    _deps.getDb = async () => db
    assert.deepEqual(await pushToUser('u1', { title: 't' }), { sent: 0, dropped: 0, failed: 0 })
    _deps.getDb = async () => { throw new Error('mongo down') }
    assert.deepEqual(await pushToUser('u1', { title: 't' }), { sent: 0, dropped: 0, failed: 0 })
    assert.deepEqual(await pushToUser(null, { title: 't' }), { sent: 0, dropped: 0, failed: 0 })
})

test('a subscribe takes the endpoint away from EVERY user first — a shared browser changes hands', async () => {
    // A browser has one subscription per origin. A logged out, B enabled alerts: the same endpoint
    // under both accounts would put A's cards on B's screen.
    const { db, calls } = fakeDb([])
    _deps.getDb = async () => db
    await addSubscription('u2', SUB(7))
    assert.deepEqual(calls.pulledEverywhere, ['https://push.example/7'])
})

test('removing a subscription does not stamp the user, so the count answers "was there a row?"', async () => {
    const { db, calls } = fakeDb([])
    _deps.getDb = async () => db
    await removeSubscription('u1', 'https://push.example/1')
    assert.equal(calls.updateOne.length, 1)
    assert.equal(calls.updateOne[0].$set, undefined)
    assert.equal(await removeSubscription('u1', ''), 0)
})

test('twin rows for one endpoint are one send', async () => {
    const { db } = fakeDb([SUB(1), SUB(1)])
    _deps.getDb = async () => db
    let sends = 0
    _deps.send = async () => { sends++ }
    const out = await pushToUser('u1', { title: 't', body: 'b' })
    assert.equal(sends, 1)
    assert.equal(out.sent, 1)
})

test('a public key survives dashboard damage (quotes, whitespace) but not the wrong value', () => {
    assert.equal(normalizePublicKey(KEYS.publicKey), KEYS.publicKey)
    assert.equal(normalizePublicKey(`"${KEYS.publicKey}"
`), KEYS.publicKey)
    assert.equal(normalizePublicKey(KEYS.privateKey), null)            // the private half in the public slot
    assert.equal(normalizePublicKey(KEYS.publicKey.slice(0, 80)), null) // truncated
    assert.equal(normalizePublicKey(''), null)
})

test('a malformed public key turns push OFF rather than reaching a browser', () => {
    process.env.VAPID_PUBLIC_KEY = KEYS.privateKey
    assert.equal(isEnabled(), false)
})
