import { getDb, stripId }  from '../../providers/mongodb.provider.js'
import { logger } from '../../services/logger.service.js'
import { axlAgentService } from '../../services/agents/axl.agent.service.js'
import { toAgentMessages } from './axlReply.util.js'
import { getExperienceLevel } from '../../services/experience.service.js'
// The users collection is owned by user.model — chat only JOINS against it (sender name/avatar,
// the recipient search). It named 'users' inline in three places, which is the same name living in
// four files once marketBrief.notify (which already imports it from the owner) is counted.
import { COLLECTION as USERS } from '../user/user.model.js'
import { pushToUser, notificationForMessage } from '../../services/push.service.js'

const LOG   = '[chat]'
// Owned here. Exported so a reader that needs to join against the inbox imports the name rather
// than re-typing it — the mistake the 'users' import above corrects.
export const CONVS = 'chat_conversations'
export const MSGS  = 'chat_messages'

export const BOT_USER_ID = 'axl'   // the default + the one conversational bot
// One notification bot per agent (ids are the canonical agent keys). Each producer
// posts under its authoring agent so the social-chat conversation sender matches the
// card's agent tag — a portfolio review reads "from Atlas", a setup confirm "from Mentor".
// The specialist threads are notify-only feeds; only Axl handles replies.
// NB: this list is the GATE, not a label — postBotCard silently falls back to Axl for an id that
// isn't here, so a missing entry doesn't error, it misattributes. `mentor` was missing while
// buildSetupEntryConfirm posted under it, which is why Talos's setup cards arrived from Axl.
//
// The frontend registry (agentMeta.jsx BOT_IDS) must stay in step with this one, and in §5 it was
// not: the client carried an extra `aether`. Nothing posts under that id, so the misattribution
// above was latent — but `aether` is also absent from both ADMIN_BOT_IDS while being admin-only
// everywhere else (requireAdmin routes, axl's ADMIN_DESKS, Axl's trader prompt), so the first Aether
// card would have landed in a trader's sidebar, from Axl. The client dropped it; a test there pins
// this list by value, which fails on a change to THAT side and names this file.
//
// A NEW BOT IS TWO ENTRIES, and an admin-only one is four: here, agentMeta BOT_IDS, and — when the
// desk is admin-only — both ADMIN_BOT_IDS.
export const BOT_IDS = ['axl', 'portfolio', 'scanner', 'kairos', 'mentor', 'analyst', 'strategy']
export const isBot = (id) => BOT_IDS.includes(String(id))

// RETIRED bots. `idea` was dropped when the Idea desk was archived (its agent is gone and its
// route unmounted), so there is no longer anyone behind that feed. Threads already in Mongo are
// NOT deleted — the cards in them are real history — they are simply hidden from the sidebar by
// getConversations. Keep an id here rather than dropping it silently: a reader who finds an old
// `idea` sender in chat_messages needs to see WHY nothing renders it.
export const RETIRED_BOT_IDS = ['idea']
export const isRetiredBot = (id) => RETIRED_BOT_IDS.includes(String(id))

// ADMIN-ONLY feeds. Pythia and Prometheus post only to admins (tiltNotify and coverageNotify both
// narrow to `listAdminUserIds`), so a trader should never own one of these threads — but a demoted
// admin still does, and the client dropping it (agentMeta ADMIN_BOT_IDS) was the only gate.
// getConversations drops it too, so the served set equals the visible set, the same rule the
// routes under /api/strategy apply. Prometheus joined 2026-09-14: coverage is a house artifact
// only an admin can revise, and every card in that feed asks for exactly that revision. Must stay
// in step with the frontend ADMIN_BOT_IDS.
export const ADMIN_BOT_IDS = ['strategy', 'analyst']
export const isAdminBot = (id) => ADMIN_BOT_IDS.includes(String(id))

/**
 * Which bot speaks for an entity KIND. One home for the attribution rule, because the callers that
 * need it (the market-open sweep, the manual fill/exit cards, the position monitor) are all
 * kind-blind services posting on a desk's behalf — each re-deriving it is how a Kairos call ended
 * up announcing its own fill as "Idea".
 *
 * A kind with no living desk (the archived `idea`) falls back to Axl, which is the general
 * notification bot — never a wrong brand, and never a lost card.
 */
