// ECHO'S PIPELINE (docs/design/echo-pipeline.md) — one event through the simulator doc's steps, in order, each writing
// its part onto the event (echoEvents):
//
//   framed  → Step 2 map (echoChain)   → mapped
//   mapped  → Step 3 score (echoScore) → scored
//   scored  → Step 4 check (echoCheck) at the day-5 close → watching
//   watching → Step 5 (echoWatch): triggers re-run Steps 3 and 4, once a day; expiry → expired
//   checked  → Step 7 (echoValidate): graded at 5 / 20 / 60 / 120 sessions as they come due, expired or not
//
// `run(event)` goes as far as it can now (a user's event in chat: mapped and scored at once; its check waits for the
// day-5 close). `tick()` moves every open event along — the house's loop (monitoring/echoPipeline.monitor.service.js,
// ECHO_PIPELINE). A step that fails leaves the event where it was, with the reason, for the next tick.

import { echoEventsService } from './echoEvents.service.js'
import { mapEvent } from './echoChain.service.js'
import { scoreEvent } from './echoScore.service.js'
import { checkEvent } from './echoCheck.service.js'
import { watchEvent } from './echoWatch.service.js'
import { gradeEvent } from './echoValidate.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoPipeline]'
export const OPEN = Object.freeze(['framed', 'mapped', 'scored'])
export const WATCH_EVERY_MS = 20 * 60 * 60 * 1000
// A failed step backs off — 1, 2, 4, 8 hours — and gives up after the fifth (CR 2026-11-19: a score that failed every
// time re-ran an Opus call every hour, for ever, billed to whoever owned the event).
export const MAX_ATTEMPTS = 5
const BACKOFF_MS = (n) => Math.min(24, 2 ** (n - 1)) * 60 * 60 * 1000
const CHECK_CHECKED_ONLY = "a user's event the filter did not take (not a surprise, large and more than a one-off): checked at day 5, no watch"

/** The next US close a check can read (21:45 UTC — after 16:15 New York either side of daylight time), after `now`. */
export function nextClose(now = new Date()) {
    const d = new Date(now)
    d.setUTCHours(21, 45, 0, 0)
    if (d <= now) d.setUTCDate(d.getUTCDate() + 1)
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
    return d
}

const _deps = { events: echoEventsService, map: mapEvent, score: scoreEvent, check: checkEvent, watch: watchEvent, grade: gradeEvent, now: () => new Date() }
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * Take one event as far as it can go now. → `{ status, stoppedAt?, reason?, wait? }` — the status it reached; when a
 * step failed or must wait, which and why (also written onto the event). A run first CLAIMS the event, so chat and the
 * tick never run one twice; a failure backs off (`nextRunAt`) and gives up after MAX_ATTEMPTS; a check that waits for its
 * close sleeps until the next one. Never throws.
 */
