// Strategy-desk monitor (Pythia) — the slow loop that keeps the house sector view HONEST.
//
// Mirrors the coverage monitor's shape (poll loop + due-selection + a two-tier verdict), at a
// strategy cadence. The split is the same one, and it is about cost:
//   • DETERMINISTIC (daily, free) — re-price each open stance against its frozen baseline, update
//     its contribution, mature the ones whose window closed. Pure arithmetic in tilt.assess.
//   • RE-AUTHOR (rare, gated)     — wake Pythia for a full top-down run. Multi-minute and tool-heavy,
//     so `reviewDecision` decides when it is earned: a stance came due, a dated macro catalyst
//     landed, or the monthly floor expired — under a cooldown. The wake is an OFFER, not a run:
//     re-authoring supersedes the view every user reads, so it takes a confirm (see tiltNotify).
//
// WHY IT DOES NOT NOTIFY ON MATURITY. A matured stance is itself a re-author trigger, so it already
// produces the review offer below and that card names it. A second, maturity-specific card would
// tell the user twice about one event — and the running score is on the board regardless.

import { tiltService, COLLECTION } from '../api/strategy/tilt.service.js'
import { gradeRow, totalContributionBp, reviewDecision } from './tilt.assess.js'
import { SECTOR_ETF, BENCHMARK_PROXY } from '../services/entity/vocabulary.js'
import { fetchMacroCatalystDates } from '../providers/fred.provider.js'
import { notifyTiltReviewDue } from '../services/tiltNotify.service.js'
import { fetchLastPrice } from './monitorUtils.js'
import { createDueLoop }   from './dueLoop.js'
import { logger }               from '../services/logger.service.js'

const LOG        = '[tiltMonitor]'
// Tick hourly; each view gates itself to ~daily via monitor.next_check_at.
const POLL_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS           = 24 * 60 * 60 * 1000

const _deps = {
    // The SHARED price read — the same one Hermes, Talos and the coverage monitor gate on. Twelve
    // reads a day at most (eleven sector proxies plus the benchmark), and only for sectors actually
    // carrying an open stance.
    getPrice:  (sym) => fetchLastPrice(sym).catch(() => null),
    updateTilt: tiltService.updateTilt,
    // The quiet grade-refresh path. It deliberately does NOT append a revision (see the service),
    // but it used to skip the service entirely and write the collection here — this module knowing
    // both the collection name and the `monitor.*` shape it does not own.
    recordMonitorState: tiltService.recordMonitorState,
    // The expensive tier — and the monitor does not run it. A top-down re-author is a multi-minute,
    // tool-heavy desk turn that ends in SUPERSEDING the house view every user reads, so waking the
    // desk means ASKING: a card in the social chat, whose confirm takes the user to Pythia and runs
    // the review in his thread. Same call the daily market brief makes. See tiltNotify.
    requestReview: async (doc, reason) => notifyTiltReviewDue(doc, { reason }),
    // The dated macro calendar the catalyst trigger reads — the SAME FRED feed behind the Radar Fed
    // tab, narrowed to FOMC decisions and high-impact prints. A low-impact release is not a reason
    // to re-author a 3-12 month sector view, and a trigger that fires on everything is one nobody
    // can act on. Failure degrades to "that trigger did not fire", never to a broken grade.
    catalystDates: () => fetchMacroCatalystDates().catch(() => []),
}
export function _setDeps(d) { Object.assign(_deps, d) }

// Same wake-up chore as every other monitor, and now the same implementation of it (dueLoop.js) —
// find what is due, CLAIM it against a lease, check it under a timeout. The hand-rolled version this
// replaces had no lease: a view whose check outran the tick could be picked up and graded twice.
const _loop = createDueLoop({
    collection: COLLECTION,
    // No `kind` — the collection holds house views and nothing else. There is ONE broadcast tilt, so
    // "due" is at most a single document a day.
    statuses:   ['active'],
    // Pythia keeps its schedule under `monitor.*`; the entity collection uses `monitor_state.*`.
    statePath:  'monitor',
    check:      (doc, nowMs) => _checkTilt(doc, nowMs, _deps),
    intervalMs: POLL_INTERVAL_MS,
    // Not eager: an hourly research loop has no reason to fire on every deploy.
    eager:      false,
    log: LOG, name: 'tilt monitor',
})
export const tiltMonitorService = { start: _loop.start, stop: _loop.stop }

/**
 * Today's prices for the sectors that actually carry an open stance, plus the benchmark.
 * → `{ bySector: Map, bench: number|null }`. A sector we cannot price is simply absent, which
 * `gradeRow` already handles by keeping the last known contribution.
 */
