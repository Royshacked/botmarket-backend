// ECHO, READ (docs/design/echo-pipeline.md, "The app") — the events the pipeline built, shaped for the Hotlist's Echo tab
// and the event analyst. The house's events are everyone's; a user's own events (mapped in chat) are theirs alone.
//
// One event as the screen reads it: the Step 1 record; every link with its map line (layer, relation, direction, why,
// filing evidence), its Step 3 score (the six factors and their reasons, the total, high or not, the ledger), its Step 4
// check (the moves, volume, analyst actions, the flag and why) and its Step 7 grades — SORTED BY SCORE, the doc's
// ranking; the wave watch's triggers; and the validation report over every graded event, which the tab labels as
// running until walk-forward has its events.
//
// The engine's old forward test (`echo_forward`) is no longer read: Roy, 2026-11-19 — Echo is built to the design.

import { echoEventsService } from './echoEvents.service.js'
import { report as validationReport } from './echoValidate.service.js'

const FLAGS = ['underreacted_winner', 'overreacted_loser']
export const EVENT_ID = /^ev_[0-9a-f-]{36}$/

const _deps = { events: echoEventsService, report: validationReport }
export function _setDeps(d) { Object.assign(_deps, d) }

/** One event in a line — the list's row. Pure. */
export function shapeSummary(d) {
    const scores = d.scores?.links ?? []
    const checks = d.check?.links ?? []
    return {
        id: d._id, kind: d.kind, mine: d.kind === 'user', date: d.date, type: d.type, origin: d.origin, tickers: d.originTickers ?? [],
        effect: d.effect, durability: d.durability?.kind ?? null, whatChanged: d.whatChanged, size: d.size ?? null, status: d.status,
        links: d.map?.links?.length ?? 0, high: scores.filter(s => s.high).length,
        flagged: checks.filter(c => FLAGS.includes(c.flag)).map(c => ({ ticker: c.ticker, flag: c.flag, total: c.total })),
        top: scores.slice(0, 3).map(s => ({ ticker: s.ticker, total: s.total })),
        followUpOf: d.followUpOf ?? null, triggers: d.triggers?.length ?? 0,
        waiting: d.waiting ?? null, expiredBecause: d.expiredBecause ?? null, error: d.lastError?.reason ?? null,
        graded: Object.keys(d.grades ?? {}).map(Number),
    }
}

/** One event whole: every link with its map line, score, check and grades, sorted by score. Pure. */
export function shapeEvent(d) {
    const score = new Map((d.scores?.links ?? []).map(s => [s.ticker, s]))
    const check = new Map((d.check?.links ?? []).map(c => [c.ticker, c]))
    const grade = (t) => Object.fromEntries(Object.entries(d.grades ?? {}).map(([h, g]) => [h, g.rows?.find(r => r.ticker === t)?.signed ?? null]))
    const links = (d.map?.links ?? []).map(l => {
        const s = score.get(l.ticker), c = check.get(l.ticker)
        return {
            ticker: l.ticker, name: l.name, relation: l.relation, layer: l.layer, direction: l.direction, why: l.why, confidence: l.confidence,
            sector: l.sector ?? null, filings: l.filings ?? null,
            total: s?.total ?? null, high: Boolean(s?.high), factors: s?.factors ?? null, ledger: s?.ledger ?? null, supplySentences: s?.supplySentences ?? [],
            check: c ? { moves: c.moves, signedMove: c.signedMove, volume: c.volume, analysts: c.analysts, noticed: c.noticed, gap: c.gap } : null,
            flag: c?.flag ?? null, flagWhy: c?.why ?? null, grades: grade(l.ticker),
        }
    })
    links.sort((a, b) => (FLAGS.includes(b.flag) - FLAGS.includes(a.flag)) || ((b.total ?? -1) - (a.total ?? -1)))
    return {
        ...shapeSummary(d),
        event: { date: d.date, timing: d.timing, type: d.type, origin: d.origin, tickers: d.originTickers ?? [], terms: d.terms ?? [], whatChanged: d.whatChanged,
            size: d.size ?? null, durability: d.durability ?? null, effect: d.effect, filter: d.filter ?? null, sources: d.sources ?? [], source: d.source ?? null },
        map: d.map ? { model: d.map.model, promptVersion: d.map.promptVersion, mappedAt: d.map.mappedAt, fromTemplate: d.map.fromTemplate, dropped: d.map.dropped ?? [] } : null,
        scored: d.scores ? { model: d.scores.model, scoredAt: d.scores.scoredAt, high: d.scores.high } : null,
        checked: d.check ? { day0: d.check.day0, checkDay: d.check.checkDay, yardstick: d.check.yardstick, origin: d.check.origin, impliedVolatility: d.check.impliedVolatility } : null,
        triggers: d.triggers ?? [],
        links,
    }
}

/** The validation report in the tab's terms: per horizon the flagged against the stand-ins, and walk-forward's state. */
function reportSummary(r) {
    return { events: r.events, horizons: r.horizons, factors: r.factors, walkForward: r.walkForward }
}

/** The house's events and the user's own, newest first, and the validation report. */
export async function listEvents(userId = null) {
    const docs = await _deps.events.list({ userId, limit: 200 })
    const graded = await _deps.events.listGraded().catch(() => [])
    return { events: docs.map(shapeSummary), report: reportSummary(_deps.report(graded)) }
}

/** One event (a user's only for them), or null. */
export async function getEvent(id, userId = null) {
    if (!EVENT_ID.test(String(id))) return null
    const d = await _deps.events.get(id, userId)
    return d ? shapeEvent(d) : null
}

export const echoService = { listEvents, getEvent, shapeEvent, shapeSummary }
