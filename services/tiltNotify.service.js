// Strategy-desk notifications (Pythia) — the house sector view moved, and someone whose book sits
// in that sector should hear about it.
//
// Mirrors coverageNotify exactly: a PURE builder (unit-tested) plus a thin wrapper over the shared
// postCard. Each agent owns its own card copy and payload and posts through the one transport —
// never a router (see the Axl decision: routing social chat through a central dispatcher was
// abandoned, and this must not quietly rebuild it).
//
// THE AUDIENCE. A tilt is a BROADCAST: one house view, no `userId`, deliberately never joined to
// anyone's book in storage. But postCard refuses a card with no owner, correctly ("no owner →
// nowhere to deliver"), so the audience has to be DERIVED at delivery time — and since 2026-09-14
// there is exactly one honest answer: the ADMIN ROSTER. The desk is admin-only end to end (the
// routes, the client, the cards), so every card here goes to every admin, the same fan-out the
// coverage monitor's verdict card uses.
//
// It used to be narrower, and the narrowing was dead. The change card was scoped to "whoever
// RESEARCHES the moved sector", a join on coverage's `userId` — and coverage stopped carrying one
// at the pivot to house ownership (5c12b8c, 2026-08-26). The join then matched nobody, every
// publish logged `users: 0, posted: 0`, and the test fixture still gave its rows a `userId`, so
// nothing was red for three weeks. There is no per-user "who cares about Energy" left in the data;
// pretending otherwise is how the card went silent.

import { cardActions, listCardRecipientsSince } from '../api/chat/chat.service.js'
import { listAdminUserIds } from '../api/user/user.model.js'
import { reviewAnchorMs, REVIEW_FLOOR_DAYS }    from '../monitoring/tilt.assess.js'
import { postCard }        from './notifyCard.js'
import { logger }          from './logger.service.js'

const LOG = '[tiltNotify]'

// Injectable so the fan-out is assertable without a DB.
//
// `adminUserIds`, not the whole roster, and it bounds BOTH cards. Every card this module builds
// carries `visibility: 'admin'`, and the client drops the strategy conversation outright for a
// trader — so a card addressed to one is a document nobody can ever open. Narrowing here rather
// than trusting the client keeps the delivered set equal to the visible set.
const _deps = {
    adminUserIds:       ()     => listAdminUserIds(),
    recipientsSince:    (t, s) => listCardRecipientsSince(t, s),
    // The one transport, injected only so delivery is assertable without a database. It is still
    // postCard — this is a test seam, not a second way for a card to reach the user.
    post:               (card, ctx) => postCard(card, ctx),
}

/** How a stance reads in a sentence. A withdrawn stance is `no view`, not silence. */
const STANCE_WORD = { over: 'overweight', neutral: 'neutral', under: 'underweight' }
const _word = s => STANCE_WORD[s] ?? 'no view'

/** "Energy underweight → overweight (+150bp)" — one moved sector, in words. Pure. */
function _phrase(c) {
    const weight = c.to_bp === null || c.to_bp === undefined
        ? ''
        : ` (${c.to_bp >= 0 ? '+' : ''}${c.to_bp}bp)`
    return `${c.sector} ${_word(c.from)} → ${_word(c.to)}${weight}`
}

/**
 * Build the tilt-change card for one admin. Pure → `{ userId, content, type, payload, botId, actions }`
 * or null when there is nothing to say. `changes` is `diffStances(prev, next)` — every moved sector;
 * the house view is one document and each admin hears the whole change.
 */
