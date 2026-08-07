/**
 * The daily market-brief OFFER.
 *
 * Once each weekday morning every user gets one card in the social chat: "want today's market
 * brief?". Nothing is written until they confirm — the confirm takes the user to Axl and streams
 * the brief into his thread (POST /api/axl/brief/stream), which is where it is actually built.
 * The brief itself never lands in the social chat: it is a page of market prose, and it belongs in
 * the conversation where the user can ask about it.
 *
 * ── WHY OFFER INSTEAD OF JUST POSTING THE BRIEF ──────────────────────────────
 * A broadcast nobody asked for is spam, and a long unread wall of market prose every morning is
 * exactly what the removed news feed felt like. The card is one line; the brief only exists for the
 * people who wanted it that day. It also means the morning fan-out costs no LLM tokens at all —
 * the first confirm builds the brief, and every later confirm that hour reads the same cached one
 * (marketBrief.service).
 *
 * ── DEDUPE ──────────────────────────────────────────────────────────────────
 * "Has this user had today's?" is answered by looking for the card itself, not by a flag we
 * maintain. A restart mid-fan-out therefore resumes correctly instead of double-posting, and there
 * is no second source of truth to drift.
 *
 * Reversibility: remove `marketBriefNotifier.start()` from server.js. Nothing else references it.
 */

import { getDb }        from '../providers/mongodb.provider.js'
import { logger }       from '../services/logger.service.js'
import { postCard }     from '../services/notifyCard.js'
import { cardActions, listCardRecipientsSince } from '../api/chat/chat.service.js'
import { COLLECTION as USERS } from '../api/user/user.model.js'
import { createPollLoop } from './pollLoop.js'
import { config } from '../services/config.js'

const LOG = '[marketBriefNotify]'

export const CARD_TYPE = 'market_brief_offer'

const ENABLED  = config.marketBriefOffer
const POLL_MS  = 15 * 60 * 1000
/**
 * The hour (UTC) the offer goes out — 12:00 UTC is ~an hour before the US open, late enough that
 * Asia has closed and Europe is well into its session, so the brief has a full overnight to report.
 */
const OFFER_HOUR_UTC = config.marketBriefOfferHourUtc

const CARD_TEXT = "Want today's market brief? A quick read on global markets, macro and the calendar."

/** UTC midnight for the day containing `now` — the dedupe window. Pure. */
export function _dayStart(now) {
    const d = new Date(now)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/**
 * Is this a moment to offer a brief? Weekday, and past the offer hour. Pure — exported so the
 * window rule is testable without a clock or a database.
 *
 * There is no upper bound on the hour: the point is that everyone gets exactly one card per
 * weekday, and the dedupe (not the window) is what enforces that. A server started at 20:00 still
 * offers the day's brief rather than silently skipping the day.
 */
export function _isOfferTime(now, offerHourUtc = OFFER_HOUR_UTC) {
    const d = new Date(now)
    const day = d.getUTCDay()
    if (day === 0 || day === 6) return false        // markets shut, nothing to brief
    return d.getUTCHours() >= offerHourUtc
}

async function _allUserIds() {
    const db = await getDb()
    const rows = await db.collection(USERS).find({}, { projection: { id: 1 } }).toArray()
    return rows.map(r => r?.id).filter(Boolean).map(String)
}

async function _tick(deps = {}) {
    const {
        userIds = _allUserIds,
        recipients = listCardRecipientsSince,
        post = postCard,
        now = Date.now(),
    } = deps

    if (!_isOfferTime(now)) return { offered: 0, skipped: 'window' }

    const [ids, already] = await Promise.all([
        userIds(),
        recipients(CARD_TYPE, _dayStart(now)),
    ])

    const pending = ids.filter(id => !already.has(id))
    if (!pending.length) return { offered: 0, skipped: 'all-sent' }

    let offered = 0
    for (const userId of pending) {
        // postCard never throws — a user whose card fails is simply retried on the next tick,
        // because the dedupe reads posted cards and this one was never posted.
        const msg = await post(
            {
                userId,
                content: CARD_TEXT,
                type: CARD_TYPE,
                payload: { day: new Date(_dayStart(now)).toISOString().slice(0, 10) },
                actions: cardActions('Get the brief'),
            },
            { tag: 'Brief offer', log: LOG },
        )
        if (msg) offered++
    }

    logger.info(LOG, 'offers posted', { offered, pending: pending.length })
    return { offered }
}

const _loop = createPollLoop({ intervalMs: POLL_MS, tick: _tick, eager: true, log: LOG, name: 'brief offer' })

export const marketBriefNotifier = {
    start() {
        if (!ENABLED) { logger.info(LOG, 'disabled (MARKET_BRIEF_OFFER=off)'); return }
        _loop.start()
    },
    stop: _loop.stop,
    _tick,   // test seam
}
