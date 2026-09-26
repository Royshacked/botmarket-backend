// Prometheus over a whole radar list, and the cut that follows the reads.
//
// THE LEG. Argus has already cut the board to a handful on tradeability. This is the step after:
// each survivor gets the quick read it would have got from the button, and then the list is cut
// again — on what the record says rather than on what the tape looks like.
//
// WHY IT RUNS HERE AND NOT BEFORE ARGUS. A read is one model call per name; Argus's cut is two
// batch calls for the whole board. Running the expensive filter second means it only ever sees
// names that already have a catalyst and a setup — a veto on a handful, not a score on a hundred.
//
// THE RUN ID PROBLEM. quickRead is keyed (run_id, ticker), and Argus's <scan_list> carries only
// tickers — the model emits its own candidate shape and nothing makes it echo an id it was never
// given. So the run is RESOLVED here: the name's best-ranked surviving appearance in the window,
// which is the strongest live claim about it. That is also the row a reader would have pressed.
// It matters less than it looks: the read weighs every live event naming the ticker whichever row
// starts it, and `net` is the answer across all of them.
//
// NOTHING IS DROPPED SILENTLY, here either. A name the cut refuses comes back with the reason.

import { getCandidatesForTicker } from '../api/aether/aether.service.js'
import { quickRead } from './aetherQuickRead.service.js'
import { TICKER_RE } from '../api/aether/aether.model.js'
import { logger } from './logger.service.js'
import { httpError } from './httpError.util.js'

const LOG = '[aetherBatchRead]'

/**
 * How many names one batch will read.
 *
 * A ceiling on spend AND on the wall clock, and the second is what sets the number. The reads run
 * one after another and a single one takes 35-45s (aetherQuickRead's own timeout note), so a batch
 * is minutes long by construction — and the client gives up at ten. Past that the server keeps
 * reading and STORES every result while the user is told it failed, which is the worst of both:
 * paid for, landed, and reported as a loss. Twelve keeps the batch inside the window it is given.
 *
 * Argus's cut lands in single figures anyway, so this is a guard against a caller handing over the
 * whole board rather than a limit anyone should meet.
 */
export const BATCH_MAX  = 12
export const READ_DAYS  = 30

/**
 * Where a name goes once its read is in. PURE.
 *
 * THE VETO, in the order the reasons are conclusive:
 *
 *   contradicted   out. Something the company said or filed since the event cuts against the
 *                  mechanism, and no setup rescues a thesis the record contradicts.
 *   priced_in      out. The exposure is real and the market has already looked — a good
 *                  post-mortem and a bad trade, the same judgment `already_moved` makes upstream.
 *   unclear        IN, FLAGGED. An honest "not enough to say", which is not a no. By the time the
 *                  list is this short the user can look at three flagged names themselves, where a
 *                  silent drop would hide the one the read could not settle.
 *   no read        IN, FLAGGED. The absence of a reading is not a reading — the same distinction
 *                  the engine draws between `silent` and `unverified`. A batch that lost a name to
 *                  a timeout must not report it as refused.
 *   credible       in.
 *
 * THEN DIRECTION, and only for names the veto kept. `net` is the read's direction across EVERY
 * live event naming the company, and it is the right field to cut on — but it is null when only
 * one event names the name, because there is no net of a single claim. Ninety-five of the board's
 * hundred and sixteen tickers are single-event, so falling back to Aether's own `side` is the
 * common path, not the edge case.
 *
 * A direction the record cannot settle ships FLAGGED rather than dropped, for the same reason
 * `unclear` does — but it is worth seeing as its own flag: "we do not know if this is a long" is a
 * different warning from "we do not know if the claim holds".
 *
 * @param {?object} read  the stored quick read, or null when there is none
 * @param {object}  opts  `side` — Aether's claim on this name, the fallback direction
 * @returns {{keep: boolean, flag: ?string, direction: string, why: string}}
 */