export function buildTiltEvent(tilt, changes, userId) {
    const moved = (Array.isArray(changes) ? changes : []).filter(c => c?.sector)
    if (!userId || !moved.length) return null

    // Lead with the regime when it is named: the stance is the conclusion, the regime is the reason,
    // and a card that gives only the conclusion invites the reader to guess at the reason.
    const regime = tilt?.regime?.name ? `${tilt.regime.name} — ` : ''
    const head   = moved.length === 1 ? 'Sector view changed' : `${moved.length} sector views changed`
    const body   = moved.map(_phrase).join('; ')

    return {
        userId,
        content: `${head}: ${regime}${body}.`,
        type:    'tilt_event',
        payload: {
            kind: 'tilt', tiltId: tilt?.id ?? null, benchmark: tilt?.benchmark ?? null,
            sectors: moved.map(c => c.sector),
            // The desk publishes unbalanced tables rather than losing them, so the card has to admit
            // it — an active-weight set that does not net out is not directly allocatable.
            balanced: tilt?.balanced !== false,
        },
        botId:      'strategy',
        // A READ, not an ask: the house view is a STATE and there is nothing to revise from here,
        // so putting the board in front of the reader IS the whole job. One of only two cards that
        // opting out of the stays-alive default is honest for — its sibling below ("Run the review")
        // asks for work and keeps the default.
        actions:    cardActions('Open sector view', { resolvesOn: 'open' }),
        visibility: 'admin',
    }
}

/**
 * Post the tilt-change card to every admin. Fire-and-forget; never throws into the publish.
 *
 * Returns the number of cards posted, so a caller can log "told nobody" distinctly from "told
 * twelve people" — a silent zero here would look identical to a working notify. (It did, for three
 * weeks: see the header.)
 */
export async function notifyTiltChanged(tilt, changes, deps = _deps) {
    const moved = (Array.isArray(changes) ? changes : []).filter(c => c?.sector)
    if (!moved.length) return 0

    let userIds
    try {
        userIds = await deps.adminUserIds()
    } catch (err) {
        // A view that published but could not find its audience is still published. Degrade to
        // "nobody told" rather than failing the publish that already happened.
        logger.warn(LOG, 'roster read failed — no cards posted', err.message)
        return 0
    }

    let posted = 0
    for (const userId of userIds ?? []) {
        // `?? postCard` because callers (tests) pass PARTIAL dep objects — a seam that is only ever
        // overridden must not turn every partial into a crash.
        if (await (deps.post ?? postCard)(buildTiltEvent(tilt, moved, userId), { tag: 'Tilt-change card', log: LOG })) posted++
    }
    logger.info(LOG, 'tilt change notified', { sectors: moved.length, users: (userIds ?? []).length, posted })
    return posted
}

// ─── the review OFFER ─────────────────────────────────────────────────────────
//
// The other half of this desk's traffic, and a different shape from the change card above.
//
// WHY AN OFFER AND NOT A RUN. `reviewDecision` says the house view is due — a stance came due, a
// macro catalyst landed, or the monthly floor expired. Acting on that verdict is a multi-minute,
// tool-heavy top-down turn that ends in SUPERSEDING the view every user reads, so the monitor
// deliberately does not run it unattended. It asks. The confirm takes the user to Pythia and the
// review runs there, in the thread where it can be questioned — the same call the daily market
// brief makes, and for the same reason (see marketBrief.notify).
//
// WHY EVERY ADMIN, AND NOT EVERY USER. A tilt has no owner by construction, so this is a broadcast
// to the desk's audience — a request to re-examine the house view itself, which serves every admin
// equally. The roster is the admin roster because authoring the house view is an admin job and the
// desk is hidden from traders — asking a trader to run a review they cannot open is worse than not
// asking. (The change card above reaches the same roster; the two differ in dedupe, not audience.)
//
// DEDUPE, without a second source of truth. "Has this user already been asked about THIS view?" is
// answered by looking for the card, exactly as the brief offer does — so a restart mid-fan-out
// resumes instead of double-posting. The window opens at the last publish/re-author, which is what
// makes it one ask per user per published view; it is floored at REOFFER_DAYS so a view left stale
// for months is asked about again rather than silently forgotten, and never more often than that.

export const REVIEW_CARD_TYPE = 'tilt_review'