export async function run(ev) {
    const claimed = await _deps.events.claim(ev._id).catch(() => null)
    if (!claimed) return { status: ev.status, stoppedAt: 'claim', reason: 'another run holds it', wait: true }
    let doc = { ...ev, ...claimed }
    const userId = doc.kind === 'user' ? doc.userId : null
    const stop = async (step, reason, wait = false) => {
        const now = _deps.now()
        const attempts = wait ? (doc.attempts ?? 0) : (doc.attempts ?? 0) + 1
        const gaveUp = !wait && attempts >= MAX_ATTEMPTS
        await _deps.events.advance(doc._id, doc.status, {
            lastError: wait ? null : { step, reason, at: now.toISOString() }, waiting: wait ? reason : null, attempts, gaveUp,
            nextRunAt: (wait ? nextClose(now) : new Date(now.getTime() + BACKOFF_MS(attempts))).toISOString(),
        }).catch(() => {})
        if (gaveUp) logger.warn(LOG, 'gave up on an event', { event: doc._id, step, reason, attempts })
        return { status: doc.status, stoppedAt: step, reason, wait, ...(gaveUp ? { gaveUp } : {}) }
    }
    try {
        const clean = { lastError: null, attempts: 0, nextRunAt: null }
        if (doc.status === 'framed') {
            const r = await _deps.map(doc, { userId })
            if (!r.ok) return stop('map', r.reason)
            await _deps.events.advance(doc._id, 'mapped', { map: r.map, ...clean })
            await _deps.events.claim(doc._id).catch(() => null)   // the advance released it; the run goes on
            doc = { ...doc, status: 'mapped', map: r.map, attempts: 0 }
        }
        if (doc.status === 'mapped') {
            const r = await _deps.score(doc, doc.map, { userId })
            if (!r.ok) return stop('score', r.reason)
            await _deps.events.advance(doc._id, 'scored', { scores: r.scores, ...clean })
            await _deps.events.claim(doc._id).catch(() => null)
            doc = { ...doc, status: 'scored', scores: r.scores, attempts: 0 }
        }
        if (doc.status === 'scored') {
            const r = await _deps.check(doc, doc.map, doc.scores)
            if (!r.ok) return stop('check', r.reason, Boolean(r.wait))
            // A user's own event the filter did not take is checked and stops there (Roy, 2026-11-19); the house's — and a
            // user's the filter took, now the house's — go on to the wave watch.
            const checkedOnly = doc.kind === 'user'
            const next = checkedOnly ? 'expired' : 'watching'
            await _deps.events.advance(doc._id, next, { check: r.check, ...clean, waiting: null, ...(checkedOnly ? { expiredBecause: CHECK_CHECKED_ONLY } : {}) })
            doc = { ...doc, status: next, check: r.check }
        }
        // Nothing to do here: let the claim go.
        if (!OPEN.includes(doc.status) && doc.status === ev.status) await _deps.events.advance(doc._id, doc.status).catch(() => {})
        return { status: doc.status }
    } catch (err) {
        logger.warn(LOG, 'run failed', { event: doc._id, status: doc.status, error: err.message })
        return stop(doc.status, err.message)
    }
}

/**
 * Every open event (the house's and the users'), one at a time; then the wave watch (Step 5) on each watched event not
 * watched in the last 20 hours — once a day is the doc's pace (a trigger is a filing or an earnings print).
 * → `{ ran: [{ id, ...result }], watched: [...] }`. Never throws.
 */
export async function tick() {
    let open = []
    try { open = await _deps.events.listOpen() } catch (err) {
        logger.warn(LOG, 'could not list open events', { error: err.message })
        return { ran: [], watched: [] }
    }
    const ran = []
    for (const ev of open) ran.push({ id: ev._id, ...await run(ev) })
    const moved = ran.filter(r => !r.stoppedAt).length
    if (ran.length) logger.info(LOG, 'tick', { open: ran.length, moved, waiting: ran.filter(r => r.wait).length, failed: ran.filter(r => r.stoppedAt && !r.wait).length })
    const watched = []
    const now = Date.now()
    for (const ev of await _deps.events.listWatching().catch(() => [])) {
        if (ev.watchedAt && now - Date.parse(ev.watchedAt) < WATCH_EVERY_MS) continue
        watched.push(await _deps.watch(ev))
    }
    if (watched.length) logger.info(LOG, 'watch', { events: watched.length, triggers: watched.reduce((s, w) => s + w.triggers, 0), expired: watched.filter(w => w.expired).length })
    // Step 7: the grades that came due, once a day an event.
    const graded = []
    for (const ev of await _deps.events.listGradable().catch(() => [])) {
        if (ev.gradedAt && now - Date.parse(ev.gradedAt) < WATCH_EVERY_MS) continue
        const g = await _deps.grade(ev)
        if (g.graded.length) graded.push({ id: ev._id, horizons: g.graded })
    }
    if (graded.length) logger.info(LOG, 'graded', { events: graded.length })
    return { ran, watched, graded }
}

export const echoPipelineService = { run, tick }
