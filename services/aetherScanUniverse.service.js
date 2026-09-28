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
import { getEarningsCalendarRaw } from '../providers/fmp.provider.js'
import { earningsWindow, earningsBySymbol } from './earningsWindow.util.js'
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

/**
 * How far a name has to have moved, in its claim's own direction, before the move counts as MADE.
 *
 * Three percent of excess return vs SPY. Measured against the live board rather than picked: it splits
 * the hundred and sixteen names into 42 not-yet / 19 taken / 13 against / 42 unmeasured, which are
 * workable sizes for every bucket. Tighter and the not-yet pile starts holding names that have quietly
 * gone; looser and the pile Argus is told to reject stops being worth naming.
 */
const REPRICED_PCT = 0.03

/** Which repricing states lead the board. See the sort in buildUniverse. */
const REPRICING_ORDER = { not_yet: 0, unknown: 1, against: 2, taken: 3 }

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
                // THE CLAIM'S OWN DEADLINE — the date the engine grades it, and the one dated forward
                // window every name on this board already has. It was on the candidate all along and
                // this service dropped it, which is most of why "is there a catalyst inside the
                // window" collapsed into "does it report earnings this week": the model was told to
                // demand a dated window while the window it had been handed never reached it.
                expires_at: c.expires_at ?? '',
            })
            entry.rank = Math.max(entry.rank, Number(c.rank ?? 0))
            // The engine's own last price for the name, off whichever appearance priced it most
            // recently. Free — it is already on the row — and it saves the model asking for a hundred
            // quotes to find out which names are too cheap to trade.
            const asOf = String(c.price_asof ?? '')
            const px   = Number(c.price_latest)
            // `isFinite`, not a null check: a garbage price would otherwise land as NaN, which JSON
            // turns into null on the way out but which renders as "$NaN" on the way to the model.
            if (Number.isFinite(px) && px > 0 && asOf >= String(entry.priceAsOf ?? '')) {
                entry.price     = px
                entry.priceAsOf = asOf
            }
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
            // HOW LONG THE NAME STILL HAS: the furthest deadline among its live claims. The furthest
            // and not the nearest, because that is when the board stops carrying it — a name with one
            // claim expiring Friday and another in November has a November thesis. Each claim's own
            // date rides in the thesis line, which is where the nearest decision point is readable.
            expires: entry.claims.reduce((f, c) => (c.expires_at > f ? c.expires_at : f), ''),
            price:   entry.price ?? null,
            priceAsOf: entry.priceAsOf || null,
            // How far through its repricing the market already is — the single most decision-relevant
            // fact on the row, and the one the prompt could not get Argus to derive (see repricingOf).
            repricing: repricingOf(entry.claims),
            // Back on the board because an event they have not seen named it, not because it was
            // never scanned. The seed says so, so a name the user recognises arrives explained.
            returning: was || undefined,
        })
    }

    // REPRICING FIRST, then best-evidenced, then the name — still totally ordered, so two runs of the
    // same board come out identical.
    //
    // The order is a nudge, not a filter: nothing is removed, and Argus can still report "19 already
    // taken" in its funnel counts. But a hundred rows is more than anyone reads evenly, and the names
    // worth the tape were scattered through it — which is how a cut came back holding the two most
    // extended names on the board while forty-two untouched ones sat below them. Unmeasured ranks
    // second and not last: "nobody has measured this" is a maybe, where "the move is made" is a no.
    candidates.sort((a, b) =>
        REPRICING_ORDER[a.repricing.state] - REPRICING_ORDER[b.repricing.state]
        || b.rank - a.rank
        || a.ticker.localeCompare(b.ticker))
    skipped.sort((a, b) => a.ticker.localeCompare(b.ticker))
    return { candidates, skipped, runs: runs.length, runIds }
}

/**
 * How much of a claim's move the market has already made. PURE.
 *
 * WHY THIS IS COMPUTED HERE AND NOT ASKED OF THE MODEL. It is one subtraction and a sign flip, and the
 * prompt asked Argus to do it three times in a row and got it wrong three times in a row — keeping MU
 * at +8.4% and TSM at +4.8% past their events, twice, both refused as `priced_in` by the read minutes
 * later, while forty-two names sat on the same board with no move made. A rule the model must remember
 * and apply is a rule it can skip; a label on the row is a fact it reads. Same move that fixed the
 * earnings dates and the price.
 *
 * SIGNED INTO THE CLAIM'S DIRECTION, which is the part that is easy to get backwards: a HURT name is
 * supposed to FALL, so -6% on a HURT claim is the move being taken, and +6% is the market voting
 * against it. `excess_pct` alone cannot say which — only `side` can.
 *
 * THE BEST-RANKED CLAIM DECIDES when a name is reached more than once, the same rule the row's run id
 * follows. Nine of this board's names carry claims that disagree with each other, so one name's "taken"
 * is another claim's "against"; the read settles that later with every event in front of it, and this is
 * a screen, not a verdict.
 *
 * UNKNOWN IS NOT "NOT YET". Forty-two of a hundred and sixteen rows carry no measured move at all, and
 * a name that survived because nobody measured it has not earned anything. They render differently and
 * sort differently for that reason.
 *
 * @returns {{state: 'taken'|'not_yet'|'against'|'unknown', pct: ?number}}
 */