const DAY_MS = 24 * 60 * 60 * 1000
/** A stale view is re-offered at most this often — the review cadence itself, not a nag. */
const REOFFER_DAYS = REVIEW_FLOOR_DAYS

/**
 * Build the "house view due for review" card for one user. Pure → the card, or null with no user.
 *
 * `reason` is `reviewDecision`'s own sentence ("stance matured: Energy", "macro catalyst passed:
 * 2026-01-19", "no review in 34 days"). It is carried verbatim rather than re-worded into a code:
 * the trigger already reads as English, and a card that says only "review due" makes the user open
 * the desk to find out why they were asked.
 */
export function buildTiltReviewOffer(tilt, { reason = null, userId } = {}) {
    if (!userId) return null

    const rows   = Array.isArray(tilt?.tilts) ? tilt.tilts : []
    const regime = tilt?.regime?.name ? `${tilt.regime.name} — ` : ''
    const why    = reason ? ` — ${reason}` : ''

    return {
        userId,
        content: `Sector view due for review${why}. ${regime}${rows.length} ${rows.length === 1 ? 'stance' : 'stances'} standing; Pythia reaffirms what still holds rather than starting over.`,
        type:    REVIEW_CARD_TYPE,
        payload: {
            kind: 'tilt_review', tiltId: tilt?.id ?? null, benchmark: tilt?.benchmark ?? null,
            reason, regime: tilt?.regime?.name ?? null,
            stances:      rows.length,
            sectors:      rows.map(r => r?.sector).filter(Boolean),
            // What the desk owes a verdict ON. A matured stance is the sharp case: its window closed,
            // so it is a closed call the review has to grade rather than one it may simply reaffirm.
            matured:      rows.filter(r => r?.state === 'matured').map(r => r?.sector).filter(Boolean),
            published_at: tilt?.created_at ?? null,
        },
        botId:      'strategy',
        actions:    cardActions('Run the review'),
        visibility: 'admin',
    }
}

/**
 * Offer the review to every admin not already asked about this view. Never throws — the
 * caller is a monitor tick, and a card that cannot be delivered must not stop the daily grade.
 *
 * Returns the number of cards posted, so "asked nobody" is distinguishable from "asked twelve
 * people" in the log rather than both reading as a working notify.
 */
export async function notifyTiltReviewDue(tilt, { reason = null, nowMs = Date.now() } = {}, deps = _deps) {
    if (!tilt?.id) return 0

    // The window the dedupe reads over — see the header. `?? 0` is deliberate: a doc with no usable
    // anchor at all falls back to the REOFFER floor rather than to "since the epoch", which would
    // make every card ever posted count as an ask and mute the offer permanently.
    const anchor = reviewAnchorMs(tilt)
    const since  = Math.max(anchor ?? 0, nowMs - REOFFER_DAYS * DAY_MS)

    let userIds, already
    try {
        [userIds, already] = await Promise.all([
            deps.adminUserIds(),
            deps.recipientsSince(REVIEW_CARD_TYPE, since),
        ])
    } catch (err) {
        // The view is still due, and it stays due — the next tick asks again. Degrade to "nobody
        // asked today", never to a broken grade.
        logger.warn(LOG, 'review offer skipped — roster or dedupe read failed', err.message)
        return 0
    }

    const pending = (userIds ?? []).filter(id => !already.has(id))
    if (!pending.length) return 0   // the steady state once everyone has been asked — not worth a line

    const post = deps.post ?? postCard
    let posted = 0
    for (const userId of pending) {
        // postCard never throws; a user whose card fails is simply re-offered next tick, because the
        // dedupe reads posted cards and this one was never posted.
        if (await post(buildTiltReviewOffer(tilt, { reason, userId }), { tag: 'Tilt review offer', log: LOG })) posted++
    }
    logger.info(LOG, 'review offered', { id: tilt.id, reason, posted, users: userIds.length })
    return posted
}
