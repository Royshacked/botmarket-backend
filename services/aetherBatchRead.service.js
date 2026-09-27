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
import { mapLimit } from './concurrency.util.js'
import { logger } from './logger.service.js'
import { httpError } from './httpError.util.js'

const LOG = '[aetherBatchRead]'

/**
 * How many names one batch will read.
 *
 * A ceiling on spend AND on the wall clock, and the second is what sets the number. A single read
 * takes 35-45s (aetherQuickRead's own timeout note), so a batch is minutes long by construction —
 * and the client gives up at ten. Past that the server keeps reading and STORES every result while
 * the user is told it failed, which is the worst of both: paid for, landed, and reported as a loss.
 * Twelve at READ_CONCURRENCY is four waves, comfortably inside the window it is given.
 *
 * Argus's cut lands in single figures anyway, so this is a guard against a caller handing over the
 * whole board rather than a limit anyone should meet. Meeting it is not an error — the names past it
 * come back unread and flagged (see batchRead).
 */
export const BATCH_MAX  = 12

/**
 * How many reads run at once.
 *
 * THIS WAS ONE, and the reasoning that made it one no longer holds. Sequential was chosen so that a
 * list would not spend its whole budget before the first refusal came back — a real argument while
 * the read was a press on a list the user was still deciding about. It fires by itself now, on every
 * name Argus kept, and a refusal has never stopped the batch: every name is read either way. So the
 * serialisation bought nothing and cost the only thing that was scarce — the wall clock. Twelve names
 * at 40s each is eight minutes against a client that waits ten; at three it is under three.
 *
 * THREE, not "all of them". These are model calls on ONE user's budget and against their rate
 * ceiling, and a twelve-wide fan-out is how the scanner's own quote call starved its calendar call of
 * the request budget on the very board this reads. Three overlaps the waiting without turning a batch
 * into a burst, and it is the depth at which the slowest read stops setting the whole batch's clock.
 */
export const READ_CONCURRENCY = 3
export const READ_DAYS  = 30

/**
 * Whether a radar list may hold shorts. IT MAY, and it did not until 2026-09-27.
 *
 * `judge` has always taken a `longsOnly` flag and it defaulted to true, and nothing ever passed it —
 * so the only value that ever shipped was the one nobody chose. What it discarded: every name whose
 * record reads `hurt`. On the live board that is 44 of 116 tickers HURT by their only event, plus
 * whichever of the 9 conflicting ones the read settles downward — about 38% of the board, cut AFTER
 * Argus had spent triage, the tape and a paid chart read on it.
 *
 * And it contradicted the instruction directly above it in the chain: Argus is told the stated side is
 * CONTEXT, never a filter and never a rank, because a one-event side is not the net. Then the terminal
 * step filtered on exactly that. AAPL made it plain — `credible`, `net: hurt`, not priced in, -0.4% vs
 * SPY, which is the best result this chain can produce — dropped for being a short.
 *
 * Shorts are first-class everywhere else: LIVE_POSITION is [LONG, SHORT], every entity kind carries a
 * SHORT status, and the scan schema and the UI have rendered short candidates all along. The flag stays
 * on `judge` because the question is real for a longs-only book; this list is not one.
 */
export const RADAR_LONGS_ONLY = false

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
 * `unclear` does — but it is worth seeing as its own flag: "we do not know which way this goes" is a
 * different warning from "we do not know if the claim holds".
 *
 * `longsOnly` DEFAULTS TRUE HERE AND THE SHIPPING CALLER PASSES FALSE (RADAR_LONGS_ONLY). The default
 * is kept for a longs-only book asking the same question; a radar list is not one, and leaving the
 * default in place silently threw away every short the read confirmed.
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
 * Read a list of names, READ_CONCURRENCY at a time, and say where each one lands.
 *
 * BOUNDED, NOT SERIAL AND NOT FANNED OUT — see READ_CONCURRENCY for why the middle is the answer
 * and why it used to be one. quickRead coalesces a name read before, so nothing is paid for twice:
 * a list re-read after one new event costs only the names whose set of events changed.
 *
 * ONE NAME'S FAILURE MUST NOT COST THE BATCH, the rule the discovery run learned the hard way: a
 * free step failing threw away the costly one. A name that throws is reported with its reason and
 * the batch goes on, and `judge` keeps it flagged rather than reading the failure as a refusal. That
 * is why the catch is INSIDE the mapped function: mapLimit has no swallow mode, deliberately, and
 * this is the caller that owns the judgment.
 *
 * ROWS COME BACK IN THE ORDER THE NAMES WERE GIVEN, never in the order the reads happened to finish.
 * The caller pairs them with the list it sent, and a batch whose shape depended on which model call
 * returned first would be a different answer every time it ran.
 */
export async function batchRead({ tickers = [], userId, signal } = {}, deps = _io) {
    const syms = [...new Set(tickers.map(t => String(t ?? '').trim().toUpperCase()).filter(t => TICKER_RE.test(t)))]
    if (!syms.length) throw httpError(400, 'at least one ticker is required')

    // OVER THE CAP IS NOT AN ERROR. It was, while the read was a press a user chose to make: a
    // caller handing over the whole board was a bug and a 400 said so. The read now fires by itself
    // on every radar cut, so the cap is something that HAPPENS to a list rather than something a
    // caller did wrong — and refusing the batch over its thirteenth name would throw away the twelve
    // reads that were fine, which is the failure this file already refuses to make one name at a time.
    //
    // The overflow goes through UNREAD, which is the answer this file gives a name whose read threw:
    // the absence of a reading is not a reading. The names that get read are the first ones, and the
    // list arrives in Argus's own ranking (_normalizeScan sorts by the composite before it leaves),
    // so the cap falls on the weakest names rather than on an arbitrary twelve.
    const queue    = syms.slice(0, BATCH_MAX)
    const overflow = syms.slice(BATCH_MAX)

    const read = await mapLimit(queue, async (ticker) => {
        // ABORTED, so this name is never started. The reads already in flight when the signal fired
        // still finish — that is what a bounded pool means, and abandoning them would throw away
        // model calls already paid for — but nothing new is picked up. A null here is "never ran",
        // which is the one thing that must not become a row: an unread name is a claim about the
        // name, and the list it belonged to is gone.
        if (signal?.aborted) return null
        try {
            const row = await _readOne(ticker, { userId, signal }, deps)
            return { ...row, ...judge(row.read, { side: row.side, longsOnly: RADAR_LONGS_ONLY }) }
        } catch (err) {
            logger.warn(LOG, 'read failed', { ticker, err: err.message })
            // No read, and the reason kept with the name — `judge` puts it through flagged.
            const row = { ticker, read: null, side: '', error: err.message }
            return { ...row, ...judge(null, { side: '' }) }
        }
    }, { concurrency: READ_CONCURRENCY })

    const rows = read.filter(Boolean)

    // Past the cap, and said so on the row rather than by being absent from the answer: a caller
    // reads a missing row as "the read never reached it", which is true but gives it nothing to show
    // the user. `judge` ships these kept-and-flagged, the same as a name whose read timed out.
    for (const ticker of overflow) {
        const row = { ticker, read: null, side: '', error: `not read — a batch is capped at ${BATCH_MAX} names` }
        rows.push({ ...row, ...judge(null, { side: '' }) })
    }

    const kept = rows.filter(r => r.keep)
    logger.info(LOG, 'batch read', {
        asked: syms.length, read: rows.filter(r => r.read).length,
        capped: overflow.length, kept: kept.length, flagged: kept.filter(r => r.flag).length,
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
