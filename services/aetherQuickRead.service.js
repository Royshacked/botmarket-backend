// Prometheus's quick read on an Aether name — is the exposure credible, priced in, or contradicted?
//
// These names are swing candidates and Mentor builds the setup. A swing does not need a price
// target; it needs to know whether anything the company has said or filed SINCE the event cuts
// against Aether's mechanism, and whether the estimates have already moved. That is phases 1–2 of
// Prometheus, narrowly, on Sonnet — a verdict and one paragraph, a few cents — and it is
// OPTIONAL: Mentor reads filings and news while it builds anyway, so this is for the names the
// user is unsure about, pressed per name, never a gate on the hand-off.
//
// NODE OWNS THIS COLLECTION. The engine's own collections are Python's to write (see
// api/aether/aether.service.js — "Node.js is read-only here"), so the read does not go on the
// candidate row; it goes in `aether_candidate_reads`, keyed by (run_id, ticker), and the list read
// joins it on. The same split the scorecard makes in the other direction.
//
// ONE READ PER NAME PER EVENT, and one in flight. A second press while the first is running gets
// the same promise, not a second model call; a press on a name already read gets the stored read.
// There is no re-read yet — the day a read goes stale as news develops, `force` is one line here
// and one button there, and it is left out until someone asks for it.

import { getDb } from '../providers/mongodb.provider.js'
import { COLLECTIONS } from '../api/aether/aether.model.js'
import { logger } from './logger.service.js'

const LOG = '[aetherQuickRead]'

export const READS = 'aether_candidate_reads'

// Sonnet at medium effort: the judgment is "does anything since the event contradict this", which
// is reading, not modelling, and the whole point is that it costs a fraction of a coverage run.
export const QUICKREAD_MODEL  = 'claude-sonnet-5'
export const QUICKREAD_EFFORT = 'medium'

const _inflight = new Map()   // `${run_id}|${ticker}` → promise

const _key = (runId, ticker) => `${runId}|${ticker}`

/** Per-user context is neither wanted nor safe in a broadcast read: house venue, no book. */
const AUDIENCE = null

/**
 * What the user (the desk, really) says to Prometheus. PURE, and every line traces to a stored
 * field — the same discipline as the Mentor seed, framed as a question rather than a lean.
 */
export function quickReadOpening(c, run = {}) {
    const side = c.side === 'hurt' ? 'HURT' : c.side === 'helped' ? 'HELPED' : 'MIXED'
    const when = (run.event_date || c.event_date || run.created_at || c.created_at || '').slice(0, 10)
    const lines = [
        `Quick read on ${c.ticker}${c.company ? ` (${c.company})` : ''}. Aether named it ${side} by an event — `
        + `${run.subject || c.subject || 'an event'}${when ? ` (${when})` : ''}${run.event || c.event ? `: "${run.event || c.event}"` : '.'}`,
        c.mechanism ? `Aether's mechanism: ${c.mechanism}` : '',
        c.press_evidence ? `Press fact Aether cited: ${c.press_evidence}${c.source_url ? ` (${c.source_url})` : ''}` : '',
        c.verdict === 'quantified' || c.verdict === 'mentioned'
            ? `Its filings, per Aether's verification: ${c.verdict}${c.filing_evidence ? ` — "${c.filing_evidence}"` : ''}`
            : c.verdict === 'silent'
                ? 'Its filings, per Aether’s verification: silent — nothing it has filed mentions this.'
                : '',
        c.excess_pct != null
            ? `Move since the event: ${(c.excess_pct * 100).toFixed(1)}% vs SPY${c.extension != null ? ` (${c.extension.toFixed(1)}σ)` : ''}${c.price_asof ? `, as of ${c.price_asof}` : ''}.`
            : 'No move measured yet.',
        c.expires_at ? `The claim expires ${c.expires_at}${c.next_earnings ? ' at its next report' : ''}.` : '',
        `Is this exposure credible, already priced in, or contradicted by what ${c.ticker} has said or filed since ${when || 'the event'}?`,
    ]
    return lines.filter(Boolean).join('\n')
}