const BOT_BY_KIND = Object.freeze({
    call:           'kairos',
    setup:          'mentor',
    portfolio_item: 'portfolio',
    idea:           BOT_USER_ID,
})
export const botForKind = (kind) => BOT_BY_KIND[kind] ?? BOT_USER_ID
const BOT_WELCOME = "Hi, I'm Axl — your trading assistant. I'll notify you here about portfolio reviews, position alerts, and anything that needs your attention, and you can ask me how the app works. Just message me."

// Lazy import to avoid circular dependency (chatWs imports nothing from here).
// emit is only called at runtime, never at module-load time.
let _emit = null
async function _tryEmit(userId, event, data) {
    if (!_emit) {
        try { _emit = (await import('./chatWs.js')).emit } catch { /* ws not attached yet */ }
    }
    _emit?.(userId, event, data)
}

/**
 * A MESSAGE REACHED THIS USER — the one step both delivery paths (a bot card, a human DM) end in.
 * Two channels, same message: the socket, for the app that is open; web push, for the devices
 * that are not. The server sends both, always — whether the user is actually looking is known
 * only on the device (the service worker stays quiet when the app is focused there), so the
 * server does not guess from a socket count that says nothing about where the human is.
 *
 * Push is fire-and-forget: it round-trips to the browsers' push services, and a monitor loop
 * posting a card must not wait on Google. pushToUser never throws; the catch is belt-and-braces.
 * `tag` collapses a fresher notification onto a stale one with the SAME scope _supersedePending
 * uses for the cards — an actionable card, per type, per subject. A plain statement about a setup
 * must not swallow the pending ask about it, and two different asks are two jobs.
 */
async function _deliver(userId, msg, { senderName = null } = {}) {
    await _tryEmit(userId, 'new_message', senderName ? { ...msg, senderName } : msg)
    const subject = msg?.actions ? cardSubject(msg.payload) : null
    const tag     = subject ? `${msg.type}:${subject.kind}:${subject.id}` : null
    pushToUser(userId, notificationForMessage(msg, { senderName, tag }))
        .catch(err => logger.warn(LOG, 'push failed', err?.message ?? err))
}

export async function ensureIndexes() {
    try {
        const db = await getDb()
        await db.collection(CONVS).createIndexes([
            { key: { participants: 1 } },
            { key: { participants: 1, lastMessageAt: -1 } },
        ])
        await db.collection(MSGS).createIndexes([
            { key: { conversationId: 1, createdAt: -1 } },
            { key: { conversationId: 1, readAt: 1 } },
            // listCardRecipientsSince — a notifier's "who already got today's?" runs on a timer over
            // a collection that only grows, so it must not be a scan.
            { key: { type: 1, createdAt: -1 } },
        ])
    } catch (err) {
        logger.warn(LOG, 'ensureIndexes failed', err.message)
    }
}

/**
 * Find or create a DM conversation between two participants.
 * Participants are sorted before storage so [a,b] and [b,a] resolve to the same doc.
 * Returns { conv, created }.
 */
