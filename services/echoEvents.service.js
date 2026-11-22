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
    // A REAL date, not ahead of today (CR 2026-11-19: 2026-13-01 passed the pattern, then failed the check every hour).
    const parsed = new Date(`${date}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return { ok: false, reason: `${date} is not a real date` }
    if (date > today) return { ok: false, reason: `${date} is in the future — an event is recorded once it is public` }
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

/**
 * Store a framed event. `userId` null → the house's. `askedBy` — a user's event Echo judged an event by the doc's filter
 * becomes the HOUSE's (Roy, 2026-11-19: "Echo decides if the user's event is worth it — if it is, it treats it as a
 * regular event"); `askedBy` keeps whose it was, for their "yours". → the stored document.
 */
export async function create(event, { userId = null, source = null, id = null, askedBy = null } = {}) {
    const now = _deps.now().toISOString()
    const doc = {
        _id: id ?? _deps.id(), kind: userId ? 'user' : 'house', userId: userId ? String(userId) : null, source,
        ...(askedBy ? { askedBy: String(askedBy) } : {}),
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

/** Write a step's part onto the event and move its status; the run's claim is released. */
export async function advance(id, status, patch = {}) {
    if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`)
    await (await coll()).updateOne({ _id: String(id) }, { $set: { ...patch, status, updatedAt: _deps.now().toISOString() }, $unset: { runningUntil: '' } })
}

export const CLAIM_MS = 15 * 60 * 1000
/**
 * Claim an event for one run (CR 2026-11-19: chat's map_event and the hourly tick mapped the same event at once, two
 * Opus calls). → the claimed document, or null when another run holds it (a claim lapses after 15 minutes — a run that
 * died leaves no lock behind).
 */
export async function claim(id) {
    const now = _deps.now()
    const r = await (await coll()).findOneAndUpdate(
        { _id: String(id), $or: [{ runningUntil: { $exists: false } }, { runningUntil: { $lt: now.toISOString() } }] },
        { $set: { runningUntil: new Date(now.getTime() + CLAIM_MS).toISOString() } },
        { returnDocument: 'after' },
    )
    return r ?? null   // driver v6: the document itself (null when the filter matched nothing)
}

/** The house's events and the user's own (made or asked for), newest first. */
export async function list({ userId = null, status = null, limit = 100 } = {}) {
    const q = { $or: [{ kind: 'house' }, ...(userId ? [{ kind: 'user', userId: String(userId) }] : [])] }
    if (status) q.status = Array.isArray(status) ? { $in: status } : status
    return (await coll()).find(q).sort({ date: -1, createdAt: -1 }).limit(Math.min(limit, 500)).toArray()
}

/**
 * Every event a step has to run on NOW (the pipeline's tick): open, not given up, and due — a failed step backs off and a
 * check waits for its close (`nextRunAt`). Soonest due first, so stuck or waiting events cannot crowd out new ones.
 */
export async function listOpen({ limit = 200 } = {}) {
    const now = _deps.now().toISOString()
    return (await coll()).find({
        status: { $in: ['framed', 'mapped', 'scored'] }, gaveUp: { $ne: true },
        $or: [{ nextRunAt: { $exists: false } }, { nextRunAt: null }, { nextRunAt: { $lte: now } }],
    }).sort({ nextRunAt: 1, createdAt: 1 }).limit(limit).toArray()
}

/**
 * The house's event this one repeats — the same type on the same date about the same origin (a ticker in common, or
 * the same origin name) — or null. Two sources telling one event (the 8-K and the news of a deal) must not be two votes.
 */
export async function findSame(ev) {
    const q = { kind: 'house', type: ev.type, date: ev.date }
    const same = await (await coll()).find(q).limit(50).toArray()
    const name = String(ev.origin ?? '').toLowerCase()
    return same.find(d => (ev.originTickers ?? []).some(t => (d.originTickers ?? []).includes(t)) || String(d.origin ?? '').toLowerCase() === name) ?? null
}