/** The stored reads for a set of runs, keyed `${run_id}|${ticker}`. Empty map on a read failure. */
export async function readsFor(runIds = []) {
    if (!runIds.length) return new Map()
    try {
        const db   = await getDb()
        const rows = await db.collection(READS)
            .find({ run_id: { $in: runIds } }, { projection: { _id: 0 } })
            .toArray()
        return new Map(rows.map(r => [_key(r.run_id, r.ticker), r]))
    } catch (err) {
        // The list is the product; a read that will not join is a missing annotation, not a
        // missing list.
        logger.warn(LOG, 'readsFor failed', err.message)
        return new Map()
    }
}

/** Attach `quick_read` to every candidate in the grouped runs. Mutates and returns `runs`. */
export function attachReads(runs = [], reads = new Map()) {
    for (const run of runs) {
        for (const c of run.candidates ?? []) {
            const r = reads.get(_key(run.run_id, c.ticker))
            if (r) c.quick_read = r
        }
    }
    return runs
}

// Default IO — the candidate row, the agent, the store. Injected by the tests.
const _io = {
    async candidate(runId, ticker) {
        const db = await getDb()
        return db.collection(COLLECTIONS.EVENT_CANDIDATES).findOne({ run_id: runId, ticker }, { projection: { _id: 0 } })
    },
    async existing(runId, ticker) {
        const db = await getDb()
        return db.collection(READS).findOne({ run_id: runId, ticker }, { projection: { _id: 0 } })
    },
    async read({ opening, userId, signal }) {
        const { analystAgentService, MODES } = await import('./agents/analyst.agent.service.js')
        return analystAgentService.chatStream({
            messages: [], userPrompt: opening, chatState: {}, audience: AUDIENCE,
            mode: MODES.QUICKREAD, model: QUICKREAD_MODEL, reasoningEffort: QUICKREAD_EFFORT,
            userId, signal,
        })
    },
    async store(doc) {
        const db = await getDb()
        await db.collection(READS).replaceOne({ run_id: doc.run_id, ticker: doc.ticker }, doc, { upsert: true })
        return doc
    },
}

/**
 * The read for one name on one event — stored if it exists, produced if it does not.
 *
 * `userId` is whose model call it is (budget, ceiling, the turn record), not whose read: the
 * result is a broadcast annotation on a broadcast list, so the doc carries `read_by` for the
 * record and nothing about the user reaches the prompt.
 */
export async function quickRead({ runId, ticker, userId, signal } = {}, deps = _io) {
    const sym = String(ticker ?? '').trim().toUpperCase()
    if (!runId || !/^[A-Z0-9.-]{1,12}$/.test(sym)) throw Object.assign(new Error('a run and a ticker are required'), { status: 400 })

    const existing = await deps.existing(runId, sym)
    if (existing) return existing

    const key = _key(runId, sym)
    if (_inflight.has(key)) return _inflight.get(key)

    const job = (async () => {
        const c = await deps.candidate(runId, sym)
        if (!c) throw Object.assign(new Error('no such candidate'), { status: 404 })
        // The event fields are denormalised onto the candidate by the engine, so the row is the run.
        const opening = quickReadOpening(c, c)
        const t0 = Date.now()
        const out = await deps.read({ opening, userId, signal })
        const q = out?.quickread
        const doc = {
            run_id: runId, ticker: sym,
            verdict:    q?.verdict ?? 'unclear',
            confidence: q?.confidence ?? null,
            read:       q?.read || out?.reply || '',
            evidence:   q?.evidence ?? [],
            checked:    q?.checked ?? [],
            reply:      out?.reply ?? '',
            model:      QUICKREAD_MODEL,
            read_by:    userId ?? null,
            read_at:    new Date().toISOString(),
            took_ms:    Date.now() - t0,
        }
        logger.info(LOG, 'quick read', { runId, ticker: sym, verdict: doc.verdict, confidence: doc.confidence, ms: doc.took_ms })
        return deps.store(doc)
    })()

    _inflight.set(key, job)
    try {
        return await job
    } finally {
        _inflight.delete(key)
    }
}

export const aetherQuickReadService = { quickRead, readsFor, attachReads, quickReadOpening }