export async function getOrCreateConversation(userIdA, userIdB) {
    const db           = await getDb()
    const participants = [String(userIdA), String(userIdB)].sort()

    const existing = await db.collection(CONVS).findOne({ participants })
    if (existing) return { conv: stripId(existing), created: false }

    const conv = {
        id:            `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        participants,
        createdAt:     Date.now(),
        lastMessageAt: Date.now(),
        lastMessage:   '',
    }
    await db.collection(CONVS).insertOne(conv)
    return { conv: stripId(conv), created: true }
}

// ── The one card contract (shared by users + every agent) ─────────────────────
// "Actionable" is a property of the MESSAGE, not the sender: a message renders the do/dismiss
// row and carries a resolution lifecycle IFF it has `actions`. Plain DMs and plain bot lines
// pass actions=null and are inert. The two-button rule ("do something" + dismiss) is defined
// once, here, so all producers stay uniform.
// WHAT RESOLVES A CARD, declared here and nowhere else.
//
//   'work' (the default) — the card ASKS FOR WORK. Opening it is not doing it. Only an explicit
//           dismiss, or the work actually landing, resolves it. Ignoring it, scrolling past it, or
//           opening it and walking away leaves it pending and visible.
//   'open'  — the card OFFERS A READ and opening it IS the completion. The market brief streams
//           when you ask for it; the sector board has nothing to revise. These are the exception.
//
// This used to be decided nine times, in nine card components, each calling resolve('done') the
// instant the user navigated — with outcomes named `opened`, `editing` and `resumed`, which are by
// their own names not completions. A "revise this thesis" card vanished when you looked at it and
// nothing brought it back. The policy is a property of the CARD, so it is authored where cards are
// authored, and the one shell that renders them obeys it.
export const RESOLVES_ON = ['work', 'open']

export const cardActions = (label, { resolvesOn = 'work' } = {}) => ({
    primary: { label, resolvesOn: RESOLVES_ON.includes(resolvesOn) ? resolvesOn : 'work' },
    dismiss: true,
})

// payload key → what the card is ABOUT. First match wins, so the order is the judgment: a coverage
// refresh raised mid-review carries BOTH a portfolioId and a coverageId, and its ask ("resume the
// review") is satisfied by the review, not by the thesis — so portfolio outranks coverage.
const SUBJECT_KEYS = [
    ['portfolioId', 'portfolio'],
    ['setupId',     'setup'],
    ['callId',      'call'],
    ['ideaId',      'idea'],
    ['coverageId',  'coverage'],
    ['tiltId',      'tilt'],
]

/**
 * What entity is this card about? PURE → `{ kind, id }` or null.
 *
 * The key that makes both halves of the lifecycle possible: SUPERSEDING (one live ask per entity,
 * so "stays alive" cannot become "accumulates duplicates") and COMPLETING (a user's write to that
 * entity closes the ask). Derived from the payload the card already carries — no producer has to
 * pass anything new.
 */
export function cardSubject(payload) {
    if (!payload || typeof payload !== 'object') return null
    for (const [key, kind] of SUBJECT_KEYS) {
        const id = payload[key]
        if (typeof id === 'string' && id.trim()) return { kind, id: id.trim() }
    }
    return null
}

// Pure: derive the lifecycle fields a message doc carries from its `actions`. Single source of
// the rule, shared by the writer below (and unit-tested without a DB).
export function cardLifecycle(actions, payload = null) {
    const hasActions = !!actions && typeof actions === 'object'
    return {
        actions: hasActions ? actions : null,
        status:  hasActions ? 'pending' : null,
        subject: hasActions ? cardSubject(payload) : null,
    }
}

// Pure: normalize a requested resolution. Two TERMINAL states, plus `pending` — which is not a
// resolution at all but a touch: "the user opened this and it is still outstanding".
//
// `pending` has to be expressible here or the stays-alive rule cannot be written down. Without it
// the client's only vocabulary for "I opened it" was `done`, which is precisely how nine cards came
// to close themselves on navigation. Anything unrecognised still falls to `dismissed`, so a
// malformed request can never invent a completion.
export function normalizeResolveStatus(status) {
    if (status === 'done')    return 'done'
    if (status === 'pending') return 'pending'
    return 'dismissed'
}

export async function sendMessage(conversationId, senderId, content, type = 'text', payload = null, actions = null, visibility = 'all', forUserId = null) {
    const db  = await getDb()
    const msg = {
        id:             `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        conversationId,
        senderId:       String(senderId),
        content,
        type,
        payload:        payload ?? null,
        ...cardLifecycle(actions, payload),   // { actions, status, subject } — same rule for user DMs and agent cards
        resolvedAt:     null,
        resolveOutcome: null,
        resolveNote:    null,
        createdAt:      Date.now(),
        readAt:         null,
        visibility:     visibility ?? 'all',
        ...(forUserId != null ? { forUserId: String(forUserId) } : {}),
    }
    await db.collection(MSGS).insertOne(msg)
    await db.collection(CONVS).updateOne(
        { id: conversationId },
        { $set: { lastMessageAt: msg.createdAt, lastMessage: String(content).slice(0, 120) } }
    )
    return stripId(msg)
}

