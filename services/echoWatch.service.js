// ECHO, STEP 5 — THE WAVE WATCH AND EXPIRY (docs/design/echo-pipeline.md; the simulator doc's Step 5).
//
// "The biggest moves often came on a follow-up event, not the original one" (Germany's €100B fund four days after the
// invasion; Walmart's smaller baskets two months after the Wegovy trial). Each watched event keeps a list of TRIGGERS
// for its mapped companies, and each trigger re-runs Steps 3 and 4 (at most once a day):
//   follow_up  a new event the intake marked as following this one (it is its own event, as the doc says);
//   earnings   a high-scoring or flagged mapped company reported (the doc: "earnings from a mapped company");
//   filing     one of them filed a business document naming the origin (the doc: "8-Ks ... that mention the event").
//
// EXPIRY, whichever comes first (the doc's three), else the backstop by durability:
//   resolved    a follow-up the intake said resolves the driver (supply caught up, the commitment spent or reversed);
//   absorbed    analysts have written on the flagged names since the event — "the link is no longer hidden";
//   normalised  the flagged names' excess over their sector at noise (under 3%) for 30 sessions with no trigger moving
//               them (the doc's 20–40, its middle);
//   backstop    price spike ~3 months (63 sessions), policy follow-through and drug-class shift ~a year (252), a
//               multi-year commitment ~3 years (756), re-checked each quarter.
// Expiry stops the watch and new flags; it never closes a trade (those exit by their own stop).

import { readCalendarWindow } from '../providers/fmp.provider.js'
import { echoEventsService } from './echoEvents.service.js'
import { namedIn } from './echoFilings.service.js'
import { originTerms } from './echoChain.service.js'
import { scoreEvent } from './echoScore.service.js'
import { checkEvent } from './echoCheck.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoWatch]'
export const RESCORE_EVERY_MS = 24 * 60 * 60 * 1000
export const NOISE = 0.03
export const NORMALISED_SESSIONS = 30
export const ABSORBED_ACTIONS = 2
export const BACKSTOP_SESSIONS = { price_spike: 63, policy_follow_through: 252, drug_class_shift: 252, multi_year_commitment: 756 }
const SESSIONS_PER_DAY = 252 / 365

/** The names the watch follows: flagged or high-scoring links. Pure. */
export function watched(ev) {
    const high = new Set((ev.scores?.links ?? []).filter(s => s.high).map(s => s.ticker))
    const flagged = new Set((ev.check?.links ?? []).filter(l => l.flag === 'underreacted_winner' || l.flag === 'overreacted_loser').map(l => l.ticker))
    return [...new Set([...flagged, ...high])]
}

/** Sessions between two dates, approximately (252 a year) — for the backstop and the noise window. Pure. */
export const sessionsBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000 * SESSIONS_PER_DAY))

/**
 * The doc's expiry, whichever comes first. → `{ expired: bool, reason }`. Pure on the event, its triggers and today.
 */
export function expiry(ev, today) {
    const triggers = ev.triggers ?? []
    if (triggers.some(t => t.resolves)) return { expired: true, reason: 'resolved — a follow-up resolved the driver' }
    const flagged = (ev.check?.links ?? []).filter(l => l.flag === 'underreacted_winner' || l.flag === 'overreacted_loser')
    if (flagged.length && flagged.every(l => (l.analysts?.count ?? 0) >= ABSORBED_ACTIONS)) {
        return { expired: true, reason: `absorbed — analysts have written on every flagged name since the event (${ABSORBED_ACTIONS}+ actions each)` }
    }
    const since = ev.check?.day0 ?? ev.date
    const age = sessionsBetween(since, today)
    const lastMove = triggers.length ? triggers.map(t => t.at.slice(0, 10)).sort().at(-1) : since
    const quiet = sessionsBetween(lastMove, today)
    const at20 = flagged.map(l => l.moves?.[20]?.xsSector).filter(Number.isFinite)
    if (flagged.length && at20.length === flagged.length && at20.every(x => Math.abs(x) < NOISE) && quiet >= NORMALISED_SESSIONS) {
        return { expired: true, reason: `normalised — the flagged names within ${NOISE * 100}% of their sector, ${quiet} sessions with no trigger` }
    }
    const max = BACKSTOP_SESSIONS[ev.durability?.kind] ?? 63
    if (age >= max) return { expired: true, reason: `backstop — a ${String(ev.durability?.kind).replace(/_/g, ' ')} lives at most ${max} sessions` }
    return { expired: false, reason: null }
}

