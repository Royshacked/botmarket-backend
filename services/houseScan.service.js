// House scan — Argus's admin-pipeline mode.
//
// Triggered after Pythia publishes a tilt. For each overweight sector in the tilt,
// screens the US universe with the neutral composite filter set (quality-agnostic,
// no cap filter — schools determine appropriate size at allocation time) and enqueues
// hits for Prometheus to research.
//
// Fire-and-forget: called from the publishTilt controller after the HTTP response
// is sent. Never throws to its caller.
//
// deps: injectable for tests.

import { logger }               from './logger.service.js'
import { researchQueueService } from './researchQueue.service.js'

const LOG = '[houseScan]'

// Minimum daily volume: below this a name is too illiquid to research meaningfully.
const MIN_VOLUME = 500_000
// Cap per sector — Prometheus researches one at a time; flooding the queue wastes attention.
const HITS_PER_SECTOR = 20

/** Sectors whose stance is 'over' in the published tilt. */
function _overweightSectors(tiltDoc) {
    return (Array.isArray(tiltDoc?.tilts) ? tiltDoc.tilts : [])
        .filter(r => r?.stance === 'over')
        .map(r => r.sector)
        .filter(Boolean)
}

/**
 * Run a house scan for all overweight sectors in the tilt and enqueue hits.
 * Fire-and-forget — wraps everything in a try/catch so it never surfaces to the caller.
 */
export async function runHouseScan(tiltDoc, deps = _io) {
    try {
        const sectors = _overweightSectors(tiltDoc)
        if (!sectors.length) {
            logger.info(LOG, 'no overweight sectors — nothing to scan')
            return
        }
        logger.info(LOG, 'house scan starting', { sectors })

        const enqueue = deps.enqueue ?? researchQueueService.enqueue.bind(researchQueueService)
        const seen    = new Set()
        let queued    = 0
        let skipped   = 0

        for (const sector of sectors) {
            let symbols
            try {
                symbols = await deps.screenSector(sector)
            } catch (err) {
                logger.warn(LOG, `sector screen failed: ${sector} (scan continues)`, err.message)
                continue
            }
            for (const sym of symbols) {
                if (seen.has(sym)) continue   // appeared in a prior sector — don't double-enqueue
                seen.add(sym)
                const res = await enqueue({ symbol: sym, source: 'argus', requestedBy: 'house' })
                if (res.duplicate) skipped++
                else if (res.ok)   queued++
            }
        }
        logger.info(LOG, 'house scan complete', { sectors: sectors.length, queued, skipped_duplicate: skipped })
    } catch (err) {
        logger.error(LOG, 'house scan failed (caller unaffected)', err)
    }
}

// Default IO: FMP screener imported lazily so tests can inject stubs without
// dragging the provider stack in.
const _io = {
    async screenSector(sector) {
        try {
            const { screenCandidatesRaw } = await import('../providers/fmp.provider.js')
            const rows = await screenCandidatesRaw({
                sector,
                volumeMoreThan: MIN_VOLUME,
                isEtf:          'false',
                limit:          HITS_PER_SECTOR,
            })
            return rows.map(r => String(r.symbol || '').toUpperCase().trim()).filter(Boolean)
        } catch (err) {
            logger.warn(LOG, `sector screen failed: ${sector}`, err.message)
            return []
        }
    },
}
