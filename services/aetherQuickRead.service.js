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
//
// JUDGED AGAINST EVERY LIVE EVENT NAMING THE TICKER, not the one whose row was pressed. A name
// two events reach in opposite directions is two live claims about one company, and a read that
// saw only one of them could come back `credible` on both sides. So the opening carries the
// other appearances — subject, side, mechanism, move — and asks which way the name goes on the
// whole; the verdict stays a verdict on THIS event's claim, and `net` says the direction across
// all of them. The read records which runs it considered, and a stored read whose set of other
// events has since changed is read again rather than served stale: that is the one re-read there
// is, and it has a reason. Sixty days is the window, the same one the list shows.

import { getDb } from '../providers/mongodb.provider.js'
import { COLLECTIONS, TICKER_RE } from '../api/aether/aether.model.js'
import { logger } from './logger.service.js'
import { httpError } from './httpError.util.js'
import { isAllowedModel } from './llmModels.js'
import { getHouseModels } from './houseModels.service.js'

const LOG = '[aetherQuickRead]'

export const READS = 'aether_candidate_reads'

// Sonnet at medium effort: the judgment is "does anything since the event contradict this", which
// is reading, not modelling, and the whole point is that it costs a fraction of a coverage run.
// The DEFAULT, since 2026-09-20 — the read runs on the HOUSE chat model (the one choice every desk
// runs on, resolveAgentStream), whoever pressed; the stored doc names the model that produced it.
// The client still sends `model` on the wire; it is not read.
export const QUICKREAD_MODEL  = 'claude-sonnet-5'
export const QUICKREAD_EFFORT = 'medium'

/**
 * The model a read runs on — the same rule as every desk turn (resolveAgentStream): the HOUSE
 * chat model (houseModels.service), whoever asked. Unset, unknown or unreadable → the default.
 */
export async function quickReadModel(_house = getHouseModels) {
    const house = (await _house().catch(() => null))?.chatModel
    return isAllowedModel(house) ? house : QUICKREAD_MODEL
}

const _inflight = new Map()   // `${run_id}|${ticker}` → promise

const _key = (runId, ticker) => `${runId}|${ticker}`

/** Per-user context is neither wanted nor safe in a broadcast read: house venue, no book. */
const AUDIENCE = null

const SIDE = s => (s === 'hurt' ? 'HURT' : s === 'helped' ? 'HELPED' : 'MIXED')

/**
 * What the user (the desk, really) says to Prometheus. PURE, and every line traces to a stored
 * field — the same discipline as the Mentor seed, framed as a question rather than a lean.
 *
 * `others` are the ticker's other live appearances. With any, the question widens: the read is
 * asked to weigh every mechanism against the record and say which dominates.
 */
export function quickReadOpening(c, run = {}, others = []) {
    const side = SIDE(c.side)
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
        // The sized share of revenue, when the filing gave one — the first of the four inputs the
        // sizing step needs, and the one it should take from here rather than re-derive.
        c.impact_pct_revenue != null
            ? `The filing sizes the exposed line at ${(c.impact_pct_revenue * 100).toFixed(2)}% of revenue (impact_pct_revenue) — use that as exposed_revenue_pct.`
            : '',
        c.excess_pct != null
            ? `Move since the event: ${(c.excess_pct * 100).toFixed(1)}% vs SPY${c.extension != null ? ` (${c.extension.toFixed(1)}σ)` : ''}${c.price_asof ? `, as of ${c.price_asof}` : ''}.`
            : 'No move measured yet.',
        c.expires_at ? `The claim expires ${c.expires_at}${c.next_earnings ? ' at its next report' : ''}.` : '',
    ]
    if (others.length) {
        const sides = new Set([c.side, ...others.map(o => o.side)])
        lines.push(`Aether has ALSO named ${c.ticker} by ${others.length} other live event${others.length > 1 ? 's' : ''}`
            + `${sides.size > 1 ? ' — and they pull it in OPPOSITE directions' : ''}:`)
        for (const o of others) {
            const d = (o.event_date || o.created_at || '').slice(0, 10)
            lines.push(`- ${o.subject || o.event || 'an event'}${d ? ` (${d})` : ''}, ${SIDE(o.side)}`
                + `${o.mechanism ? `: ${o.mechanism}` : ''}`
                + `${o.excess_pct != null ? ` Move since: ${(o.excess_pct * 100).toFixed(1)}% vs SPY.` : ''}`)
        }
        lines.push(`Judge ${c.ticker} against ALL of them. Is THIS event's claim (${side}) credible, already priced in, `
            + `or contradicted — by the record, or by another event's mechanism that dominates it? `
            + `And on the whole, across every event naming it, which way does the name go?`)
    } else {
        lines.push(`Is this exposure credible, already priced in, or contradicted by what ${c.ticker} has said or filed since ${when || 'the event'}?`)
    }
    return lines.filter(Boolean).join('\n')
}

