// The event analyst's map, in the BACKGROUND (docs/design/modes-and-builders.md step 2, M16). `map_event` ran the whole
// pipeline inside the tool call — two to three minutes in which Axl's turn, and with it the chat, waited. Now the tool
// starts it here and returns at once:
//
//   the chat's status line says "the event analyst is mapping …" (session.waiting) → the pipeline runs → the line goes
//   → the event analyst gets ONE turn (an opening, hidden) to tell the user what the map found, under its own role.
//
// No session (a caller outside the chat) → the caller runs the pipeline itself, as before. In-process, like the
// research run: a restart loses the announcement, not the event — the pipeline's claim lets its hourly run finish it.
// Built as a factory so the tests run it with stubs.

import { sessionService } from './session.service.js'
import { echoPipelineService } from './echoPipeline.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoMapJobs]'

/** The status line while it maps. Pure; exported for tests. */
export function mappingLine(label) {
    return `The event analyst is mapping ${label} through the supply chain — two to three minutes. The chat is free meanwhile; the map comes here when it is done.`
}

/** The event analyst's opening once it is done — the app's words, never the user's. Pure; exported for tests. */
export function doneOpening(eventId, r) {
    const stopped = r?.failed ? ` It stopped: ${r.failed}.` : r?.stoppedAt && !r.wait ? ` It stopped at ${r.stoppedAt}: ${r.reason}.` : ''
    return `[App note, not the user's words: the map of event ${eventId} that you started is done.${stopped} ` +
        'Read it with get_event_map and tell the user what it found — the punchline first, as you would have when mapping it.]'
}

// The turn path, imported when a map settles: turns.js → … → echo.tools → here would otherwise be a cycle.
const defaultRunTurn = async (args) => (await import('./desks/turns.js')).runQueued(args)

export function makeEchoMapJobs({ sessions = sessionService, pipeline = echoPipelineService, runTurn = defaultRunTurn } = {}) {
    const running = new Map()   // eventId → promise, so a second ask of the same event does not run it twice

    /**
     * Start mapping `doc` for the user's session. Resolves at once with `{ started }`; `done` is the settle (tests await it).
     * @param {{ userId: string, sessionId: string, doc: { _id: string }, label: string }} p
     */
    function start({ userId, sessionId, doc, label }) {
        if (running.has(doc._id)) return { started: false, done: running.get(doc._id) }
        const key = `echo|${doc._id}`
        const done = (async () => {
            await sessions.setWaiting({ sessionId, userId, key, entry: { kind: 'echo_map', text: mappingLine(label), since: Date.now() } })
                .catch(err => logger.warn(LOG, 'mapping line not set', err.message))
            let r
            try {
                r = await pipeline.run(doc)
            } catch (err) {
                logger.warn(LOG, 'map failed', { event: doc._id, message: err.message })
                r = { failed: err.message }
            }
            await sessions.setWaiting({ sessionId, userId, key, entry: null }).catch(() => {})
            await runTurn({
                user: { _id: userId, role: 'user' }, sessionId, agent: 'echo', origin: 'opening',
                text: doneOpening(doc._id, r), input: {}, turnId: `echo_map_${doc._id}_${Date.now()}`,
            })
            logger.info(LOG, 'map settled', { event: doc._id, status: r?.status ?? null, failed: r?.failed ?? null })
            return r
        })().catch(err => logger.warn(LOG, 'settle failed', err.message)).finally(() => running.delete(doc._id))
        running.set(doc._id, done)
        return { started: true, done }
    }

    return { start }
}

export const echoMapJobs = makeEchoMapJobs()
