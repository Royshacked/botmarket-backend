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

import { cardActions }     from '../api/chat/chat.service.js'
import { coverageService } from '../api/analyst/coverage.service.js'
import { postCard }        from './notifyCard.js'
import { logger }          from './logger.service.js'

const LOG = '[tiltNotify]'

// Injectable so the audience join is testable without a DB. `listActiveBySector` is coverage's
// owner-blind sweep — the read this desk needs and the only one that puts a sector next to a user.
const _deps = { listActiveBySector: (s) => coverageService.listActiveBySector(s) }

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
        actions: cardActions('Open sector view'),
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
        if (await postCard(card, { tag: 'Tilt-change card', log: LOG })) posted++
    }
    logger.info(LOG, 'tilt change notified', { sectors: moved.length, users: byUser.size, posted })
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