/**
 * Post a bot CARD to a user — the one path every agent/monitor notification funnels through.
 * `actions` (optional) makes it a do/dismiss card with a resolution lifecycle; omit for a plain
 * bot line (e.g. Axl's chat replies). Resolves the per-agent bot conversation, writes via the
 * shared `sendMessage`, and pushes the WS event. Never throws (logs + returns null) — so a broker
 * hiccup in a monitor loop can't take the loop down.
 */
export async function postBotCard({ userId, content, type = 'text', payload = null, botId = BOT_USER_ID, actions = null, visibility = 'all', forUserId = null }) {
    if (!userId) return null
    try {
        const bot = isBot(botId) ? String(botId) : BOT_USER_ID
        const { conv } = await getOrCreateConversation(userId, bot)
        // ONE LIVE ASK PER ENTITY. Cards now survive being ignored, which is the point — but a
        // thesis that oscillates (validating → diverging → validating) would otherwise leave three
        // pending cards for one unfinished job, and "stays alive" would read as "nags". The newest
        // card carries the current situation, so it replaces rather than joins.
        await _supersedePending(conv.id, type, cardSubject(payload), actions)
        const msg = await sendMessage(conv.id, bot, content, type, payload, actions, visibility, forUserId)
        await _deliver(String(userId), msg)
        return msg
    } catch (err) {
        logger.error(LOG, 'postBotCard failed', err)
        return null
    }
}

/**
 * Retire the pending card(s) this one replaces. Internal to the post path — nothing else may mark
 * a card superseded, because "a fresher card exists" is only knowable here.
 *
 * Scoped to the same conversation AND the same type: two different asks about one setup (an
 * invalidation and a manage nudge) are two jobs, not one restated.
 */
async function _supersedePending(conversationId, type, subject, actions) {
    if (!actions || !subject) return 0
    try {
        const db  = await getDb()
        const res = await db.collection(MSGS).updateMany(
            { conversationId, type, status: 'pending', 'subject.kind': subject.kind, 'subject.id': subject.id },
            { $set: { status: 'superseded', resolvedAt: Date.now(), resolveOutcome: 'superseded' } },
        )
        if (res.modifiedCount) logger.info(LOG, 'superseded stale card(s)', { type, subject, count: res.modifiedCount })
        return res.modifiedCount
    } catch (err) {
        // A supersede that fails must never cost the user the NEW card — worst case they see two.
        logger.warn(LOG, 'supersede failed (new card still posted)', err.message)
        return 0
    }
}

/**
 * THE WORK LANDED — resolve every pending card about this entity. The other half of the
 * stays-alive rule: a card is closed by the ask being satisfied, not by the user navigating.
 *
 * Called from the places that can honestly claim a user did the work (makeEntityController's
 * patch, and the per-kind write routes that do not go through it — coverage's — a monitor writing
 * the same document goes through the service directly and never through here). Never throws: a
 * card left pending is a stale nag, an exception here would fail the write the user actually
 * asked for.
 *
 * `note` is WHAT WAS DONE, in the caller's own words ("Re-modelled — rating sell → hold, PT 85 →
 * 92"). The card collapses to a chip that shows it, so a scrolled-back ask reads as answered
 * rather than merely closed. The copy is the caller's judgment — this only carries it.
 *
 * Pushed over the socket as `message_resolved`, one frame per card, to the human side of its
 * conversation: the write that satisfied the ask happens on a DESK, and the card is in a panel
 * that may be open beside it. Without the push it sat there "still waiting on you" until the
 * panel was reopened.
 *
 * Subject ids are per-entity and entities are owner-scoped, so an id cannot address another user's
 * card; no extra scoping is needed to keep this from reaching across users.
 */
