import webPush from 'web-push'
import { getDb } from '../providers/mongodb.provider.js'
import { config } from './config.js'
import { logger } from './logger.service.js'
import { httpError } from './httpError.util.js'
import { COLLECTION as USERS } from '../api/user/user.model.js'

// WEB PUSH — the second delivery of a chat message, to the user's devices.
//
// A card is written to social chat and pushed over the socket; that is the message. This module
// forwards the SAME message, as an OS notification, to every browser the user has subscribed
// (`pushSubscriptions` on the user document): the desktop in the other room, the phone in the
// pocket. It decides nothing about WHAT is said — the desk wrote the card, the title is the
// desk's brand, the body is the card's own line — and nothing about WHETHER the user is looking:
// the service worker on each device knows whether the app is focused there, and stays quiet if
// so. The server sends to everyone, always. Presence is a device fact, not a server fact.
//
// Never throws. Push is an alert ABOUT a state change, never part of it — same contract as
// notifyCard. A push service outage costs a notification, never the card.
//
// Off entirely without a VAPID key pair (see config); every card still lands in chat.

const LOG      = '[push]'
const BODY_MAX = 140
/** How long a push service may hold an undelivered notification for an offline device. */
const TTL_SEC  = 60 * 60 * 24
const ICON     = '/img/pwa-192.png'

// The desk each bot id is branded as. Human senders carry their name on the message itself.
const BOT_BRAND = Object.freeze({
    axl: 'Axl', mentor: 'Mentor', portfolio: 'Atlas', scanner: 'Argus',
    analyst: 'Prometheus', strategy: 'Pythia', kairos: 'Kairos',
})

// Injectable for tests: the send itself and the db.
export const _deps = {
    send: (subscription, payload, options) => webPush.sendNotification(subscription, payload, options),
    getDb,
}

let _configured = false

export function isEnabled() {
    return Boolean(config.vapidPublicKey && config.vapidPrivateKey)
}

export function publicKey() {
    return config.vapidPublicKey
}

function _ensureConfigured() {
    if (_configured) return true
    if (!isEnabled()) return false
    webPush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey)
    _configured = true
    return true
}

// ── subscriptions ─────────────────────────────────────────────────────────────

/** The shape a browser's PushSubscription.toJSON() has, and nothing else gets stored. */
export function isValidSubscription(sub) {
    return Boolean(
        sub && typeof sub === 'object'
        && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 2048
        && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string'
    )
}

/**
 * Register a device. Keyed by endpoint — a browser that re-subscribes (the push service rotated
 * it, the user toggled twice) replaces its own row rather than adding a twin that would double
 * every notification. Returns the user's subscription count, or null when the user is unknown.
 */
export async function addSubscription(userId, sub, { ua = null } = {}) {
    if (!isValidSubscription(sub)) throw httpError(400, 'Not a push subscription')
    const db  = await _deps.getDb()
    const row = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ua: ua ? String(ua).slice(0, 200) : null, createdAt: Date.now() }
    await db.collection(USERS).updateOne({ id: String(userId) }, { $pull: { pushSubscriptions: { endpoint: sub.endpoint } } })
    const res = await db.collection(USERS).findOneAndUpdate(
        { id: String(userId) },
        { $push: { pushSubscriptions: row }, $set: { updatedAt: Date.now() } },
        { returnDocument: 'after', projection: { pushSubscriptions: 1 } },
    )
    return res ? (res.pushSubscriptions?.length ?? 0) : null
}

export async function removeSubscription(userId, endpoint) {
    if (typeof endpoint !== 'string' || !endpoint) return 0
    const db  = await _deps.getDb()
    const res = await db.collection(USERS).updateOne(
        { id: String(userId) },
        { $pull: { pushSubscriptions: { endpoint } }, $set: { updatedAt: Date.now() } },
    )
    return res.modifiedCount
}

/** The user's devices, without the keys — for the settings page. */
export async function listSubscriptions(userId) {
    const db   = await _deps.getDb()
    const user = await db.collection(USERS).findOne({ id: String(userId) }, { projection: { pushSubscriptions: 1 } })
    return (user?.pushSubscriptions ?? []).map(s => ({ endpoint: s.endpoint, ua: s.ua ?? null, createdAt: s.createdAt ?? null }))
}

// ── the notification ──────────────────────────────────────────────────────────

/**
 * What the device shows for a chat message. PURE.
 *
 * `tag` is what lets a fresher notification REPLACE a stale one on the device instead of stacking
 * — the same one-live-ask-per-entity rule the cards follow (chat.service supersedes the old card;
 * the OS collapses the old notification). The caller passes the card's subject as the tag; a
 * message with no subject tags by its own id and simply stacks.
 *
 * `url` is what a tap opens: the app, on that conversation, scrolled to that message — the same
 * landing the in-app preview toast gives (useChatWs reads the two params).
 */
export function notificationForMessage(msg, { senderName = null, tag = null } = {}) {
    if (!msg) return null
    const senderId = String(msg.senderId ?? '')
    const title = BOT_BRAND[senderId] ?? senderName ?? 'New message'
    const raw   = typeof msg.content === 'string' ? msg.content.replace(/\s+/g, ' ').trim() : ''
    const body  = raw ? (raw.length > BODY_MAX ? raw.slice(0, BODY_MAX - 1) + '…' : raw) : 'New message'
    const url   = `/?chat=${encodeURIComponent(msg.conversationId ?? '')}&msg=${encodeURIComponent(msg.id ?? '')}`
    return {
        title, body, url,
        icon: ICON,
        tag:  tag ?? `msg:${msg.id ?? ''}`,
        data: { conversationId: msg.conversationId ?? null, messageId: msg.id ?? null },
    }
}

// ── sending ───────────────────────────────────────────────────────────────────

/**
 * Send one notification to every device the user has. Never throws.
 *
 * A 404 or 410 from the push service means the browser dropped the subscription (the user revoked
 * permission, cleared the site, reinstalled) — the row is removed so it is not retried forever.
 * Any other failure is logged and the row kept: a transient outage is not a dead device.
 *
 * @returns {Promise<{ sent: number, dropped: number, failed: number }>}
 */
export async function pushToUser(userId, notification) {
    const out = { sent: 0, dropped: 0, failed: 0 }
    if (!userId || !notification) return out
    try {
        if (!_ensureConfigured()) return out
        const db   = await _deps.getDb()
        const user = await db.collection(USERS).findOne({ id: String(userId) }, { projection: { pushSubscriptions: 1 } })
        const subs = user?.pushSubscriptions ?? []
        if (!subs.length) return out

        const payload = JSON.stringify(notification)
        const dead    = []
        await Promise.all(subs.map(async (sub) => {
            try {
                await _deps.send({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: TTL_SEC, urgency: 'high' })
                out.sent++
            } catch (err) {
                const status = err?.statusCode ?? err?.status
                if (status === 404 || status === 410) { dead.push(sub.endpoint); out.dropped++ }
                else { out.failed++; logger.warn(LOG, `send failed for user ${userId} (${status ?? err?.message})`) }
            }
        }))
        if (dead.length) {
            await db.collection(USERS).updateOne({ id: String(userId) }, { $pull: { pushSubscriptions: { endpoint: { $in: dead } } } })
        }
        if (out.sent || out.dropped || out.failed) logger.info(LOG, `→ user ${userId}: ${out.sent} sent, ${out.dropped} dropped, ${out.failed} failed`)
    } catch (err) {
        logger.warn(LOG, `pushToUser failed for user ${userId}:`, err?.message ?? err)
    }
    return out
}
