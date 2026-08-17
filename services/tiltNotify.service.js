// Strategy-desk notifications (Pythia) — the house sector view moved, and someone whose book sits
// in that sector should hear about it.
//
// Mirrors coverageNotify exactly: a PURE builder (unit-tested) plus a thin wrapper over the shared
// postCard. Each agent owns its own card copy and payload and posts through the one transport —
// never a router (see the Axl decision: routing social chat through a central dispatcher was
// abandoned, and this must not quietly rebuild it).
//
// THE AUDIENCE PROBLEM, and why it is solved by a join rather than a fan-out. A tilt is a BROADCAST:
// one house view, no `userId`, deliberately never joined to anyone's book in storage. But every
// notifier in this app is driven by an entity that already carries an owner — the market-open
// monitor groups by `${userId}::${kind}` for exactly that reason — and postCard refuses a card with
// no owner, correctly ("no owner → nowhere to deliver").
//
// So the audience is DERIVED at delivery time from the thing that does have owners: coverage. A
// stance on Energy is news to whoever actually researches Energy names, and noise to everyone else.
// That keeps the storage rule intact (the view is never joined to a book), reuses the notification
// grain unchanged, and makes the pinned SECTORS vocabulary load-bearing — this is the join it was
// canonicalised for.

import { cardActions, listCardRecipientsSince } from '../api/chat/chat.service.js'
import { coverageService } from '../api/analyst/coverage.service.js'
import { listAllUserIds }  from '../api/user/user.model.js'
import { reviewAnchorMs, REVIEW_FLOOR_DAYS }    from '../monitoring/tilt.assess.js'
import { postCard }        from './notifyCard.js'
import { logger }          from './logger.service.js'

const LOG = '[tiltNotify]'

// Injectable so the audience join is testable without a DB. `listActiveBySector` is coverage's
// owner-blind sweep — the read this desk needs and the only one that puts a sector next to a user.
// The review offer needs neither (see below): it is a broadcast, so it reads the roster and the
// cards already posted instead.
const _deps = {
    listActiveBySector: (s)    => coverageService.listActiveBySector(s),
    allUserIds:         ()     => listAllUserIds(),
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
 * Build the tilt-change card for one user. Pure → `{ userId, content, type, payload, botId, actions }`
 * or null when there is nothing to say.
 *
 * `changes` is `diffStances(prev, next)` already narrowed to the sectors THIS user covers — the
 * caller does the narrowing, because who cares about what is a fact about the book, while how to
 * say it is this desk's judgment.
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
        botId:   'strategy',
        // A READ, not an ask: the house view is a STATE and there is nothing to revise from here,
        // so putting the board in front of the reader IS the whole job. One of only two cards that
        // opting out of the stays-alive default is honest for — its sibling below ("Run the review")
        // asks for work and keeps the default.
        actions: cardActions('Open sector view', { resolvesOn: 'open' }),
    }
}

/**
 * Post the tilt-change cards. Fire-and-forget; never throws into the monitor loop.
 *
 * Returns the number of cards posted, so a caller can log "told nobody" distinctly from "told
 * twelve people" — a silent zero here would look identical to a working notify.
 */
export async function notifyTiltChanged(tilt, changes, deps = _deps) {
    const moved = (Array.isArray(changes) ? changes : []).filter(c => c?.sector)
    if (!moved.length) return 0

    let byUser
    try {
        byUser = await audienceBySector(moved.map(c => c.sector), deps)
    } catch (err) {
        // A view that published but could not find its audience is still published. Degrade to
        // "nobody told" rather than failing the publish that already happened.
        logger.warn(LOG, 'audience lookup failed — no cards posted', err.message)
        return 0
    }

    let posted = 0
    for (const [userId, sectors] of byUser) {
        const mine = moved.filter(c => sectors.has(c.sector))
        const card = buildTiltEvent(tilt, mine, userId)
        // `?? postCard` because callers (tests) pass PARTIAL dep objects — a seam that is only ever
        // overridden must not turn every partial into a crash.
        if (await (deps.post ?? postCard)(card, { tag: 'Tilt-change card', log: LOG })) posted++
    }
    logger.info(LOG, 'tilt change notified', { sectors: moved.length, users: byUser.size, posted })
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
// WHY EVERY USER. A tilt has no owner by construction. The change card can narrow to whoever
// researches the moved sector, because that card is news ABOUT a book; this one is a request to
// re-examine the house view itself, which serves everyone equally.
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
        botId:   'strategy',
        actions: cardActions('Run the review'),
    }
}

/**
 * Offer the review to everyone who has not already been asked about this view. Never throws — the
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
            deps.allUserIds(),
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

/**
 * Who researches these sectors → `Map<userId, Set<sector>>`.
 *
 * The coverage book is the only place a sector meets an owner, so the sweep is owner-BLIND and the
 * grouping right here is what re-scopes it — each user is then told about their own sectors and no
 * one else's.
 */
export async function audienceBySector(sectors, deps = _deps) {
    const want = new Set(sectors)
    const out  = new Map()
    for (const c of (await deps.listActiveBySector([...want])) ?? []) {
        if (!c?.userId || !want.has(c?.sector)) continue
        if (!out.has(c.userId)) out.set(c.userId, new Set())
        out.get(c.userId).add(c.sector)
    }
    return out
}