export async function resolveCardsFor(subject, { outcome = 'completed', note = null } = {}) {
    if (!subject?.kind || !subject?.id) return 0
    try {
        const db    = await getDb()
        const query = { status: 'pending', 'subject.kind': subject.kind, 'subject.id': String(subject.id) }
        const patch = { status: 'done', resolvedAt: Date.now(), resolveOutcome: String(outcome), resolveNote: _str(note) }
        const cards = await db.collection(MSGS).find(query, { projection: { _id: 0, id: 1, conversationId: 1 } }).toArray()
        if (!cards.length) return 0
        const res = await db.collection(MSGS).updateMany(query, { $set: patch })
        if (res.modifiedCount) logger.info(LOG, 'card(s) resolved by the work landing', { subject, count: res.modifiedCount })
        await _pushResolved(db, cards, patch)
        return res.modifiedCount
    } catch (err) {
        logger.warn(LOG, 'resolveCardsFor failed (cards left pending)', err.message)
        return 0
    }
}

const _str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)

// Tell the human participant of each card's conversation that it resolved. Best effort: the
// resolution is already written, and a push that fails costs a live flip, not the resolution.
async function _pushResolved(db, cards, patch) {
    try {
        const convIds = [...new Set(cards.map(c => c.conversationId))]
        const convs   = await db.collection(CONVS).find({ id: { $in: convIds } }, { projection: { _id: 0, id: 1, participants: 1 } }).toArray()
        const humanOf = Object.fromEntries(convs.map(c => [c.id, (c.participants ?? []).find(p => !isBot(p)) ?? null]))
        for (const card of cards) {
            const userId = humanOf[card.conversationId]
            if (userId) await _tryEmit(userId, 'message_resolved', { id: card.id, conversationId: card.conversationId, ...patch })
        }
    } catch (err) {
        logger.warn(LOG, 'resolved-card push failed (resolution stored)', err.message)
    }
}

/**
 * Back-compat thin alias — a plain (actionless) bot message. Prefer `postBotCard` (with `actions`)
 * for anything the user should act on; this stays for plain bot lines like Axl's chat replies.
 */
export async function sendBotMessage(userId, content, type = 'text', payload = null, botId = BOT_USER_ID) {
    return postBotCard({ userId, content, type, payload, botId, actions: null })
}

/**
 * Generate Axl's reply to a user message in the social chat and send it back.
 * Called (fire-and-forget) after a user posts into their Axl conversation.
 *
 * Role #1 of the Axl agent: the social-chat assistant. Non-streaming — it collects
 * the full reply and pushes it as a single bot message (the social chat is WS
 * push, not SSE). Routing to specialists + thread resolution are later layers;
 * for now Axl answers general / app-guide questions itself and, per its prompt,
 * routes any build/change request to the relevant specialist chat.
 *
 * `aiPref` ({ model }) is the user's shared model choice, forwarded by the social-chat client so
 * Axl runs on the same model here as it does in the hub. Passed straight through — there is no
 * routing layer to resolve it against.
 */
export async function triggerAxlReply(userId, conversationId, aiPref = {}) {
    try {
        const history = await getMessages(conversationId, userId, null, 12)
        if (!history || !history.length) return

        const agentMessages = toAgentMessages(history, BOT_USER_ID, 12)
        // Only answer when the latest turn is actually the user's (guards against
        // a race where the trigger fires but the newest message is Axl's own).
        if (agentMessages.at(-1)?.role !== 'user') return

        const { reply } = await axlAgentService.chatStream({
            messages:        agentMessages,
            // The SAME Axl answers here and in the hub, so it has to read the room the same way in
            // both. Without this, someone gets plain language in one surface and jargon in the other.
            audience:        await getExperienceLevel(userId),
            model:           aiPref?.model,
            userId,
        })
        if (reply?.trim()) await sendBotMessage(userId, reply.trim())
    } catch (err) {
        logger.error(LOG, 'triggerAxlReply failed', err)
    }
}

/**
 * Post a user's message into a conversation: verify the sender is a participant, write the
 * message, push it to the other participant over WS, and — when the recipient is Axl — fire
 * off Axl's reply (fire-and-forget; it arrives later over WS). This is the notification-routing
 * business logic that used to live in the controller. Returns { ok, message } or
 * { ok:false, reason:'forbidden' }.
 */