const _deps = { events: echoEventsService, calendar: readCalendarWindow, namedIn, score: scoreEvent, check: checkEvent, now: () => new Date(), sleep: (ms) => new Promise(r => setTimeout(r, ms)) }
export function _setDeps(d) { Object.assign(_deps, d) }

/** New triggers since `since` for the watched names: their earnings and their filings naming the origin. */
export async function findTriggers(ev, since, today) {
    const names = watched(ev)
    if (!names.length) return []
    const out = []
    const rows = await _deps.calendar(since, today).catch(() => [])
    for (const r of rows ?? []) {
        if (names.includes(r.symbol) && r.epsActual != null && r.date > since) out.push({ kind: 'earnings', ticker: r.symbol, date: r.date, what: `${r.symbol} reported (EPS ${r.epsActual} vs ${r.epsEstimated ?? '?'} est)` })
    }
    const terms = originTerms(ev)
    for (const t of names) {
        const n = await _deps.namedIn(t, terms)
        const fresh = (n.filings ?? []).filter(f => f.date > since)
        if (fresh.length) out.push({ kind: 'filing', ticker: t, date: fresh[0].date, what: `${t}'s ${fresh[0].form} names ${ev.origin}${n.excerpt ? `: "${n.excerpt.slice(0, 200)}"` : ''}`, url: fresh[0].url })
        await _deps.sleep(150)
    }
    return out
}

/**
 * One watched event: new triggers recorded; Steps 3 and 4 re-run on a trigger (at most once a day); expiry. → `{ id,
 * triggers, rescored, expired, reason }`. Never throws.
 */
export async function watchEvent(ev) {
    const now = _deps.now()
    const today = now.toISOString().slice(0, 10)
    try {
        const since = ev.watchedAt?.slice(0, 10) ?? ev.check?.checkDay ?? ev.date
        const found = await findTriggers(ev, since, today)
        const triggers = [...(ev.triggers ?? []), ...found.map(t => ({ ...t, at: now.toISOString() }))]
        let { scores, check } = ev
        let rescored = false
        const pending = triggers.some(t => !t.rescoredAt)
        const lastRescore = ev.rescoredAt ? Date.parse(ev.rescoredAt) : 0
        if (pending && now.getTime() - lastRescore >= RESCORE_EVERY_MS) {
            const s = await _deps.score(ev, ev.map, { userId: ev.kind === 'user' ? ev.userId : null })
            if (s.ok) {
                scores = s.scores
                const c = await _deps.check({ ...ev, scores }, ev.map, scores)
                if (c.ok) check = c.check
                rescored = true
                for (const t of triggers) t.rescoredAt ??= now.toISOString()
            }
        }
        const exp = expiry({ ...ev, triggers, check }, today)
        await _deps.events.advance(ev._id, exp.expired ? 'expired' : 'watching', {
            triggers, scores, check, watchedAt: now.toISOString(), ...(rescored ? { rescoredAt: now.toISOString() } : {}),
            ...(exp.expired ? { expiredAt: now.toISOString(), expiredBecause: exp.reason } : {}),
        })
        return { id: ev._id, triggers: found.length, rescored, expired: exp.expired, reason: exp.reason }
    } catch (err) {
        logger.warn(LOG, 'watch failed', { event: ev._id, error: err.message })
        return { id: ev._id, triggers: 0, rescored: false, expired: false, reason: err.message }
    }
}

/** A follow-up event's mark on the event it follows (the intake's): the trigger, and whether it resolves the driver. */
export async function markFollowUp(parentId, child, resolves = false) {
    const parent = await _deps.events.get(parentId)
    if (!parent || parent.status === 'expired') return false
    const triggers = [...(parent.triggers ?? []), { kind: 'follow_up', eventId: child._id, date: child.date, what: child.whatChanged, resolves: Boolean(resolves), at: _deps.now().toISOString() }]
    await _deps.events.advance(parentId, parent.status, { triggers })
    return true
}

export const echoWatchService = { watchEvent, findTriggers, expiry, watched, markFollowUp }
