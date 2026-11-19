// ECHO'S EVENT — Step 1's record (docs/design/echo-pipeline.md; the simulator doc's "Fields to record per event").
//
// ONE collection, `echo_events`, for every event whatever brought it in — the intake (the house's, everyone's) or a user
// in chat (theirs: `userId`). Every step of the pipeline writes its part onto the same document:
//   framed → mapped (Step 2) → scored (Step 3) → checked (Step 4) → watching (Step 5) → expired.
//
// The fields are the doc's: date and time (`timing`), type, origin (company or country) and its tickers, what changed,
// size, DURABILITY ("the most important field" — with its reason), the effect at the origin, what it follows up, the
// sources. And the doc's filter: an item is an event only if it is a SURPRISE, LARGE relative to the companies it
// touches, and MORE THAN A ONE-OFF — recorded with the reason, because the intake's model decides it.

import { randomUUID } from 'node:crypto'
import { getDb } from '../providers/mongodb.provider.js'

export const COLLECTION = 'echo_events'
export const TYPES = Object.freeze(['demand_shock', 'supply_shock', 'policy', 'clinical', 'geopolitical', 'capacity_deal', 'confirmation'])
// The doc's backstop table (Step 5): the kind of effect, and so how long it may live at most.
export const DURABILITIES = Object.freeze(['price_spike', 'policy_follow_through', 'drug_class_shift', 'multi_year_commitment'])
export const TIMINGS = Object.freeze(['before_open', 'during_session', 'after_close'])
// What the event does to demand AT THE ORIGIN — what turns a link's relation into a direction. Mixed leaves every link
// unclear.
export const EFFECTS = Object.freeze(['up', 'down', 'mixed'])
export const STATUSES = Object.freeze(['framed', 'mapped', 'scored', 'checked', 'watching', 'expired'])

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const text = (x, max) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const asList = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x])

/**
 * Check and tidy an event's Step 1 fields. → `{ ok: true, event }` or `{ ok: false, reason }` (the reason is said to the
 * model that framed it, so it can fix the field). Pure.
 *
 * TIMING unknown → `after_close`: Day 0 is then the NEXT session's open — the doc's rule for the after-close case and
 * the only one that cannot count a reaction that came before the news.
 */
export function frame(input = {}, today = new Date().toISOString().slice(0, 10)) {
    const whatChanged = text(input.what_changed ?? input.whatChanged, 400)
    const origin = text(input.origin, 120)
    if (!whatChanged) return { ok: false, reason: 'what_changed is required — one sentence: what happened' }
    if (!origin) return { ok: false, reason: 'origin is required — the company or country the event hits directly, or the demand it moves' }
    const effect = input.effect
    if (!EFFECTS.includes(effect)) return { ok: false, reason: 'effect must be up, down or mixed — what the event does to demand at the origin' }
    const type = input.type ?? 'demand_shock'
    if (!TYPES.includes(type)) return { ok: false, reason: `type must be one of ${TYPES.join(', ')}` }
    const dk = input.durability?.kind ?? input.durability
    if (!DURABILITIES.includes(dk)) return { ok: false, reason: `durability must be one of ${DURABILITIES.join(', ')} — a locked-in commitment lasts, a price spike cures itself` }
    const timing = input.timing ?? 'after_close'
    if (!TIMINGS.includes(timing)) return { ok: false, reason: `timing must be one of ${TIMINGS.join(', ')}` }
    const tickers = [...new Set(asList(input.tickers ?? input.origin_tickers ?? input.originTickers).map(t => String(t ?? '').trim().toUpperCase().replace(/\./g, '-')).filter(Boolean))]
    const bad = tickers.find(t => !TICKER.test(t))
    if (bad) return { ok: false, reason: `not a ticker: ${bad}` }
    const date = input.date == null || input.date === '' ? today : String(input.date)
    if (!DATE.test(date)) return { ok: false, reason: 'date must be YYYY-MM-DD' }
    const f = input.filter ?? {}
    return {
        ok: true,
        event: {
            date, timing, type, origin, originTickers: tickers,
            terms: [...new Set(asList(input.terms).map(t => text(t, 60)).filter(Boolean))].slice(0, 6),
            whatChanged, size: text(input.size, 300) || null,
            durability: { kind: dk, why: text(input.durability?.why ?? input.durability_why, 300) || null },
            effect,
            followUpOf: input.follow_up_of ?? input.followUpOf ?? null,
            sources: asList(input.sources).map(s => text(s, 300)).filter(Boolean).slice(0, 8),
            filter: {
                surprise: f.surprise ?? null, large: f.large ?? null, lasting: f.lasting ?? null,
                why: text(f.why, 400) || null,
            },
            horizon: input.horizon ? String(input.horizon).toLowerCase() : null,
        },
    }
}

/** The doc's three-part filter: a surprise, large, and more than a one-off — all three, said yes. Pure. */
export const passesFilter = (ev) => ev?.filter?.surprise === true && ev.filter.large === true && ev.filter.lasting === true

const _deps = { db: null, now: () => new Date(), id: () => `ev_${randomUUID()}` }
export function _setDeps(d) { Object.assign(_deps, d) }
const coll = async () => (_deps.db ?? await getDb()).collection(COLLECTION)

/** Store a framed event. `userId` null → the house's. → the stored document. */
export async function create(event, { userId = null, source = null, id = null } = {}) {
    const now = _deps.now().toISOString()
    const doc = {
        _id: id ?? _deps.id(), kind: userId ? 'user' : 'house', userId: userId ? String(userId) : null, source,
        ...event, status: 'framed', createdAt: now, updatedAt: now,
    }
    await (await coll()).insertOne(doc)
    return doc
}

/** One event: the house's for anyone, a user's only for them. → the document or null. */
export async function get(id, userId = null) {
    const d = await (await coll()).findOne({ _id: String(id) })
    if (!d) return null
    if (d.kind === 'user' && d.userId !== String(userId ?? '')) return null
    return d
}

/** Write a step's part onto the event and move its status. */
export async function advance(id, status, patch = {}) {
    if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`)
    await (await coll()).updateOne({ _id: String(id) }, { $set: { ...patch, status, updatedAt: _deps.now().toISOString() } })
}

/** The house's events and the user's own, newest first. */
export async function list({ userId = null, status = null, limit = 100 } = {}) {
    const q = { $or: [{ kind: 'house' }, ...(userId ? [{ kind: 'user', userId: String(userId) }] : [])] }
    if (status) q.status = Array.isArray(status) ? { $in: status } : status
    return (await coll()).find(q).sort({ date: -1, createdAt: -1 }).limit(Math.min(limit, 500)).toArray()
}

export const echoEventsService = { frame, passesFilter, create, get, advance, list }