export async function _resolvePrices(rows, benchmark, deps = _deps) {
    const sectors = [...new Set(rows.filter(r => r?.state !== 'matured').map(r => r?.sector).filter(Boolean))]
    const bench   = BENCHMARK_PROXY[benchmark] ?? null
    const [benchPx, ...pxs] = await Promise.all([
        bench ? deps.getPrice(bench) : Promise.resolve(null),
        ...sectors.map(s => (SECTOR_ETF[s] ? deps.getPrice(SECTOR_ETF[s]) : Promise.resolve(null))),
    ])
    return { bySector: new Map(sectors.map((s, i) => [s, pxs[i]])), bench: benchPx }
}

/**
 * One view: re-price its open stances, mature the ones that came due, then decide whether the desk
 * owes a re-author. Exported for tests.
 *
 * BACKFILL. A stance published while its proxy was unreachable carries a null baseline and cannot be
 * graded at all. Rather than leaving it permanently unscoreable, the first tick that can price it
 * stamps the baseline then — a day of imprecision, recorded in the log, instead of a call that can
 * never be judged. Only a MISSING baseline is ever written; an existing one is immutable.
 */
export async function _checkTilt(doc, nowMs, deps = _deps) {
    const rows = Array.isArray(doc.tilts) ? doc.tilts : []
    const { bySector, bench } = await _resolvePrices(rows, doc.benchmark, deps)

    const backfilled = []
    const graded = rows.map(r => {
        const sectorNow = bySector.get(r?.sector) ?? null
        let row = r
        if ((r?.base_px === null || r?.base_px === undefined) && sectorNow && bench) {
            row = { ...r, base_px: sectorNow, base_bench_px: r.base_bench_px ?? bench }
            backfilled.push(r.sector)
        }
        return gradeRow(row, { sectorNow, benchNow: bench }, nowMs)
    })
    if (backfilled.length) logger.info(LOG, 'baselines backfilled a tick late', { id: doc.id, sectors: backfilled })

    const newlyMatured = graded.filter((g, i) => g.state === 'matured' && rows[i]?.state !== 'matured')
    const remodel = reviewDecision({ ...doc, tilts: graded }, {
        nowMs,
        catalystDates: await deps.catalystDates().catch(() => []),
    })

    const bookkeeping = {
        'monitor.next_check_at':   new Date(nowMs + DAY_MS).toISOString(),
        'monitor.last_checked':    new Date(nowMs).toISOString(),
        'monitor.total_bp':        totalContributionBp(graded),
        'monitor.next_review_at':  remodel.next_review_at,
    }

    // The daily grade is bookkeeping, not a revision — a contribution ticking with the tape is not
    // the desk changing its mind, and writing a revision every day would bury the ones that matter.
    // Maturity IS a state change, so that one gets a trail entry through the service.
    if (newlyMatured.length) {
        const note = `stance matured: ${newlyMatured.map(r => `${r.sector} ${r.contribution_bp ?? '?'}bp`).join(', ')}`
        const res  = await deps.updateTilt(doc.id, { tilts: graded, revision_kind: 'stance_matured', revision_note: note })
        if (!res?.ok) {
            logger.warn(LOG, 'maturity write failed — leaving the view due for the next tick', { id: doc.id, reason: res?.reason })
            return { graded: false, remodel }   // deliberately no bookkeeping: stay due, retry
        }
        logger.info(LOG, 'stances matured', { id: doc.id, note })
    } else {
        await deps.recordMonitorState(doc.id, { set: { tilts: graded, ...bookkeeping }, inc: { 'monitor.checks': 1 } })
    }

    if (newlyMatured.length) {
        await deps.recordMonitorState(doc.id, { set: bookkeeping, inc: { 'monitor.checks': 1 } })
    }

    // GRADED rows, not the stored ones — the same view `reviewDecision` just judged. A stance that
    // matured on THIS tick is only flagged in `graded`, and it is precisely the thing the card should
    // lead with; built from the stored copy it would read as a generic "review due". The rest of the
    // doc rides unchanged, so `revisions` still carries the publish the dedupe window opens at.
    let offered = 0
    if (remodel.due) {
        offered = await deps.requestReview({ ...doc, tilts: graded }, remodel.reason)
        logger.info(LOG, 'review due', { id: doc.id, reason: remodel.reason, offered })
    }
    return { graded: true, matured: newlyMatured.map(r => r.sector), remodel, offered, total_bp: bookkeeping['monitor.total_bp'] }
}
