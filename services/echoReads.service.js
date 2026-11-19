// ECHO'S NAMES THROUGH PROMETHEUS AND PROTEUS (docs/design/echo-desk.md §6; Roy, 2026-11-19: "when a name comes up it
// should go through Prometheus and Proteus according to horizon").
//
// No new research path: the chain Mentor's reads use. For each name —
//   PROTEUS  his measured profile, queued (proteusQueue.queueProfiles) — kept a week, shared;
//   PROMETHEUS  his read FOR THE HORIZON (mentorReads.readFor): swing → coverage. Ready, waiting, passed or failed → it
//            stands, nothing is queued. Missing → a research-queue row (source `echo`, the event and the link as its
//            context — researchRun.echoOpening says them) and the house's run started inside Echo's weekly budget.
//
// WHICH NAMES (Roy, 2026-11-19: "flagged only"; horizon SWING for the forward test):
//   · a forward-test event's LAGGING links, once its day-5 check is frozen — handed off ONCE per event (echo_handoffs);
//   · a user event's names, when the user asks the event analyst for them (request_reads), at most MAX_ASK at a time.
//
// The research run lives in memory: a deploy mid-run leaves rows claimed. Each tick puts dead claims back and researches
// what waits (houseResearch.resumeQueued), as the other chains do.

import { getDb } from '../providers/mongodb.provider.js'
import { echoService } from './echo.service.js'
import { mentorReadsService } from './mentorReads.service.js'
import { researchQueueService } from './researchQueue.service.js'
import { researchQueued, resumeQueued } from './houseResearch.service.js'
import { queueProfiles } from './proteusQueue.service.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[echoReads]'
export const SOURCE = 'echo'
export const HANDOFFS = 'echo_handoffs'
export const HORIZON = 'swing'
export const MAX_ASK = 5
export const BUDGET_WINDOW_MS = 7 * 86_400_000
const HANDOFF_SCAN = 200

const _deps = {
    readFor: (s, h) => mentorReadsService.readFor(s, h),
    enqueue: (row) => researchQueueService.enqueue(row),
    listQueue: (q) => researchQueueService.listQueue(q),
    research: (o) => researchQueued(o),
    resume: (symbols, research, o) => resumeQueued(symbols, research, undefined, o),
    profiles: (symbols) => queueProfiles(symbols, { source: SOURCE }),
    events: () => echoService.listEvents(),
    db: null,
    on: () => config.echoReads,
    maxUsd: () => config.echoResearchMaxUsd,
    now: () => Date.now(),
}
export function _setDeps(d) { Object.assign(_deps, d) }
const handoffs = async (deps = _deps) => (deps.db ?? await getDb()).collection(HANDOFFS)

/** What travels with a forward-test name to Prometheus. Pure. */
export function forwardContext(ev, link) {
    return {
        echo: true, forward: true, horizon: HORIZON, event_id: ev.id,
        event: `${ev.origin} (${(ev.tickers ?? []).join('/')}) ${ev.effect === 'up' ? 'up' : 'down'} on its ${ev.date} results — ${ev.size ?? ''}`.trim(),
        origin: ev.origin, relation: link.relation, direction: link.direction, why: link.why ?? null,
        reason: `The event analyst: lagging ${link.relation} of ${(ev.tickers ?? []).join('/') || ev.origin} (forward test)`,
    }
}

/**
 * Send names on: Proteus's profile for every one, Prometheus's swing read for those without one standing. `contextOf(sym)`
 * says why each is here. → `{ ok, names: [{ symbol, read }], queued: [symbols], research }`. Never throws.
 */
export async function sendNames(symbols, contextOf, { requestedBy = 'house', maxUsd = null } = {}, deps = _deps) {
    const syms = [...new Set((symbols ?? []).map(s => String(s ?? '').toUpperCase().trim()).filter(Boolean))]
    if (!syms.length) return { ok: true, names: [], queued: [], research: null }
    try { deps.profiles(syms) } catch (err) { logger.warn(LOG, 'profiles not queued', { error: err.message }) }
    const names = [], queued = []
    for (const symbol of syms) {
        const r = await deps.readFor(symbol, HORIZON).catch(() => ({ state: 'unknown' }))
        let read = r.state ?? 'unknown'
        if (read === 'missing' && (r.need === 'new' || r.need === 'reinit' || !r.need)) {
            const q = await deps.enqueue({ symbol, source: SOURCE, requestedBy, context: { ...contextOf(symbol), ...(r.need === 'reinit' ? { reinit: true } : {}) } })
            read = q?.ok ? (q.duplicate ? 'waiting' : 'queued') : 'not_queued'
            if (q?.ok && !q.duplicate) queued.push(symbol)
        } else if (read === 'missing') read = 'covered'   // covered on the other book: the coverage stands for now
        names.push({ symbol, read })
    }
    const now = deps.now()
    const research = queued.length
        ? await deps.research({ symbols: queued, since: null, source: SOURCE, maxUsd: maxUsd ?? deps.maxUsd(),
            budgetSince: new Date(now - BUDGET_WINDOW_MS).toISOString(), ...(maxUsd === Infinity ? { spentBy: () => false } : {}) })
        : null
    return { ok: true, names, queued, research }
}

/**
 * The tick: every forward-test event whose day-5 check is frozen and was not handed off yet → its lagging names sent on,
 * once (echo_handoffs remembers it, with what each name got). Then the dead claims of Echo's rows back in line and what
 * waits researched. → `{ handed: [eventIds], resume }`. Never throws.
 */
export async function handOffFlagged(deps = _deps) {
    if (!deps.on()) return { handed: [], resume: null, off: true }
    const handed = []
    try {
        const { events } = await deps.events()
        const ready = (events ?? []).filter(e => (e.status === 'checked' || e.status === 'done') && e.flagged?.length).slice(0, HANDOFF_SCAN)
        if (ready.length) {
            const col = await handoffs(deps)
            const done = new Set((await col.find({ _id: { $in: ready.map(e => e.id) } }, { projection: { _id: 1 } }).toArray()).map(d => d._id))
            for (const ev of ready.filter(e => !done.has(e.id))) {
                const byTicker = new Map(ev.flagged.filter(l => l.ticker).map(l => [l.ticker, l]))
                const res = await sendNames([...byTicker.keys()], (s) => forwardContext(ev, byTicker.get(s)), {}, deps)
                await col.updateOne({ _id: ev.id }, { $setOnInsert: { at: new Date(deps.now()).toISOString(), names: res.names } }, { upsert: true })
                handed.push(ev.id)
                logger.info(LOG, 'handed off', { event: ev.id, names: res.names.length, queued: res.queued.length, research: res.research?.outcome ?? null })
            }
        }
    } catch (err) {
        logger.warn(LOG, 'hand-off failed', { error: err.message })
    }
    // Rows a dead process left claimed, and names a spent budget or a busy run left waiting.
    let resume = null
    try {
        const waiting = await deps.listQueue({ source: SOURCE, status: ['queued', 'in_research'], limit: 500 })
        const symbols = [...new Set((waiting ?? []).map(r => r.symbol))]
        if (symbols.length) {
            resume = await deps.resume(symbols, () => deps.research({ symbols, since: null, source: SOURCE, maxUsd: deps.maxUsd(),
                budgetSince: new Date(deps.now() - BUDGET_WINDOW_MS).toISOString() }), { now: deps.now(), source: SOURCE })
        }
    } catch (err) {
        logger.warn(LOG, 'resume failed', { error: err.message })
    }
    return { handed, resume }
}

export const echoReadsService = { sendNames, handOffFlagged, forwardContext }