/** The house's events under the wave watch (Step 5) — a user's own event is checked only (Roy, 2026-11-19). */
export async function listWatching({ limit = 300 } = {}) {
    return (await coll()).find({ status: 'watching', kind: 'house' }).sort({ date: -1 }).limit(limit).toArray()
}

/**
 * The house's checked events with a horizon to grade NOW (Step 7) — watched or expired (expiry stops the watch, not the
 * grading), their next grade due (`nextGradeAt`, set from the calendar — CR 2026-11-19: every one re-fetched ~40 names
 * an hour between horizons).
 */
export async function listGradable({ limit = 300 } = {}) {
    const now = _deps.now().toISOString()
    return (await coll()).find({
        kind: 'house', status: { $in: ['watching', 'expired'] }, 'check.checkDay': { $exists: true }, 'grades.120': { $exists: false },
        $or: [{ nextGradeAt: { $exists: false } }, { nextGradeAt: null }, { nextGradeAt: { $lte: now } }],
    }).sort({ nextGradeAt: 1, date: 1 }).limit(limit).toArray()
}

/** Every graded event (the validation report). */
export async function listGraded({ limit = 1000 } = {}) {
    return (await coll()).find({ kind: 'house', grades: { $exists: true } }).sort({ date: 1 }).limit(limit).toArray()
}

/** The statuses an event's map stands in: mapped and on (expired ones are history, framed ones have no map yet). */
export const MAPPED = Object.freeze(['mapped', 'scored', 'checked', 'watching'])

/**
 * The events that REACH one company (docs/design/axl-one-voice.md §2, Roy 2026-11-21: "if I ask about a company, Axl can
 * also check with Echo if this company is prone to be affected by an event"): the house's mapped events and the user's
 * own whose map links the ticker — each with how it reaches it (the link) and, once scored, its score and its check.
 * Newest first. → [{ id, kind, date, type, origin, whatChanged, status, link, score, flag }]
 */
export async function eventsFor(ticker, { userId = null, limit = 20 } = {}) {
    const t = String(ticker ?? '').trim().toUpperCase().replace(/\./g, '-')
    if (!TICKER.test(t)) return []
    const docs = await (await coll()).find({
        'map.links.ticker': t, status: { $in: MAPPED },
        $or: [{ kind: 'house' }, ...(userId ? [{ kind: 'user', userId: String(userId) }] : [])],
    }).project({ kind: 1, date: 1, type: 1, origin: 1, whatChanged: 1, status: 1, map: 1, scores: 1, check: 1, hypothetical: 1 })
        .sort({ date: -1, createdAt: -1 }).limit(Math.min(limit, 50)).toArray()
    return docs.map(d => {
        const link  = (d.map?.links ?? []).find(l => l.ticker === t) ?? null
        const score = (d.scores?.links ?? []).find(l => l.ticker === t) ?? null
        const check = (d.check?.links ?? []).find(l => l.ticker === t) ?? null
        return {
            id: d._id, kind: d.kind, date: d.date ?? null, type: d.type ?? null, origin: d.origin ?? null, whatChanged: d.whatChanged ?? null, status: d.status,
            hypothetical: d.hypothetical === true,
            link: link ? { relation: link.relation ?? null, layer: link.layer ?? null, direction: link.direction ?? null, why: link.why ?? null, confidence: link.confidence ?? null } : null,
            score: Number.isFinite(score?.total) ? score.total : null,
            flag: check?.flag ?? null,
        }
    })
}

/** The lookup by company reads the map's links — a multikey index (the M0's 512 MB: one small index). */
export async function ensureEchoEventIndexes() {
    await (await coll()).createIndex({ 'map.links.ticker': 1, date: -1 })
}

export const echoEventsService = { frame, passesFilter, create, get, advance, claim, list, listOpen, listWatching, listGradable, listGraded, findSame, eventsFor }