export async function postUserMessage(conversationId, senderId, content, aiPref = {}) {
    // Reuse getMessages' participant check (returns null when the sender isn't in the convo).
    const allowed = await getMessages(conversationId, senderId, null, 0)
    if (allowed === null) return { ok: false, reason: 'forbidden' }

    const msg = await sendMessage(conversationId, senderId, content)

    const db   = await getDb()
    const conv = await db.collection(CONVS).findOne({ id: conversationId })
    if (conv) {
        const recipientId = conv.participants.find(p => p !== String(senderId))
        if (recipientId && !isBot(recipientId)) {
            // Attach the sender's display name so the recipient's incoming-message toast can show
            // who it's from — the stored message only carries senderId. Emit-only (not persisted);
            // only for human recipients (bots have no WS client + resolve senders from agent meta).
            const sender = await db.collection(USERS).findOne(
                { id: String(senderId) }, { projection: { fullname: 1, username: 1 } })
            const senderName = sender?.fullname || sender?.username || null
            await _deliver(recipientId, msg, { senderName })
        } else if (recipientId) {
            // A bot recipient: no device, no push — the socket emit is kept as it was.
            await _tryEmit(recipientId, 'new_message', msg)
        }
        // If the message is to Axl, generate + push a reply (fire-and-forget so the POST
        // returns immediately; Axl's answer arrives over WS when ready).
        if (recipientId === BOT_USER_ID) {
            triggerAxlReply(senderId, conversationId, aiPref).catch(() => {})
        }
    }
    return { ok: true, message: msg }
}

/**
 * Seed the bot conversation for a new user. Idempotent — safe to call multiple times.
 */
export async function seedBotConversation(userId) {
    const { conv, created } = await getOrCreateConversation(userId, BOT_USER_ID)
    if (created) await sendMessage(conv.id, BOT_USER_ID, BOT_WELCOME)
}

/**
 * Which of a user's threads the sidebar may show. Pure, so the two drops are assertable without a DB:
 *  - a RETIRED bot's thread stays in Mongo but leaves the sidebar — nothing posts there any more, so
 *    it can only ever show a frozen feed under a desk the app no longer has;
 *  - an ADMIN-ONLY bot's thread is hidden from a non-admin — it exists only for an admin who was
 *    since demoted, and a trader must not read the house desk through a thread the role no longer
 *    entitles them to.
 */
export function visibleConversationsFor(convs, role = null) {
    const admin = role === 'admin'
    return (Array.isArray(convs) ? convs : []).filter(c =>
        !c.participants.some(isRetiredBot) && (admin || !c.participants.some(isAdminBot))
    )
}

export async function getConversations(userId, role = null) {
    const db  = await getDb()
    const uid = String(userId)

    const convs = visibleConversationsFor(await db.collection(CONVS)
        .find({ participants: uid })
        .sort({ lastMessageAt: -1 })
        .toArray(), role)

    if (!convs.length) return []

    // Unread counts: one aggregation across all conversations for this user
    const convIds = convs.map(c => c.id)
    const unreadRows = await db.collection(MSGS).aggregate([
        { $match: { conversationId: { $in: convIds }, senderId: { $ne: uid }, readAt: null } },
        { $group: { _id: '$conversationId', unread: { $sum: 1 } } },
    ]).toArray()

    const unreadMap = Object.fromEntries(unreadRows.map(r => [r._id, r.unread]))

    // Enrich with the other participant's display name. Bots aren't real user docs —
    // the client renders their brand/avatar from agent metadata — so skip them here.
    const otherIds = [...new Set(
        convs.flatMap(c => c.participants.filter(p => p !== uid && !isBot(p)))
    )]
    const userDocs = otherIds.length
        ? await db.collection(USERS)
            .find({ id: { $in: otherIds } }, { projection: { id: 1, username: 1, fullname: 1 } })
            .toArray()
        : []
    const userMap = Object.fromEntries(userDocs.map(u => [u.id, u]))

    return convs.map(c => {
        const otherId   = c.participants.find(p => p !== uid) ?? ''
        const otherUser = userMap[otherId]
        return {
            ...stripId(c),
            unread:        unreadMap[c.id] ?? 0,
            otherName:     otherUser?.fullname  ?? null,
            otherUsername: otherUser?.username  ?? null,
        }
    })
}

