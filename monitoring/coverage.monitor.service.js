// Coverage monitor (P5) — the slow background loop that keeps the Analyst's theses LIVING. Mirrors the
// Hermes/Themis pattern (poll loop + due-selection + a two-tier verdict), but at a research cadence:
// each active coverage is re-checked ~daily. It tracks THE GAP (our view vs the Street) via the pure
// classifier in coverage.assess.js — is the Street converging to us (thesis playing out, edge closing)
// or diverging — plus price hitting our target / the invalidation edge. Material verdicts append a
// revision + move status + notify; a quiet day just refreshes the recorded gap.
//
// This is the DETERMINISTIC tier. The full quarterly re-model (re-run compute_valuation with fresh
// estimates) + judging the text kill-criteria is the LLM tier that wakes the Analyst agent — a later add.

import { getDb }                  from '../providers/mongodb.provider.js'
import { getQuote }               from '../providers/yahoofinance.provider.js'
import { getPriceTargetConsensus } from '../providers/fmp.provider.js'
import { coverageService }        from '../api/analyst/coverage.service.js'
import { classifyGapState, recomputeGap, statusForState, nextCheckAt } from './coverage.assess.js'
import { createPollLoop }         from './monitorUtils.js'
import { logger }                 from '../services/logger.service.js'

const LOG        = '[coverageMonitor]'
const COLLECTION = 'coverage'
// Tick hourly; each coverage gates itself to ~daily via monitor.next_check_at (research cadence).
const POLL_INTERVAL_MS = 60 * 60 * 1000
const MAX_PER_TICK     = 50

// Injectable IO so tests exercise the branching without real price/consensus/DB writes.
const _deps = {
    getPrice:       async (sym) => { const q = await getQuote(sym).catch(() => null); return q?.price ?? q?.regularMarketPrice ?? q?.last ?? null },
    getConsensusPt: async (sym) => { const c = await getPriceTargetConsensus(sym).catch(() => null); return c?.consensus ?? null },
    updateCoverage: coverageService.updateCoverage,
    notify:         (cov, verdict) => logger.info(LOG, 'coverage event', { symbol: cov.symbol, state: verdict.state, reason: verdict.reason, edge_gone: verdict.edge_gone }),
}
export function _setDeps(d) { Object.assign(_deps, d) }

const _loop = createPollLoop({ intervalMs: POLL_INTERVAL_MS, tick: _tick, eager: false, log: LOG, name: 'coverage monitor' })
export const coverageMonitorService = { start: _loop.start, stop: _loop.stop }

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
    }).limit(MAX_PER_TICK).toArray()

    for (const cov of due) {
        try { await _checkCoverage(db, cov, Date.now(), _deps) }
        catch (err) { logger.warn(LOG, `check ${cov.symbol} failed:`, err.message) }
    }
}

// Check one coverage: fetch fresh price + consensus → classify the gap → apply. Exported for tests.
export async function _checkCoverage(db, cov, nowMs, deps = _deps) {
    const [price, consensusPt] = await Promise.all([deps.getPrice(cov.symbol), deps.getConsensusPt(cov.symbol)])
    const verdict = classifyGapState(cov, { price, consensus_pt: consensusPt })
    const gap     = recomputeGap(cov.price_target?.value, consensusPt) ?? cov.gap ?? null
    const nextAt  = nextCheckAt(cov, verdict.state, nowMs)
    const bookkeeping = {
        $set: { 'monitor.next_check_at': nextAt, 'monitor.last_checked': new Date(nowMs).toISOString() },
        $inc: { 'monitor.checks': 1 },
    }

    if (verdict.state === 'stable') {
        // Quiet day — refresh the recorded gap + bookkeeping directly (no revision, no notify).
        await db.collection(COLLECTION).updateOne({ id: cov.id }, { ...bookkeeping, $set: { ...bookkeeping.$set, gap } })
        return verdict
    }

    // Material verdict → update the thesis (status + gap + an appended revision) then notify.
    const note  = verdict.reason + (verdict.edge_gone ? ' — edge gone (Street caught up); consider harvest/retire' : '')
    const patch = { gap, revision_kind: verdict.state, revision_note: note }
    const status = statusForState(verdict.state)
    if (status) patch.status = status
    await deps.updateCoverage(cov.id, patch, cov.user_id, true)
    await db.collection(COLLECTION).updateOne({ id: cov.id }, bookkeeping)   // updateCoverage doesn't touch monitor.*
    deps.notify(cov, verdict)
    return verdict
}
