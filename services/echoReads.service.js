// ECHO'S NAMES THROUGH PROMETHEUS (docs/design/echo-desk.md §6; Roy, 2026-11-19: "when a name comes up it should go
// through Prometheus and Proteus according to horizon"). Proteus's profile is no longer queued here (2026-11-21, Proteus
// v2 — docs/design/proteus-v2.md): it builds in seconds when a name is opened or asked about.
//
// No new research path: the chain Mentor's reads use. For each name —
//   PROMETHEUS  his read FOR THE HORIZON (mentorReads.readFor): swing → coverage. Ready, waiting, passed or failed → it
//            stands, nothing is queued. Missing → a research-queue row (source `echo`, the event and the link as its
//            context — researchRun.echoOpening says them) and the house's run started inside Echo's weekly budget.
//
// WHICH NAMES (Roy, 2026-11-19: "flagged only"; horizon SWING):
//   · a house event's FLAGGED links — the simulator doc's underreacted winners and overreacted losers, from the
//     pipeline's day-5 market check (echoCheck; docs/design/echo-pipeline.md) — handed off ONCE per event (echo_handoffs);
//   · a user event's names, when the user asks the event analyst for them (request_reads), at most MAX_ASK at a time.
//
// The research run lives in memory: a deploy mid-run leaves rows claimed. Each tick puts dead claims back and researches
// what waits (houseResearch.resumeQueued), as the other chains do.

import { getDb } from '../providers/mongodb.provider.js'
import { echoEventsService } from './echoEvents.service.js'
import { mentorReadsService } from './mentorReads.service.js'
import { researchQueueService } from './researchQueue.service.js'
import { researchQueued, resumeQueued } from './houseResearch.service.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[echoReads]'
export const SOURCE = 'echo'
export const HANDOFFS = 'echo_handoffs'
export const HORIZON = 'swing'
export const MAX_ASK = 5
// A user's asks are capped by COUNT, not dollars (Mentor's reads are the same): names queued for them in a week.
export const MAX_USER_WEEK = 10
export const BUDGET_WINDOW_MS = 7 * 86_400_000
const HANDOFF_SCAN = 200
const HOUSE = 'house'
// The weekly budget is the HOUSE's — the forward test's names. A user's asks share the source and never count against it
// (code review 2026-11-19).
const houseSpend = (r) => (r.requestedBy ?? HOUSE) === HOUSE
// A name's answer that is final: anything but a read that could not be checked or a row that could not be written.
const UNSETTLED = new Set(['unknown', 'not_queued'])
const normal = (s) => String(s ?? '').toUpperCase().trim()

const _deps = {
    readFor: (s, h) => mentorReadsService.readFor(s, h),
    enqueue: (row) => researchQueueService.enqueue(row),
    listQueue: (q) => researchQueueService.listQueue(q),
    research: (o) => researchQueued(o),
    resume: (symbols, research, o) => resumeQueued(symbols, research, undefined, o),
    events: async () => ({ events: (await echoEventsService.list({ status: ['watching', 'expired'], limit: 300 })).filter(d => d.kind === 'house').map(handoffShape) }),
    db: null,
    on: () => config.echoReads,
    maxUsd: () => config.echoResearchMaxUsd,
    now: () => Date.now(),
}
export function _setDeps(d) { Object.assign(_deps, d) }
const handoffs = async (deps = _deps) => (deps.db ?? await getDb()).collection(HANDOFFS)

const FLAGS = new Set(['underreacted_winner', 'overreacted_loser'])
const FLAG_WORDS = { underreacted_winner: 'underreacted winner', overreacted_loser: 'overreacted loser' }

/** A checked house event → the hand-off's shape: its flagged links with their map lines and scores. Pure. */
export function handoffShape(d) {
    const map = new Map((d.map?.links ?? []).map(l => [l.ticker, l]))
    return {
        id: d._id, date: d.date, origin: d.origin, tickers: d.originTickers ?? [], effect: d.effect, size: d.size ?? null,
        whatChanged: d.whatChanged, status: 'checked',
        flagged: (d.check?.links ?? []).filter(c => FLAGS.has(c.flag)).map(c => ({
            ticker: c.ticker, relation: c.relation, direction: c.direction, why: map.get(c.ticker)?.why ?? null, flag: c.flag, total: c.total,
        })),
    }
}

/** What travels with a flagged house name to Prometheus. Pure. */
export function forwardContext(ev, link) {
    const who = (ev.tickers ?? []).join('/') || ev.origin
    return {
        echo: true, forward: true, horizon: HORIZON, event_id: ev.id,
        event: `${ev.whatChanged ?? `${ev.origin} demand ${ev.effect}`} (${ev.date})${ev.size ? ` — ${ev.size}` : ''}`,
        origin: ev.origin, relation: link.relation, direction: link.direction, why: link.why ?? null, flag: link.flag ?? null, score: link.total ?? null,
        reason: `The event analyst: ${FLAG_WORDS[link.flag] ?? 'flagged'} — ${link.relation} of ${who}${link.total != null ? `, scored ${link.total}/12` : ''}`,
    }
}

