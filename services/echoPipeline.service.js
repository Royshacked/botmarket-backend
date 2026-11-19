// ECHO'S PIPELINE (docs/design/echo-pipeline.md) — one event through the simulator doc's steps, in order, each writing
// its part onto the event (echoEvents):
//
//   framed  → Step 2 map (echoChain)   → mapped
//   mapped  → Step 3 score (echoScore) → scored
//   scored  → Step 4 check (echoCheck) at the day-5 close → checked → watching (Step 5, the wave watch)
//
// `run(event)` goes as far as it can now (a user's event in chat: mapped and scored at once; its check waits for the
// day-5 close). `tick()` moves every open event along — the house's loop (monitoring/echoPipeline.monitor.service.js,
// ECHO_PIPELINE). A step that fails leaves the event where it was, with the reason, for the next tick.

import { echoEventsService } from './echoEvents.service.js'
import { mapEvent } from './echoChain.service.js'
import { scoreEvent } from './echoScore.service.js'
import { checkEvent } from './echoCheck.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoPipeline]'
export const OPEN = Object.freeze(['framed', 'mapped', 'scored'])

const _deps = { events: echoEventsService, map: mapEvent, score: scoreEvent, check: checkEvent }
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

/** Every open event (the house's and the users'), one at a time. → `{ ran: [{ id, ...result }] }`. Never throws. */
export async function tick() {
    let open = []
    try { open = await _deps.events.listOpen() } catch (err) {
        logger.warn(LOG, 'could not list open events', { error: err.message })
        return { ran: [] }
    }
    const ran = []
    for (const ev of open) ran.push({ id: ev._id, ...await run(ev) })
    const moved = ran.filter(r => !r.stoppedAt).length
    if (ran.length) logger.info(LOG, 'tick', { open: ran.length, moved, waiting: ran.filter(r => r.wait).length, failed: ran.filter(r => r.stoppedAt && !r.wait).length })
    return { ran }
}

export const echoPipelineService = { run, tick }
