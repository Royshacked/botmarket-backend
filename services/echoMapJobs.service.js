// The event analyst's map, in the BACKGROUND (docs/design/modes-and-builders.md step 2, M16). `map_event` ran the whole
// pipeline inside the tool call — two to three minutes in which Axl's turn, and with it the chat, waited. Now the tool
// starts it here and returns at once:
//
//   the chat's status line says "the event analyst is mapping …" (session.waiting) → the pipeline runs → the line goes
//   → the event analyst gets ONE turn (an opening, hidden) to tell the user what the map found, under its own role.
//
// No session (a caller outside the chat) → the caller runs the pipeline itself, as before. In-process, like the
// research run: a restart cuts a map off, and the boot sweep (below) picks it up again from the session's status line.
// Built as a factory so the tests run it with stubs.

import { sessionService } from './session.service.js'
import { echoPipelineService } from './echoPipeline.service.js'
import { echoEventsService } from './echoEvents.service.js'
import { logger } from './logger.service.js'

const LOG = '[echoMapJobs]'
const KEY = 'echo|'
// Another run holding the event (the hourly pipeline claimed it first): wait for IT to finish, so the announcement never
// describes a half-built map (CR 2026-11-20). Its claim lasts 15 minutes.
const POLL_MS = 15_000
const MAX_WAIT_MS = 16 * 60_000
const UNFINISHED = new Set(['framed', 'mapped'])

/** The line said when a map a restart cut off cannot be read back. Pure; exported for tests. */
export function interruptedLine(label) {
    return `The map of ${label ?? 'the event'} was cut off by a restart and could not be picked up again — ask me to map it again.`
}

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

export function makeEchoMapJobs({ sessions = sessionService, pipeline = echoPipelineService, events = echoEventsService, runTurn = defaultRunTurn,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)), pollMs = POLL_MS, maxWaitMs = MAX_WAIT_MS } = {}) {

    /** The event once the run that holds it is done — `{ status }`, or the reason it stopped. */
    async function settledElsewhere(id, userId) {
        for (let waited = 0; waited < maxWaitMs; waited += pollMs) {
            await sleep(pollMs)
            const d = await events.get(id, userId).catch(() => null)
            if (!d) return { failed: 'the event could not be read back' }
            if (!UNFINISHED.has(d.status)) return { status: d.status }
            if (d.gaveUp || (d.lastError && !d.runningUntil)) return { status: d.status, stoppedAt: d.lastError?.step ?? 'map', reason: d.lastError?.reason ?? 'it gave up' }
        }
        return { failed: 'it is taking longer than usual' }
    }

    // eventId → { done, asked: [{ userId, sessionId }] } — one run per event; every chat that asked for it while it maps
    // gets its own line and its own announcement (CR 2026-11-20: a second ask was promised a map that never came).
    const running = new Map()

    const lineFor = ({ userId, sessionId, doc, label }) => sessions.setWaiting({ sessionId, userId, key: `${KEY}${doc._id}`,
        entry: { kind: 'echo_map', text: mappingLine(label), eventId: doc._id, label, since: Date.now() } })
        .catch(err => logger.warn(LOG, 'mapping line not set', err.message))

    /**
     * Start mapping `doc` for the user's session — or join the run already mapping it. Returns at once with
     * `{ started }` (false: joined); `done` is the settle (tests await it).
     * @param {{ userId: string, sessionId: string, doc: { _id: string }, label: string }} p
     */
    function start({ userId, sessionId, doc, label }) {
        const job = running.get(doc._id)
        if (job) {
            if (!job.asked.some(a => a.sessionId === sessionId)) {
                job.asked.push({ userId, sessionId })
                lineFor({ userId, sessionId, doc, label })
            }
            return { started: false, done: job.done }
        }
        const asked = [{ userId, sessionId }]
        const done = (async () => {
            await lineFor({ userId, sessionId, doc, label })
            let r
            try {
                r = await pipeline.run(doc)
                if (r?.stoppedAt === 'claim') r = await settledElsewhere(doc._id, userId)
            } catch (err) {
                logger.warn(LOG, 'map failed', { event: doc._id, message: err.message })
                r = { failed: err.message }
            }
            running.delete(doc._id)   // a later ask maps afresh (or reads the finished map)
            for (const a of asked) {
                await sessions.setWaiting({ sessionId: a.sessionId, userId: a.userId, key: `${KEY}${doc._id}`, entry: null }).catch(() => {})
                await runTurn({
                    user: { _id: a.userId, role: 'user' }, sessionId: a.sessionId, agent: 'echo', origin: 'background',
                    text: doneOpening(doc._id, r), input: {}, turnId: `echo_map_${doc._id}_${Date.now()}`,
                }).catch(err => logger.warn(LOG, 'announcement failed', { session: a.sessionId, message: err.message }))
            }
            logger.info(LOG, 'map settled', { event: doc._id, status: r?.status ?? null, failed: r?.failed ?? null, chats: asked.length })
            return r
        })().catch(err => logger.warn(LOG, 'settle failed', err.message)).finally(() => running.delete(doc._id))
        running.set(doc._id, { done, asked })
        return { started: true, done }
    }

    /**
     * At boot (CR 2026-11-20): a map a restart cut off left its line up and nobody to finish it — the hourly pipeline is
     * opt-in. Each one is picked up again: the dead run's claim released (one instance — nothing else is running it,
     * docs/architecture/single-instance.md) and the map restarted, line and announcement as before. A map that finished
     * just before the restart is announced; one that cannot be read back is said to have been cut off.
     * @returns {Promise<number>} the maps picked up
     */
    async function sweep() {
        const list = await sessions.findWaiting().catch(err => { logger.warn(LOG, 'sweep could not list sessions', err.message); return [] })
        let n = 0
        for (const s of list) {
            for (const [key, w] of Object.entries(s.waiting ?? {})) {
                if (w?.kind !== 'echo_map') continue
                n++
                const { sessionId, userId } = s
                const doc = w.eventId ? await events.get(w.eventId, userId).catch(() => null) : null
                if (doc && UNFINISHED.has(doc.status) && !doc.gaveUp) {
                    await events.advance(doc._id, doc.status, {}).catch(() => {})   // releases the dead run's claim
                    start({ userId, sessionId, doc, label: w.label ?? 'the event' })
                    continue
                }
                await sessions.setWaiting({ sessionId, userId, key, entry: null }).catch(() => {})
                if (doc) {
                    await runTurn({ user: { _id: userId, role: 'user' }, sessionId, agent: 'echo', origin: 'background',
                        text: doneOpening(doc._id, { status: doc.status }), input: {}, turnId: `echo_map_${doc._id}_${Date.now()}` }).catch(() => {})
                } else {
                    await sessions.append({ sessionId, userId, message: { agent: 'echo', role: 'assistant', content: interruptedLine(w.label), ref: { via: 'axl' } } }).catch(() => {})
                }
            }
        }
        if (n) logger.info(LOG, 'picked up maps a restart cut off', { n })
        return n
    }

    return { start, sweep }
}

export const echoMapJobs = makeEchoMapJobs()