export function repricingOf(claims = []) {
    // The strongest claim that HAS a measurable move, rather than the strongest claim full stop: a
    // top-ranked row with no price history would otherwise make the whole name unreadable.
    const c = claims.find(x => x.excess_pct != null && (x.side === 'helped' || x.side === 'hurt'))
    if (!c) return { state: 'unknown', pct: null }

    // Into the claim's direction: a HURT claim paying off is a FALL.
    const toward = c.side === 'hurt' ? -Number(c.excess_pct) : Number(c.excess_pct)
    if (!Number.isFinite(toward)) return { state: 'unknown', pct: null }

    const pct = toward * 100
    if (toward >=  REPRICED_PCT) return { state: 'taken',   pct }
    if (toward <= -REPRICED_PCT) return { state: 'against', pct }
    return { state: 'not_yet', pct }
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
            // The date THIS claim is graded on. It is the claim's own window, so it belongs beside the
            // claim and not only in the row's summary: a name reached twice has two deadlines, and
            // "which of these has to pay off by Friday" is not answerable from a single furthest date.
            c.expires_at ? `claim runs to ${c.expires_at}` : '',
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
    // The forward calendar for the whole board in ONE call, through the window every "upcoming
    // earnings" surface in the app shares (earningsWindow.util). Thirty days and not the coming week:
    // "nothing for three weeks" is a different answer from "nothing at all", and only the first of
    // those is a reason to leave a name off THIS week's list rather than off every list.
    //
    // The window also has to stay under thirty-five days or so for a reason that is not about
    // meaning: FMP caps this endpoint at 4000 rows and applies the cap from the END, so a three-month
    // ask comes back missing the next six weeks entirely and says nothing about it.
    earnings: symbols => {
        const { from, to } = earningsWindow()
        return getEarningsCalendarRaw(from, to, symbols)
    },
}

/**
 * The next scheduled print for each name, written onto the rows. MUTATES and returns the same rows.
 *
 * SWALLOWS ITS FAILURE, unlike the scan read above, and the asymmetry is the same one earningsWindow's
 * own header draws: a missing prior-list set silently becomes the WRONG universe, where a missing
 * earnings date is just a missing date. The board is worth handing over without it — every other fact
 * on the row still holds — and the prompt says "no print in the next thirty days" rather than the
 * button failing on a calendar blip.
 */
async function _attachEarnings(candidates, deps) {
    if (!candidates.length) return candidates
    try {
        const bySymbol = earningsBySymbol(await deps.earnings(candidates.map(c => c.ticker)))
        for (const c of candidates) {
            const hit = bySymbol.get(c.ticker)
            c.earnings = hit ? { date: hit.date, epsEstimate: hit.epsEstimate ?? null } : null
        }
    } catch (err) {
        logger.warn(LOG, 'earnings calendar unavailable — the board goes out without dates', err.message)
        // LEFT UNSET, where "nothing scheduled" is an explicit null. "We could not read the calendar"
        // and "it does not report in the window" must not render the same — only the second is a fact
        // about the company, and only the second is a reason to leave a name off a list.
        //
        // And the two have to stay distinguishable through JSON, which is why the pair is
        // absent-vs-null rather than two strings: the board is answered to the browser, held in its
        // state, and sent BACK on every turn of the cut. `undefined` is dropped by JSON.stringify at
        // both hops, so an unset key arrives unset and `_radarFacts` still reads it as UNKNOWN; null
        // survives as null. A "no print" sentinel string would survive the trip looking like a fact.
        for (const c of candidates) delete c.earnings
    }
    return candidates
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
    // THE DATES COME WITH THE BOARD, which is the whole point of doing it here. They used to be
    // Argus's first move: a get_earnings_calendar over every name on the board, mid-stream, on the
    // user's clock — one 10-second budget against a fetch of the entire market's calendar, competing
    // with its own hundred-wide quote fan-out. When it lost that race the model had no dates for
    // anything, and the mode's own rule ("a name without a date does not belong here") emptied a
    // hundred-and-sixteen-name board down to the single off-cycle reporter. One cached server-side
    // call, before the prompt is built, cannot lose that race.
    await _attachEarnings(out.candidates, deps)
    logger.info(LOG, 'universe built', {
        runs: out.runs, names: out.candidates.length, held: out.skipped.length, priorLists: prior.length,
        withEarnings: out.candidates.filter(c => c.earnings).length,
    })
    return { ...out, days, priorLists: prior.length }
}
