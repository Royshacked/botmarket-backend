// ECHO'S FORWARD TEST, READ (docs/design/echo-desk.md §7 step 1, 2026-11-19).
//
// The engine writes `echo_forward` (aether-engine echo/forward.py): one document per event, detected → mapped (or late)
// → checked (the day-5 market check, frozen) → done (graded at 20 / 60 / 120 sessions). This module only READS it, for
// the Hotlist's Echo section and Echo's desk. It never writes there: the forward test is the engine's, and a map the
// user asks for lives in `echo_user_events` (step 3), never in this collection.
//
// The running record shown here is NOT the verdict. The pass rule (forward.py, declared 2026-11-19 before any grade)
// reads ONCE, on the first 30 events graded at 120 sessions; every number before that is "so far", labelled so.

import { getEngineDb } from './engineDb.js'

export const COLLECTION = 'echo_forward'
export const HORIZONS = Object.freeze([20, 60, 120])      // validate.FORWARD
export const VERDICT_EVENTS = 30                          // forward.MIN_EVENTS — when the verdict reads
const LIST_LIMIT = 200

const _deps = { db: null }
/** Test-only: point the reader at a fake db. */
export function _setDeps(d) { Object.assign(_deps, d) }
const db = () => _deps.db ?? getEngineDb()

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

/** The graded stand-ins of one link at h (forward.py _stand_ins). */
function standIns(rows, ticker, h) {
    return rows
        .filter(r => r.group === 'random' && r.stand_in_for === ticker && Number.isFinite(r.forward?.[String(h)]))
        .map(r => r.forward[String(h)])
}

/** A link's spread at h: its signed excess minus the mean of its own stand-ins — null until both are graded. */
export function linkSpread(rows, row, h) {
    const v = row.forward?.[String(h)]
    if (!Number.isFinite(v)) return null
    const base = standIns(rows, row.ticker, h)
    return base.length ? v - mean(base) : null
}

/** The event's spread at h over its FLAGGED links (forward.py event_spread) — null when none is graded with stand-ins. */
export function eventSpread(rows, h) {
    const xs = (rows ?? []).filter(r => r.group === 'flagged').map(r => linkSpread(rows, r, h)).filter(Number.isFinite)
    return xs.length ? mean(xs) : null
}

/**
 * One link of the map, joined to its row of the frozen check when there is one. A link the check could not price, or a
 * map not checked yet, has `group: null`.
 */
function shapeLink(link, rows) {
    const row = link.ticker ? rows.find(r => r.ticker === link.ticker && r.group !== 'random') : null
    const spread = {}
    for (const h of HORIZONS) spread[h] = row ? linkSpread(rows, row, h) : null
    return {
        ticker:    link.ticker ?? null,
        name:      link.name,
        relation:  link.relation,
        layer:     link.layer,
        direction: link.direction,
        why:       link.evidence_text,
        note:      link.note ?? '',
        group:     row?.group ?? null,                 // flagged · unflagged · null (not checked / not priced / layer 1)
        reaction:  row?.reaction ?? null,              // day-5 excess vs SPY, signed by direction
        forward:   row?.forward ?? {},                 // { '20': x, '60': x, '120': x } signed excess from the day-5 close
        spread,                                        // { 20: x, … } minus its own stand-ins
    }
}

/** The summary row the Hotlist lists: the event, where it stands, its flagged names. */
export function shapeSummary(doc) {
    const ev = doc.event ?? {}
    const rows = doc.check?.rows ?? []
    const links = (doc.map?.links ?? []).map(l => shapeLink(l, rows))
    const spread = {}
    for (const h of HORIZONS) spread[h] = doc.grades?.[String(h)] ? eventSpread(rows, h) : null
    return {
        id:         doc._id,
        date:       ev.date,
        origin:     ev.origin,
        tickers:    ev.origin_tickers ?? [],
        effect:     ev.effect,
        size:       ev.size,
        status:     doc.status,                         // detected · mapped · late · checked · done
        checkDate:  doc.check?.check_date ?? null,
        links:      links.length,
        flagged:    links.filter(l => l.group === 'flagged'),
        graded:     HORIZONS.filter(h => doc.grades?.[String(h)]),
        spread,
    }
}

/** The whole event: the summary plus every link, what was dropped, and who mapped it. */
export function shapeEvent(doc) {
    const rows = doc.check?.rows ?? []
    return {
        ...shapeSummary(doc),
        event:  doc.event,
        map: doc.map ? {
            model:         doc.map.model,
            promptVersion: doc.map.prompt_version,
            mappedAt:      doc.map.mapped_at,
            directionRule: doc.map.direction_rule ?? null,
            dropped:       doc.map.dropped ?? [],
        } : null,
        all:    (doc.map?.links ?? []).map(l => shapeLink(l, rows)),
        grades: doc.grades ?? {},
        absent: doc.check?.absent ?? [],
    }
}

/**
 * The record SO FAR, per horizon, over every event graded there: how many, the mean spread, the share positive. Not the
 * verdict — `verdictAt` says how many events the verdict waits for at 120 sessions.
 */
export function runningRecord(docs) {
    const out = {}
    for (const h of HORIZONS) {
        const xs = docs.filter(d => d.grades?.[String(h)]).map(d => eventSpread(d.check?.rows ?? [], h)).filter(Number.isFinite)
        out[h] = { n: xs.length, mean: xs.length ? mean(xs) : null, positive: xs.length ? xs.filter(x => x > 0).length / xs.length : null }
    }
    return { ...out, verdictAt: VERDICT_EVENTS, gradedAt120: out[120].n }
}

/** GET list: the newest LIST_LIMIT events, and the running record over EVERY graded one (not only those listed). */
export async function listEvents() {
    const c = (await db()).collection(COLLECTION)
    const [docs, graded] = await Promise.all([
        c.find({}).sort({ 'event.date': -1 }).limit(LIST_LIMIT).toArray(),
        c.find({ grades: { $exists: true } }, { projection: { grades: 1, 'check.rows': 1 } }).toArray(),
    ])
    return { events: docs.map(shapeSummary), record: runningRecord(graded) }
}

/** GET one: the whole event, or null. */
export async function getEvent(id) {
    if (!id) return null
    const doc = await (await db()).collection(COLLECTION).findOne({ _id: String(id) })
    return doc ? shapeEvent(doc) : null
}

export const echoService = { listEvents, getEvent }