/**
 * Send names on: Prometheus's swing read for those without one standing. `contextOf(sym)`
 * says why each is here. → `{ ok, names: [{ symbol, read }], queued: [symbols], research }`. Never throws.
 */
export async function sendNames(symbols, contextOf, { requestedBy = HOUSE, maxUsd = null } = {}, deps = _deps) {
    const syms = [...new Set((symbols ?? []).map(normal).filter(Boolean))]
    if (!syms.length) return { ok: true, names: [], queued: [], research: null }
    const names = [], queued = []
    for (const symbol of syms) {
        let read
        try {
            const r = await deps.readFor(symbol, HORIZON).catch(() => ({ state: 'unknown' }))
            read = r.state ?? 'unknown'
            if (read === 'missing' && (r.need === 'new' || r.need === 'reinit' || !r.need)) {
                const q = await deps.enqueue({ symbol, source: SOURCE, requestedBy, context: { ...contextOf(symbol), ...(r.need === 'reinit' ? { reinit: true } : {}) } })
                read = q?.ok ? (q.duplicate ? 'waiting' : 'queued') : 'not_queued'
                if (q?.ok && !q.duplicate) queued.push(symbol)
            } else if (read === 'missing') read = 'covered'   // covered on the other book: the coverage stands for now
        } catch (err) {
            logger.warn(LOG, 'name not sent', { symbol, error: err.message })
            read = 'not_queued'
        }
        names.push({ symbol, read })
    }
    const now = deps.now()
    const user = maxUsd === Infinity
    const research = queued.length
        ? await deps.research({ symbols: queued, since: null, source: SOURCE, maxUsd: maxUsd ?? deps.maxUsd(),
            budgetSince: new Date(now - BUDGET_WINDOW_MS).toISOString(), spentBy: user ? () => false : houseSpend })
        : null
    return { ok: true, names, queued, research }
}

/** How many names were queued for this user from Echo in the last week — their asks are capped by it. → a number, or
 * null when the queue could not be read. */
export async function userAskedThisWeek(userId, deps = _deps) {
    const rows = await deps.listQueue({ source: SOURCE, since: new Date(deps.now() - BUDGET_WINDOW_MS).toISOString(), limit: 1000 })
    if (rows === null) return null
    return new Set((rows ?? []).filter(r => r.requestedBy === String(userId)).map(r => r.symbol)).size
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
            // Each event on its own: one that throws does not hold back the rest. One whose names did not all settle (the
            // read could not be checked, the row could not be written) is NOT recorded — the next tick sends it again, and
            // the names already queued come back as `waiting` (code review 2026-11-19).
            for (const ev of ready.filter(e => !done.has(e.id))) {
                try {
                    const byTicker = new Map(ev.flagged.filter(l => normal(l.ticker)).map(l => [normal(l.ticker), l]))
                    const res = await sendNames([...byTicker.keys()], (s) => forwardContext(ev, byTicker.get(s)), {}, deps)
                    const unsettled = res.names.filter(n => UNSETTLED.has(n.read)).map(n => n.symbol)
                    if (unsettled.length) {
                        logger.warn(LOG, 'hand-off unsettled — tried again next tick', { event: ev.id, unsettled })
                        continue
                    }
                    await col.updateOne({ _id: ev.id }, { $setOnInsert: { at: new Date(deps.now()).toISOString(), names: res.names } }, { upsert: true })
                    handed.push(ev.id)
                    logger.info(LOG, 'handed off', { event: ev.id, names: res.names.length, queued: res.queued.length, research: res.research?.outcome ?? null })
                } catch (err) {
                    logger.warn(LOG, 'hand-off failed for an event', { event: ev.id, error: err.message })
                }
            }
        }
    } catch (err) {
        logger.warn(LOG, 'hand-off failed', { error: err.message })
    }
    // Rows a dead process left claimed, and names a spent budget or a busy run left waiting. A user's names first and
    // outside the house budget (capped by count where they were asked); the house's inside it. One run at a time: the
    // house's wait for the next tick when a user's ran.
    let resume = null
    try {
        const waiting = await deps.listQueue({ source: SOURCE, status: ['queued', 'in_research'], limit: 500 })
        const rows = waiting ?? []
        const userSyms = [...new Set(rows.filter(r => !houseSpend(r)).map(r => r.symbol))]
        const houseSyms = [...new Set(rows.filter(houseSpend).map(r => r.symbol))]
        const symbols = userSyms.length ? userSyms : houseSyms
        if (symbols.length) {
            const budgetSince = new Date(deps.now() - BUDGET_WINDOW_MS).toISOString()
            const args = userSyms.length
                ? { symbols, since: null, source: SOURCE, maxUsd: Infinity, budgetSince, spentBy: () => false }
                : { symbols, since: null, source: SOURCE, maxUsd: deps.maxUsd(), budgetSince, spentBy: houseSpend }
            resume = await deps.resume(symbols, () => deps.research(args), { now: deps.now(), source: SOURCE })
        }
    } catch (err) {
        logger.warn(LOG, 'resume failed', { error: err.message })
    }
    return { handed, resume }
}

export const echoReadsService = { sendNames, handOffFlagged, forwardContext, userAskedThisWeek }
