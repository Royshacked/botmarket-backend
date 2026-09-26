// The names the Events radar hands Argus, and the rule that stops one being scanned twice.
//
// THE CHAIN. Discovery is manual and admin-only; it leaves a board of event candidates. This is
// the next leg: the board becomes ONE list of names for Argus, which cuts it on TRADEABILITY — a
// catalyst inside the window, liquidity, a setup — and only then does Prometheus read the
// survivors and the longs filter run.
//
// ARGUS FIRST, PROMETHEUS SECOND, and the order is a cost argument rather than a preference.
// Argus's cut is two batch calls — get_earnings_calendar and get_quotes both take a symbol list —
// where Prometheus's quick read is one model call per name. The cheap filter goes in front, and
// the read becomes a veto on a handful instead of a score on a hundred and fifty.
//
// DIRECTION IS DELIBERATELY NOT PASSED. Aether's `side` is a claim about ONE event, and a name two
// events reach in opposite directions has two of them: APD was named HELPED by India semiconductor
// and read `net: hurt` once the Hormuz helium disruption was weighed against it. Nine of the
// twenty-one recurring tickers carry conflicting sides. So the sides ride in the thesis line as
// INFORMATION, Argus is asked a direction-blind question, and the longs filter runs after the read
// off `net` — the only field that has looked at every claim on the name. Passing `direction` here
// would let Argus settle a question the read exists to answer.
//
// ONE ENTRY PER TICKER, not per candidate. A name reached by three events is one company with
// three claims on it, and three rows would read as three opportunities — the mistake the board's
// own event-first layout was built to avoid. The claims fold into one thesis line instead.
//
// THE BOARD TRAVELS AS CONTEXT, not as the user's own words and not through editList. editList was
// the obvious seam and is wrong on MEANING — it tells Argus it is REFINING a list and to keep
// untouched names, which is the opposite of a cut. The seeded opening message was the other
// candidate and is wrong on DISPLAY: a seed is sent as the user's turn, and a hundred names in a
// chat bubble buries the conversation it starts. So the user says one sentence and the board
// arrives beside it (_buildRadarSection).

import { getEventCandidates } from '../api/aether/aether.service.js'
import { scanService } from '../api/scanner/scan.service.js'
import { logger } from './logger.service.js'

const LOG = '[aetherUniverse]'

/** The list's own window — the same thirty days the Events radar shows. */
export const UNIVERSE_DAYS = 30

/**
 * Scans produced from this board, marked so the exclusion rule can find them.
 *
 * A fourth origin beside the frontend's user / portfolio / kairos (services/pipeline/scanOrigin):
 * a radar list is an artifact the user keeps, so it saves like a user scan, but it has to be
 * TELLABLE from one — otherwise "the names I scanned yesterday" would sweep in every sector list
 * they ever asked Argus for by hand.
 */
export const SCAN_SOURCE = 'aether'

/** How much of a mechanism rides in the thesis line. Whole boards go in one prompt. */
const MECHANISM_CHARS = 220

/** At most this many events per name are spelled out; the rest are counted. */
const MAX_CLAIMS = 3

const SIDE = s => (s === 'hurt' ? 'HURT' : s === 'helped' ? 'HELPED' : 'MIXED')