/**
 * `role` is the READER'S role and is only passed from the HTTP path: with it, the same gate the
 * sidebar applies holds here — a thread the role cannot list is one it cannot read by id. The
 * in-process callers (Axl's reply history, the post-permission check) leave it unset: they act on
 * a thread the app already resolved for its owner, and the token's role is not theirs to assert.
 */
export async function getMessages(conversationId, userId, before, limit = 50, role = undefined) {
    const db   = await getDb()
    const conv = await db.collection(CONVS).findOne({ id: conversationId })
    if (!conv || !conv.participants.includes(String(userId))) return null
    if (role !== undefined && !visibleConversationsFor([conv], role).length) return null

    const query = { conversationId }
    if (before) query.createdAt = { $lt: Number(before) }

    const msgs = await db.collection(MSGS)
        .find(query)
        .sort({ createdAt: -1 })
        .limit(Math.min(limit, 100))
        .toArray()

    return msgs.map(stripId).reverse()
}

export async function markRead(conversationId, userId) {
    const db  = await getDb()
    const uid = String(userId)

    const conv = await db.collection(CONVS).findOne({ id: conversationId })
    if (!conv || !conv.participants.includes(uid)) return { ok: false }

    await db.collection(MSGS).updateMany(
        { conversationId, senderId: { $ne: uid }, readAt: null },
        { $set: { readAt: Date.now() } }
    )
    return { ok: true }
}

/**
 * Resolve a card's lifecycle — the ONE function every card type routes through (replaces the old
 * per-type split). `status` is 'done' (the user acted) or 'dismissed' (acknowledged, no action);
 * `outcome` records WHICH action so the collapsed card reads accurately (confirmed | editing |
 * closing | deleted…). Writes the uniform top-level status/resolvedAt/resolveOutcome.
 * Message-level only — it never touches the idea/call latch, so a re-armed idea still emits a
 * fresh alert.
 *
 * It also wrote the legacy `dismissed`/`dismissOutcome` pair while the client caught up. That
 * transition is over: cardResolution.js reads the top-level `status` first and only falls back to
 * `dismissed` for documents written before the refactor. Those documents keep their field and that
 * fallback keeps reading them — what stopped is stamping a dead field onto NEW writes.
 */
export async function resolveMessage(conversationId, messageId, userId, { status = 'dismissed', outcome = null } = {}) {
    const db  = await getDb()
    const uid = String(userId)

    const conv = await db.collection(CONVS).findOne({ id: conversationId })
    if (!conv || !conv.participants.includes(uid)) return { ok: false }

    const st = normalizeResolveStatus(status)
    // A TOUCH, not a resolution: record that it was opened and leave everything else alone. Stamping
    // `resolvedAt` here would resolve the card through the back door and collapse the very card this
    // branch exists to keep alive. (The legacy `dismissed` flag was the sharper version of that trap
    // while it was still written — the client falls back to it for pre-refactor history, so setting
    // it on a pending card resolved one. Nothing writes it now.)
    if (st === 'pending') {
        await db.collection(MSGS).updateOne(
            { id: messageId, conversationId, status: 'pending' },   // never re-open a settled card
            { $set: { resolveOutcome: outcome ? String(outcome) : null } },
        )
        return { ok: true, status: st }
    }

    await db.collection(MSGS).updateOne(
        { id: messageId, conversationId },
        { $set: {
            status:         st,
            resolvedAt:     Date.now(),
            resolveOutcome: outcome ? String(outcome) : null,
        } }
    )
    return { ok: true, status: st }
}

/**
 * Which users already received a card of this type since `since` — the dedupe read for any
 * fan-out notifier ("has this user had today's?"). Lives here rather than in the notifier because
 * the conversation→user join needs the collection layout, and that knowledge belongs to one module.
 *
 * @returns {Promise<Set<string>>} userIds (the non-bot participant of each matching conversation)
 */
