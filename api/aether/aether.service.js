// Read helpers for the Aether DB collections.
//
// Node.js is read-only here — Python writes, and only ever when an admin starts a run.
//
// EIGHTEEN READERS WENT on 2026-09-09 with the channel engine: channel state, regime,
// forecasts, calibration, taxonomy, portfolio slots, interference, loss surface, edge
// candidates, decay audit, shock predictions, validation outcomes, predicted signals,
// opportunity cards, predicted channel state, per-ticker cards and the exposure assembler.
// Every one read a collection Python had stopped writing, and a stale read is worse than a
// missing one — it looks exactly like a current answer.

import { getDb }     from '../../providers/mongodb.provider.js'
import { COLLECTIONS } from './aether.model.js'
import { logger }    from '../../services/logger.service.js'

const LOG = '[aetherService]'

/**
 * Group flat candidate rows into their events, newest event first, best rank first
 * inside it.
 *
 * The event is the unit a reader reasons about — "this happened, and these names are
 * exposed to it" — so a flat ticker list loses the question the names answer. The event
 * fields are denormalised onto every candidate by the engine, so the first row of a run
 * carries the header; `?? ''` throughout because a field added later (event_category) is
 * absent on every row stored before it existed.
 *
 * Exported so the grouping can be tested without a database.
 */
export function groupCandidatesByRun(rows) {
    const byRun = new Map()
    for (const r of rows) {
        if (!byRun.has(r.run_id)) {
            byRun.set(r.run_id, {
                run_id:         r.run_id,
                subject:        r.subject ?? '',
                event:          r.event ?? '',
                answer_shape:   r.answer_shape ?? '',
                // trade / fiscal / regulatory / geopolitical / macro / disruption.
                event_category: r.event_category ?? '',
                event_date:     r.event_date ?? '',
                created_at:     r.created_at ?? '',
                candidates:     [],
            })
        }
        byRun.get(r.run_id).candidates.push(r)
    }

    const runs = [...byRun.values()]
    for (const run of runs) run.candidates.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    return runs
}

/**
 * Event candidates for the desk list, newest event first, best rank first inside it.
 *
 * SURVIVORS ONLY BY DEFAULT. Every candidate is stored — including the ones a gate
 * dropped, with the reason — because a filter whose rejections leave no trace can never
 * be shown to be wrong. That is a storage rule; showing them is a display decision, and
 * the screen wants the shortlist. Pass includeDropped to see the rest.
 */
export async function getEventCandidates({ days = 30, includeDropped = false, limit = 200 } = {}) {
    try {
        const db    = await getDb()
        const since = new Date(Date.now() - days * 86_400_000).toISOString()
        const query = { created_at: { $gte: since } }
        if (!includeDropped) query.survived = true

        const rows = await db.collection(COLLECTIONS.EVENT_CANDIDATES)
            .find(query, { projection: { _id: 0 } })
            .limit(limit)
            .toArray()

        return groupCandidatesByRun(rows)
    } catch (err) {
        // THROWN, NOT SWALLOWED. This returned [] on failure, which is indistinguishable
        // from a window with no runs in it — and on 2026-09-10 a DNS wobble at Atlas took
        // every read in the app down while this screen calmly reported "No events in the
        // window. Nothing has run recently." Twice. The controller answers 500 and the
        // client says the read failed; an empty list now means an empty list.
        logger.warn(LOG, 'getEventCandidates failed', err.message)
        throw err
    }
}

/**
 * Every event that has reached one company, best-evidenced first.
 *
 * The list answers "what has Aether found"; this answers "why is THIS name here", which is
 * the question someone arrives with from anywhere else in the app — a position, a chart, a
 * search. Cheap: `ticker` is indexed, and a name appears in a handful of events at most.
 *
 * DROPPED APPEARANCES ARE INCLUDED BY DEFAULT, and that is the deliberate difference from
 * getEventCandidates. The list hides them because a screen wants a shortlist. Here the
 * reader already has the name in mind, so "nothing found" would be a lie when the truth is
 * "the tariff run named it and dropped it for having no direction" — which is an answer,
 * and often the useful one. Each appearance carries `survived` and its reason.
 *
 * Returns null for a ticker the engine has never named, so a caller can say so rather than
 * render an empty shell.
 */
export async function getCandidatesForTicker(ticker, { days = 90, includeDropped = true } = {}) {
    // Normalised and validated before it reaches Mongo: this comes off a URL path.
    //
    // NOT TRUNCATED. `slice(0, 12)` before the test turned forty characters of junk into a
    // perfectly valid twelve-character ticker and queried for it — inventing a symbol the
    // caller never asked about and answering as if it were the question. The regex bounds
    // the length itself, so anything too long is refused rather than trimmed into shape.
    //
    // BRK.B and RDS-A are both real tickers, so dot and dash belong in the class; the dash
    // is last so it needs no escape.
    const sym = String(ticker ?? '').trim().toUpperCase()
    if (!/^[A-Z0-9.-]{1,12}$/.test(sym)) return null

    const db    = await getDb()
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const query = { ticker: sym, created_at: { $gte: since } }
    if (!includeDropped) query.survived = true

    const rows = await db.collection(COLLECTIONS.EVENT_CANDIDATES)
        .find(query, { projection: { _id: 0 } })
        .toArray()

    return shapeTickerResult(sym, rows)
}

/**
 * The answer's shape, separated from the read so it can be tested without a database —
 * the same split groupCandidatesByRun uses, for the same reason.
 */
export function shapeTickerResult(sym, rows = []) {
    if (!rows.length) return null

    // Best rank first: the strongest claim about this name leads, whichever event made it.
    // Copied rather than sorted in place — the caller's array is not ours to reorder.
    const appearances = [...rows].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    return {
        ticker: sym,
        appearances,
        events: appearances.length,
        // The headline a caller wants without re-deriving it: is anything here still live?
        // `=== true` on purpose — an appearance stored before survival ran is `undefined`,
        // which is not a claim that it survived.
        survived: appearances.some(r => r.survived === true),
        best: appearances[0],
    }
}

/** The window, clamped. It comes off a query string, so it is never trusted as given. */
export function tickerWindowDays(raw) {
    return Math.min(Math.max(Number(raw) || 90, 1), 365)
}