/** The other appearances a read should weigh: live, in the list's window, not this run. */
const OTHERS_DAYS = 60

/** Two sets of run ids, compared as sets — the order Mongo returns them in is not a fact. */
function _sameRuns(a = [], b = []) {
    const A = [...new Set(a)].sort(), B = [...new Set(b)].sort()
    return A.length === B.length && A.every((x, i) => x === B[i])
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
    async others(runId, ticker) {
        const db    = await getDb()
        const since = new Date(Date.now() - OTHERS_DAYS * 86_400_000).toISOString()
        return db.collection(COLLECTIONS.EVENT_CANDIDATES)
            .find({ ticker, run_id: { $ne: runId }, survived: true, created_at: { $gte: since } },
                  { projection: { _id: 0, run_id: 1, subject: 1, event: 1, side: 1, mechanism: 1,
                                  event_date: 1, created_at: 1, excess_pct: 1 } })
            .sort({ created_at: -1 })
            .toArray()
    },
    async read({ opening, userId, signal, model = QUICKREAD_MODEL }) {
        const { analystAgentService, MODES } = await import('./agents/analyst.agent.service.js')
        return analystAgentService.chatStream({
            messages: [], userPrompt: opening, chatState: {}, audience: AUDIENCE,
            mode: MODES.QUICKREAD, model, reasoningEffort: QUICKREAD_EFFORT,
            userId, signal,
        })
    },
    house:   getHouseModels,
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
    if (!runId || !TICKER_RE.test(sym)) throw httpError(400, 'a run and a ticker are required')

    // The other live events naming it — read once, used both to decide whether a stored read is
    // still about the same set of claims and, if not, to write the opening.
    const others = (await deps.others(runId, sym)) ?? []
    const otherIds = others.map(o => o.run_id)

    const existing = await deps.existing(runId, sym)
    if (existing && _sameRuns(existing.considered, otherIds)) return existing
    if (existing) logger.info(LOG, 're-reading: the set of events naming it changed', { runId, ticker: sym })

    // AFTER the awaits, so two presses that both passed them find one job: the check and the
    // set below run in the same synchronous stretch.
    const key = _key(runId, sym)
    if (_inflight.has(key)) return _inflight.get(key)

    const job = (async () => {
        const c = await deps.candidate(runId, sym)
        if (!c) throw httpError(404, 'no such candidate')
        // The event fields are denormalised onto the candidate by the engine, so the row is the run.
        const opening = quickReadOpening(c, c, others)
        const model = await quickReadModel(deps.house ?? getHouseModels)
        const t0 = Date.now()
        const out = await deps.read({ opening, userId, signal, model })
        const q = out?.quickread
        const doc = {
            run_id: runId, ticker: sym,
            verdict:    q?.verdict ?? 'unclear',
            confidence: q?.confidence ?? null,
            // Across every event naming it. Null when one event names it — there is no "net"
            // of one claim, and the verdict already says what it says.
            net:        others.length ? (q?.net ?? 'unclear') : null,
            considered: otherIds,
            read:       q?.read || out?.reply || '',
            evidence:   q?.evidence ?? [],
            checked:    q?.checked ?? [],
            // What the event alone is worth, from compute_event_delta — null when the read did not size
            // (contradicted, or no share of revenue to stand on). The four inputs ride inside it.
            delta:      q?.delta ?? null,
            delta_basis: q?.delta_basis ?? '',
            reply:      out?.reply ?? '',
            model,
            read_by:    userId ?? null,
            read_at:    new Date().toISOString(),
            took_ms:    Date.now() - t0,
        }
        logger.info(LOG, 'quick read', { runId, ticker: sym, model, verdict: doc.verdict, net: doc.net, others: otherIds.length, confidence: doc.confidence,
                                         delta: doc.delta?.delta_price_pct ?? null, open: doc.delta?.remaining_pct ?? null, ms: doc.took_ms })
        return deps.store(doc)
    })()

    _inflight.set(key, job)
    try {
        return await job
    } finally {
        _inflight.delete(key)
    }
}