export async function listCardRecipientsSince(type, since) {
    const db = await getDb()
    const msgs = await db.collection(MSGS)
        .find({ type: String(type), createdAt: { $gte: Number(since) } }, { projection: { conversationId: 1 } })
        .toArray()
    if (!msgs.length) return new Set()

    const convIds = [...new Set(msgs.map(m => m.conversationId))]
    const convs = await db.collection(CONVS)
        .find({ id: { $in: convIds } }, { projection: { participants: 1 } })
        .toArray()

    const out = new Set()
    for (const c of convs) {
        for (const p of (c.participants ?? [])) if (!isBot(p)) out.add(String(p))
    }
    return out
}

// `dismissMessage` lived here as a back-compat alias for `resolveMessage(…, 'dismissed')`, behind a
// controller handler and a route of its own. The whole chain was dead: the client posts to /resolve,
// and its own dismissMessage helper was an alias that did too — four layers, no caller at either
// end. Removed in §5. A dismiss is `status: 'dismissed'`, which is the vocabulary the lifecycle
// already speaks.

/**
 * Flip a portfolio_review notification card to a resolved state after the user finishes a
 * review (dismissed with no changes, or accepted an update). Finds the latest portfolio_review
 * message for this portfolio in the user's Atlas-bot ('portfolio') conversation and stamps its
 * payload with the outcome + next review date, so the card renders "Dismissed/Updated · next
 * review <date>" and stops routing into an active review. No-op (safe) when there's no such
 * conversation/card. Patched payload surfaces on the client's next social-chat load.
 * @param {string} userId
 * @param {string} portfolioId
 * @param {{ nextReviewAt?: number|null, outcome?: 'dismissed'|'updated' }} [opts]
 */
export async function resolvePortfolioReviewCard(userId, portfolioId, { nextReviewAt = null, outcome = 'dismissed' } = {}) {
    try {
        const db = await getDb()
        const participants = [String(userId), 'portfolio'].sort()
        const conv = await db.collection(CONVS).findOne({ participants })
        if (!conv) return { ok: false, reason: 'no_conversation' }

        const msg = await db.collection(MSGS)
            .find({ conversationId: conv.id, type: 'portfolio_review', 'payload.portfolioId': portfolioId })
            .sort({ createdAt: -1 })
            .limit(1)
            .next()
        if (!msg) return { ok: false, reason: 'no_card' }

        await db.collection(MSGS).updateOne(
            { id: msg.id },
            { $set: {
                // Uniform top-level lifecycle (an 'updated' review = the user acted → done).
                status:         outcome === 'updated' ? 'done' : 'dismissed',
                resolvedAt:     Date.now(),
                resolveOutcome: outcome,
                // legacy payload fields (transitional — the review bubble still reads these)
                'payload.resolved':     true,
                'payload.outcome':      outcome,
                'payload.nextReviewAt': nextReviewAt,
            } }
        )
        return { ok: true, messageId: msg.id }
    } catch (err) {
        logger.error(LOG, 'resolvePortfolioReviewCard failed', err)
        return { ok: false, reason: 'error' }
    }
}

export async function searchUsers(query, currentUserId) {
    if (!query || query.trim().length < 2) return []
    const db     = await getDb()
    // Escape regex metacharacters before building the matcher: the query is raw
    // user input, so an unescaped pattern like "(a+)+$" is a catastrophic-
    // backtracking (ReDoS) vector, and stray metachars break intended matching.
    const safe   = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex  = new RegExp(safe, 'i')
    const users  = await db.collection(USERS)
        .find({
            id:       { $ne: String(currentUserId) },
            // RETIRED ids belong here too: a bot seeded as a user doc does not stop existing when
            // its feed is dropped from BOT_IDS — it just stops being recognised as a bot, and
            // surfaces in the people search as a findable "user" you can start a DM with.
            username: { $nin: [...BOT_IDS, ...RETIRED_BOT_IDS] },
            $or: [{ username: regex }, { fullname: regex }],
        })
        .project({ id: 1, username: 1, fullname: 1 })
        .limit(20)
        .toArray()

    return users.map(stripId)
}
