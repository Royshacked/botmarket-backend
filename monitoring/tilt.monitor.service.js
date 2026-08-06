// Strategy-desk monitor (Pythia) — the slow loop that keeps the house sector view HONEST.
//
// Mirrors the coverage monitor's shape (poll loop + due-selection + a two-tier verdict), at a
// strategy cadence. The split is the same one, and it is about cost:
//   • DETERMINISTIC (daily, free) — re-price each open stance against its frozen baseline, update
//     its contribution, mature the ones whose window closed. Pure arithmetic in tilt.assess.
//   • RE-AUTHOR (rare, gated)     — wake Pythia for a full top-down run. Multi-minute and tool-heavy,
//     so `reviewDecision` decides when it is earned: a stance came due, a dated macro catalyst
//     landed, or the monthly floor expired — under a cooldown.
//
// WHY IT DOES NOT NOTIFY ON MATURITY. A matured stance already wakes the desk, the re-author
// publishes, and the publish diff sends the card. Adding a second card here would tell the user
// twice about one event — and the running score is on the board regardless.

import { getDb }                from '../providers/mongodb.provider.js'
import { tiltService }          from '../api/strategy/tilt.service.js'
import { gradeRow, totalContributionBp, reviewDecision } from './tilt.assess.js'
import { SECTOR_ETF, BENCHMARK_PROXY } from '../services/entity/vocabulary.js'
import { fetchMacroCatalystDates } from '../providers/fred.provider.js'
import { createPollLoop, fetchLastPrice } from './monitorUtils.js'
import { logger }               from '../services/logger.service.js'

const LOG        = '[tiltMonitor]'
const COLLECTION = 'tilt'
// Tick hourly; each view gates itself to ~daily via monitor.next_check_at.
const POLL_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS           = 24 * 60 * 60 * 1000

const _deps = {
    // The SHARED price read — the same one Hermes, Talos and the coverage monitor gate on. Twelve
    // reads a day at most (eleven sector proxies plus the benchmark), and only for sectors actually
    // carrying an open stance.
    getPrice:  (sym) => fetchLastPrice(sym).catch(() => null),
    updateTilt: tiltService.updateTilt,
    // The expensive tier. Unbuilt until Pythia's agent exists; until then a wake is LOGGED rather
    // than silently swallowed, so the trigger is observable before the thing it triggers is written.
    reauthor:  async (doc, reason) => {
        logger.info(LOG, 'RE-AUTHOR DUE (agent not yet wired — no run started)', { id: doc.id, reason })
        return false
    },
    // The dated macro calendar the catalyst trigger reads — the SAME FRED feed behind the Radar Fed
    // tab, narrowed to FOMC decisions and high-impact prints. A low-impact release is not a reason
    // to re-author a 3-12 month sector view, and a trigger that fires on everything is one nobody
    // can act on. Failure degrades to "that trigger did not fire", never to a broken grade.
    catalystDates: () => fetchMacroCatalystDates().catch(() => []),
}
export function _setDeps(d) { Object.assign(_deps, d) }

const _loop = createPollLoop({ intervalMs: POLL_INTERVAL_MS, tick: _tick, eager: false, log: LOG, name: 'tilt monitor' })
export const tiltMonitorService = { start: _loop.start, stop: _loop.stop }

async function _tick() {
    const db  = await getDb()
    const now = new Date().toISOString()
    const due = await db.collection(COLLECTION).find({
        status: 'active',
        $or: [
            { 'monitor.next_check_at': null },
            { 'monitor.next_check_at': { $exists: false } },
            { 'monitor.next_check_at': { $lte: now } },
        ],
    }).toArray()

    for (const doc of due) {
        try { await _checkTilt(db, doc, Date.now(), _deps) }
        catch (err) { logger.warn(LOG, `check ${doc.id} failed:`, err.message) }
    }
}

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
export async function _checkTilt(db, doc, nowMs, deps = _deps) {
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
        await db.collection(COLLECTION).updateOne({ id: doc.id }, {
            $set: { tilts: graded, ...bookkeeping }, $inc: { 'monitor.checks': 1 },
        })
    }

    if (newlyMatured.length) {
        await db.collection(COLLECTION).updateOne({ id: doc.id }, { $set: bookkeeping, $inc: { 'monitor.checks': 1 } })
    }

    if (remodel.due) await deps.reauthor(doc, remodel.reason)
    return { graded: true, matured: newlyMatured.map(r => r.sector), remodel, total_bp: bookkeeping['monitor.total_bp'] }
}