export function judge(read, { side = '', longsOnly = true } = {}) {
    const direction = directionOf(read, side)

    if (read && read.verdict === 'contradicted') {
        return { keep: false, flag: null, direction, why: 'the record contradicts the mechanism' }
    }
    if (read && read.verdict === 'priced_in') {
        return { keep: false, flag: null, direction, why: 'already priced in' }
    }

    // The veto passed. Direction decides the rest, and only a direction the record actually
    // states can refuse a name — an unknown one is a flag, never a rejection.
    if (longsOnly && direction === 'short') {
        return { keep: false, flag: null, direction, why: 'the record puts it short, and this list is longs only' }
    }

    if (!read)                     return { keep: true, flag: 'unread',    direction, why: 'no read — the absence of one, not a negative' }
    if (read.verdict === 'unclear') return { keep: true, flag: 'unclear',   direction, why: 'the read could not settle it' }
    if (direction === 'unclear')    return { keep: true, flag: 'direction', direction, why: 'the events offset — which way it goes is unsettled' }
    return { keep: true, flag: null, direction, why: read.verdict === 'credible' ? 'credible and not yet priced' : 'kept' }
}

/**
 * Long, short, or unsettled — off the read where it has an opinion, off Aether's claim where it
 * does not. `net` wins whenever it is set, because it has looked at every event naming the name
 * and `side` has looked at one.
 */
export function directionOf(read, side = '') {
    const v = read?.net ?? side
    if (v === 'helped') return 'long'
    if (v === 'hurt')   return 'short'
    return 'unclear'
}

// Default IO, injected by the tests — the seam aetherQuickRead uses, and for the same reason.
const _io = {
    appearances: ticker => getCandidatesForTicker(ticker, { days: READ_DAYS, includeDropped: false }),
    read:        args   => quickRead(args),
}

/**
 * Read a list of names, one after another, and say where each one lands.
 *
 * SEQUENTIAL ON PURPOSE. These are model calls on the user's budget and against their ceiling, and
 * a parallel fan-out over a list would spend the whole batch before the first refusal came back.
 * quickRead already coalesces a name pressed twice, so nothing is paid for that was paid before —
 * a list re-read after one new event costs only the names whose set of events changed.
 *
 * ONE NAME'S FAILURE MUST NOT COST THE BATCH, the rule the discovery run learned the hard way: a
 * free step failing threw away the costly one. A name that throws is reported with its reason and
 * the batch goes on, and `judge` keeps it flagged rather than reading the failure as a refusal.
 */
export async function batchRead({ tickers = [], userId, signal } = {}, deps = _io) {
    const syms = [...new Set(tickers.map(t => String(t ?? '').trim().toUpperCase()).filter(t => TICKER_RE.test(t)))]
    if (!syms.length) throw httpError(400, 'at least one ticker is required')
    if (syms.length > BATCH_MAX) throw httpError(400, `at most ${BATCH_MAX} names in one batch`)

    const rows = []
    for (const ticker of syms) {
        if (signal?.aborted) break
        let row
        try {
            row = await _readOne(ticker, { userId, signal }, deps)
        } catch (err) {
            logger.warn(LOG, 'read failed', { ticker, err: err.message })
            // No read, and the reason kept with the name — `judge` puts it through flagged.
            row = { ticker, read: null, side: '', error: err.message }
        }
        rows.push({ ...row, ...judge(row.read, { side: row.side }) })
    }

    const kept = rows.filter(r => r.keep)
    logger.info(LOG, 'batch read', {
        asked: syms.length, read: rows.filter(r => r.read).length,
        kept: kept.length, flagged: kept.filter(r => r.flag).length,
    })
    return { rows, kept: kept.length, flagged: kept.filter(r => r.flag).length }
}

/** One name: resolve the run it is read against, then read it. */
async function _readOne(ticker, { userId, signal }, deps) {
    const found = await deps.appearances(ticker)
    const best  = found?.best
    // A name Argus kept that the radar no longer carries. Not an error — the window rolls and a
    // list outlives the board it came from — but there is nothing to read it against, so it goes
    // through unread and flagged rather than being quietly dropped from the user's own list.
    if (!best?.run_id) return { ticker, read: null, side: '', error: 'no live event names it' }

    const read = await deps.read({ runId: best.run_id, ticker, userId, signal })
    return { ticker, read, side: best.side ?? '', run_id: best.run_id, events: found.events }
}