const clip = (s, n) => {
    const t = String(s ?? '').trim()
    return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

/**
 * What a previous radar scan settled: which tickers it put on a list, and which events it saw.
 *
 * KEYED ON run_id, NOT ON DATES. A run id is `subject:published-date` and it is the engine's own
 * identity for one event — stored on the run and on every candidate it reached, and never rewritten.
 * A timestamp is not: `Discovered.to_mongo()` stamps `created_at` with the current time whenever a
 * candidate is stored without one, so re-verifying an event would make every name it reached look
 * newly discovered and flood back onto a list the user had already worked. The identity cannot move;
 * the clock can.
 *
 * THE OUTPUT LIST, NOT THE UNIVERSE THAT WAS HANDED OVER. A name Argus REJECTED is not excluded
 * tomorrow: "no catalyst this week" is a verdict about this week, and next week is a different
 * question. A name it KEPT is already on a list being tracked, so scanning it again buys the same
 * answer at the same price.
 *
 * `sourceRuns` is the universe the list was cut FROM — every event on the board that day, including
 * the ones whose names all lost. That is what makes "a new event" answerable: an event is new when
 * no previous scan was shown it, which is a different question from whether it produced a survivor.
 *
 * A prior list carrying NO sourceRuns excludes nothing: with no record of which events it saw,
 * every event reads as new and its names come back. The two failure directions are not symmetrical
 * — scanning a name twice costs a row in a prompt, and hiding one loses it with nothing on screen
 * to say so.
 */
export function priorScanState(priorLists = []) {
    const listed   = new Set()
    const seenRuns = new Set()
    for (const list of priorLists) {
        const runs = Array.isArray(list?.sourceRuns) ? list.sourceRuns : []
        // A list with no record of its universe cannot retire anything — see above. Its tickers are
        // skipped too, because "listed" only means something against the events that produced it.
        if (!runs.length) continue
        for (const r of runs) {
            const id = String(r ?? '').trim()
            if (id) seenRuns.add(id)
        }
        for (const c of list?.candidates ?? []) {
            const t = String(c?.ticker ?? '').toUpperCase().trim()
            if (t) listed.add(t)
        }
    }
    return { listed, seenRuns }
}

/**
 * The universe Argus is handed, and the names held back with the reason.
 *
 * PURE — runs in, rows out, no clock of its own beyond what the candidates carry.
 *
 * THE RULE. Scan today and every name on the board goes. Scan again tomorrow and the names Argus
 * already listed are held back — UNLESS an event NO PREVIOUS SCAN SAW names them. A new event is a
 * new claim about the company, and the whole point of the board is that a name can be reached
 * twice; excluding it on the strength of yesterday's unrelated event would hide exactly the case (a
 * second, conflicting mechanism) the read is there to resolve.
 *
 * The comparison is per APPEARANCE and by run id, not per ticker and not by date: it asks whether
 * any of this name's events is one the user has not been shown, so a name carried only by events
 * they have already worked stays out while the same name picked up by today's run comes back.
 *
 * NOTHING IS DROPPED SILENTLY. Held-back names come back in `skipped` with the reason, the same
 * rule the engine follows for its own gates — a filter whose rejections leave no trace can never be
 * shown to be wrong.
 *
 * `runIds` goes back out because the caller has to store it: it is the universe this build was cut
 * from, and tomorrow's build reads it as the set of events already seen. Without it the rule has no
 * memory and the whole board returns every day.
 *
 * @param {Array}  runs        grouped runs from getEventCandidates
 * @param {Array}  priorLists  this user's previously saved radar scans ({ candidates, sourceRuns })
 * @returns {{candidates: Array, skipped: Array, runs: number, runIds: string[]}}
 */
export function buildUniverse(runs = [], priorLists = []) {
    const { listed, seenRuns } = priorScanState(priorLists)
    const byTicker = new Map()
    const runIds   = []

    for (const run of runs) {
        // Every event on the board, including one whose names are all held back — see priorScanState.
        if (run?.run_id) runIds.push(String(run.run_id))
        for (const c of run.candidates ?? []) {
            const t = String(c?.ticker ?? '').toUpperCase().trim()
            if (!t) continue
            if (!byTicker.has(t)) {
                byTicker.set(t, { ticker: t, company: c.company ?? '', claims: [], rank: 0 })
            }
            const entry = byTicker.get(t)
            // The name off whichever appearance carries one — the engine leaves it blank on some
            // rows, and a ticker with no company name reads as a typo in a list of a hundred.
            if (!entry.company && c.company) entry.company = c.company
            entry.claims.push({
                run_id:     run.run_id,
                subject:    run.subject || c.subject || '',
                side:       c.side ?? '',
                mechanism:  c.mechanism ?? '',
                verdict:    c.verdict ?? '',
                event_date: run.event_date || c.event_date || '',
                rank:       Number(c.rank ?? 0),
                excess_pct: c.excess_pct ?? null,
            })
            entry.rank = Math.max(entry.rank, Number(c.rank ?? 0))
        }
    }

    const candidates = []
    const skipped    = []

    for (const entry of byTicker.values()) {
        entry.claims.sort((a, b) => b.rank - a.rank)
        const was    = listed.has(entry.ticker)
        // The events on this name that no previous scan was shown. Empty on a name whose every
        // event the user has already worked, which is the only case that retires it.
        const unseen = entry.claims.filter(c => !seenRuns.has(c.run_id))
        if (was && !unseen.length) {
            skipped.push({ ticker: entry.ticker, reason: 'listed_already' })
            continue
        }
        candidates.push({
            ticker:  entry.ticker,
            company: entry.company,
            // NO `direction` — see the header. `_buildEditSection` renders a missing one as "(?)",
            // which is the honest thing for a question Argus is not being asked to answer.
            thesis:  thesisLine(entry.claims),
            events:  entry.claims.length,
            rank:    entry.rank,
            // Back on the board because an event they have not seen named it, not because it was
            // never scanned. The seed says so, so a name the user recognises arrives explained.
            returning: was || undefined,
        })
    }

    // Best-evidenced first, then the name, so two runs of the same board order identically.
    candidates.sort((a, b) => b.rank - a.rank || a.ticker.localeCompare(b.ticker))
    skipped.sort((a, b) => a.ticker.localeCompare(b.ticker))
    return { candidates, skipped, runs: runs.length, runIds }
}

/**
 * Every live claim on one name, folded into the one line the edit-list seam renders.
 *
 * Sides are STATED, never acted on — see the header. The filing verdict rides along because it is
 * the cheapest quality signal on the row and Argus should be able to see that a name rests on the
 * press alone without being told what to do about it.
 */
export function thesisLine(claims = []) {
    if (!claims.length) return ''
    const shown = claims.slice(0, MAX_CLAIMS).map(c => {
        const parts = [
            `${SIDE(c.side)} by ${c.subject || 'an event'}${c.event_date ? ` (${c.event_date})` : ''}`,
            c.mechanism ? clip(c.mechanism, MECHANISM_CHARS) : '',
            c.verdict ? `filings: ${c.verdict}` : '',
            // The move since the event, vs SPY. It belongs here rather than in a column Argus has
            // to ask for: "has the market already looked" is half of what tradeability means, and
            // a name up 13% on its own claim is a different proposition from one that has not moved.
            c.excess_pct != null ? `moved ${(c.excess_pct * 100).toFixed(1)}% vs SPY since` : 'no move measured',
        ].filter(Boolean)
        return parts.join(' — ')
    })
    const rest = claims.length - shown.length
    if (rest > 0) shown.push(`and ${rest} further event${rest > 1 ? 's' : ''}`)
    return claims.length > 1
        ? `Reached by ${claims.length} events. ${shown.join(' | ')}`
        : shown[0]
}

// Default IO, injected by the tests — the same seam aetherQuickRead uses, and for the same reason:
// ESM bindings are immutable, so a service that reaches for getDb cannot be stubbed.
const _io = {
    runs:  ({ days }) => getEventCandidates({ days }),
    // `onError: 'throw'` and not the default 'empty' — see getScanUniverse.
    scans: userId => scanService.getScans(userId, { onError: 'throw' }),
}

/**
 * The universe for this user's next radar scan.
 *
 * Owner-scoped on the SCAN side only: the board is broadcast (every signed-in user sees the same
 * events), but "the names I already scanned" is personal, so two users working the same board each
 * get their own exclusions. That asymmetry is deliberate — the reads on the board are shared
 * because they are measurements, and a scan list is a decision.
 */
export async function getScanUniverse(userId, { days = UNIVERSE_DAYS } = {}, deps = _io) {
    const runs = await deps.runs({ days })
    // A failed scan read must NOT silently widen the universe back to the whole board: an empty
    // prior-list set is indistinguishable from "nothing has been scanned yet", and the difference
    // is a hundred and fifty names the user already worked. The list surfaces degrade to empty on
    // a read failure and are right to; this one throws, the same rule the venue read follows —
    // an unreachable source reports unknown, never a confident negative.
    const prior = (await deps.scans(userId) ?? []).filter(s => s?.source === SCAN_SOURCE)
    const out   = buildUniverse(runs, prior)
    logger.info(LOG, 'universe built', {
        runs: out.runs, names: out.candidates.length, held: out.skipped.length, priorLists: prior.length,
    })
    return { ...out, days, priorLists: prior.length }
}
