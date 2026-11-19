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

const _deps = { events: echoEventsService, map: mapEvent, score: scoreEvent, check: checkEvent, watch: watchEvent, grade: gradeEvent }
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * Take one event as far as it can go now. → `{ status, stoppedAt?, reason?, wait? }` — the status it reached; when a
 * step failed or must wait, which and why (also written onto the event as `lastError`). Never throws.
 */
export async function run(ev) {
    let doc = ev
    const userId = doc.kind === 'user' ? doc.userId : null
    const stop = async (step, reason, wait = false) => {
        await _deps.events.advance(doc._id, doc.status, { lastError: wait ? null : { step, reason, at: new Date().toISOString() }, waiting: wait ? reason : null }).catch(() => {})
        return { status: doc.status, stoppedAt: step, reason, wait }
    }
    try {
        if (doc.status === 'framed') {
            const r = await _deps.map(doc, { userId })
            if (!r.ok) return stop('map', r.reason)
            await _deps.events.advance(doc._id, 'mapped', { map: r.map, lastError: null })
            doc = { ...doc, status: 'mapped', map: r.map }
        }
        if (doc.status === 'mapped') {
            const r = await _deps.score(doc, doc.map, { userId })
            if (!r.ok) return stop('score', r.reason)
            await _deps.events.advance(doc._id, 'scored', { scores: r.scores, lastError: null })
            doc = { ...doc, status: 'scored', scores: r.scores }
        }
        if (doc.status === 'scored') {
            const r = await _deps.check(doc, doc.map, doc.scores)
            if (!r.ok) return stop('check', r.reason, Boolean(r.wait))
            await _deps.events.advance(doc._id, 'watching', { check: r.check, lastError: null, waiting: null })
            doc = { ...doc, status: 'watching', check: r.check }
        }
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
