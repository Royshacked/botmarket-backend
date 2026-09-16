// House scan — Argus's admin-pipeline mode.
//
// Triggered after Pythia publishes a tilt. For each overweight sector in the tilt,
// screens the US universe with the neutral composite filter set (quality-agnostic,
// no cap filter — schools determine appropriate size at allocation time) and enqueues
// hits for Prometheus to research.
//
// THE TILT IS THE MANDATE, and this is where that stops being a slogan. Two parts of the published
// view reach the screen: which sectors (stance 'over') and how strongly (`active_bp` → breadth and
// queue order). The rest of the policy — the regime, and the `basis` the stance rests on — is
// carried onto each queue row rather than compiled into filters, and that split is deliberate:
// FMP's company-screener whitelist (fmp.provider SCREEN_PARAMS) has no valuation or estimate-
// revision predicate, so a `valuation` basis CANNOT be expressed as a screen. Faking one with a
// dividend or beta proxy would quietly substitute our guess for Pythia's stated reason. Instead the
// reason travels with the name and Prometheus — which does have the fundamentals — applies it.
// Turning the basis into real factor selection needs the Argus AGENT in this loop, not a wider
// filter list.
//
// Fire-and-forget: called from the publishTilt controller after the HTTP response
// is sent. Never throws to its caller.
//
// deps: injectable for tests.

import { logger }               from './logger.service.js'
import { researchQueueService } from './researchQueue.service.js'
import { toNum }                from './format.util.js'

const LOG = '[houseScan]'

// Minimum daily volume: below this a name is too illiquid to research meaningfully.
const MIN_VOLUME = 500_000
// Breadth when the stance carries no weight — a stance is still a stance without a number on it.
const DEFAULT_HITS = 20

// Names per sector, scaled by CONVICTION. `active_bp` is the only part of the view expressed as a
// number, and handing +300bp and +50bp the same twenty names throws it away: both cost Prometheus
// the same queue, which is the scarce thing here. Bands rather than a formula, because the queue is
// consumed one name at a time by a human-gated desk and a continuous function would imply a
// precision the stance does not have.
//
// Ordered high → low; the first band a weight clears wins.
const CONVICTION_BANDS = [
    { min: 250, hits: 30 },
    { min: 100, hits: 20 },
    { min: 0,   hits: 10 },
]
// The screener's own ceiling (fmp.provider clamps to 50) — named here so the cap is visible.
const MAX_HITS = 50

/**
 * How many names one stance earns. Pure → an integer.
 *
 * An ABSENT weight is not a small weight: it falls to the default breadth, never to the narrowest
 * band. `toNum` is strict about this on purpose (a null must not read as 0), which is the same
 * distinction the grading side depends on.
 */
export function hitsForConviction(activeBp) {
    const bp = toNum(activeBp)
    if (bp === null) return DEFAULT_HITS
    const band = CONVICTION_BANDS.find(b => Math.abs(bp) >= b.min)
    return Math.min(band ? band.hits : DEFAULT_HITS, MAX_HITS)
}

/**
 * The overweight stances, as the POLICY rows the scan acts on — not just their names. Each carries
 * the weight that sizes its screen and the basis that explains it.
 */
export function overweightRows(tiltDoc) {
    return (Array.isArray(tiltDoc?.tilts) ? tiltDoc.tilts : [])
        .filter(r => r?.stance === 'over' && r?.sector)
        .map(r => ({ sector: r.sector, active_bp: toNum(r.active_bp), basis: r.basis ?? null }))
}

/**
 * Run a house scan for all overweight sectors in the tilt and enqueue hits.
 * Fire-and-forget — wraps everything in a try/catch so it never surfaces to the caller.
 */
export async function runHouseScan(tiltDoc, deps = _io) {
    try {
        const rows = overweightRows(tiltDoc)
        if (!rows.length) {
            logger.info(LOG, 'no overweight sectors — nothing to scan')
            return
        }
        const regime = tiltDoc?.regime?.name ?? null
        logger.info(LOG, 'house scan starting', {
            regime, sectors: rows.map(r => `${r.sector}${r.active_bp === null ? '' : ` +${r.active_bp}bp`}`),
        })

        const enqueue = deps.enqueue ?? _io.enqueue   // tests inject screenSector alone
        const seen    = new Set()
        let queued    = 0
        let skipped   = 0

        // Widest conviction first. Every sector is screened regardless, but the queue is consumed in
        // insertion order — so when Prometheus only gets through half of it, the half it reaches is
        // the half the house feels strongest about.
        for (const row of [...rows].sort((a, b) => Math.abs(b.active_bp ?? 0) - Math.abs(a.active_bp ?? 0))) {
            const hits = hitsForConviction(row.active_bp)
            let symbols
            try {
                symbols = await deps.screenSector(row.sector, { limit: hits })
            } catch (err) {
                logger.warn(LOG, `sector screen failed: ${row.sector} (scan continues)`, err.message)
                continue
            }
            for (const sym of symbols) {
                if (seen.has(sym)) continue   // appeared in a prior sector — don't double-enqueue
                seen.add(sym)
                const res = await enqueue({
                    symbol: sym, source: 'argus', requestedBy: 'house',
                    // The mandate travels WITH the name. See researchQueue.enqueue for why it is
                    // stored rather than looked up when the name is finally researched.
                    context: {
                        tiltId: tiltDoc?.id ?? null, regime,
                        sector: row.sector, stance: 'over',
                        active_bp: row.active_bp, basis: row.basis,
                    },
                })
                if (res.duplicate) skipped++
                else if (res.ok)   queued++
            }
        }
        logger.info(LOG, 'house scan complete', { sectors: rows.length, queued, skipped_duplicate: skipped })
    } catch (err) {
        logger.error(LOG, 'house scan failed (caller unaffected)', err)
    }
}

// Default IO: FMP screener imported lazily so tests can inject stubs without dragging the provider
// stack in. Throws on a failed screen — runHouseScan's loop is the one place that decides what a
// failed sector means (skip it, scan continues), and catching here as well made that branch
// unreachable for the real IO.
const _io = {
    async screenSector(sector, { limit = DEFAULT_HITS } = {}) {
        const { screenCandidatesRaw } = await import('../providers/fmp.provider.js')
        const rows = await screenCandidatesRaw({
            sector,
            volumeMoreThan: MIN_VOLUME,
            isEtf:          'false',
            limit,
        })
        return rows.map(r => String(r.symbol || '').toUpperCase().trim()).filter(Boolean)
    },
    enqueue: (args) => researchQueueService.enqueue(args),
}
