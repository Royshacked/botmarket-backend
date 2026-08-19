// Shared Server-Sent-Events boilerplate for every streaming endpoint — the six desks
// (axl / mentor / portfolio / scanner / analyst / strategy) plus Axl's market brief. Sets the SSE
// headers, disables proxy buffering, and starts a keep-alive heartbeat.
//
// Named generically on purpose: agentLimiterCoverage guards that every mounted `/stream` route is
// rate-limited, and nothing here needs to know which desks exist. The old list named `kairos` and
// an `orchestrator` that predates the desks, which is what a hand-kept roster does.
//
// STOP AND WALKING AWAY ARE DIFFERENT THINGS, and this file used to treat them as one: it aborted the
// model call on `res.close`, which both gestures cause. So leaving a desk mid-answer killed the turn and
// threw away work the user had already paid for — the reason a conversation could not be left running.
//
// Now: closing the connection means only "nobody is watching". The turn runs to completion and persists
// itself, and the user finds it waiting when they return. Aborting takes an explicit say-so, routed
// through the turn registry by id. Which also makes `signal.aborted` mean what every caller already
// assumed it meant — the user stopped this — rather than "the socket went away".
//
// Listen on res, not req — req's 'close' fires as soon as the request body is
// fully received (Node ≥ ~18), which would abort every stream instantly. res
// 'close' fires only when the response connection actually closes.

import { logger } from '../../services/logger.service.js'
import { registerTurn } from './turnRegistry.js'

const HEARTBEAT_MS = 30000

export function startSseStream(req, res, { turnId = null, userId = null } = {}) {
    res.setHeader('Content-Type',       'text/event-stream')
    res.setHeader('Cache-Control',      'no-cache')
    res.setHeader('Connection',         'keep-alive')
    res.setHeader('X-Accel-Buffering',  'no') // disable Render/nginx proxy buffering
    res.flushHeaders()

    const ac = new AbortController()
    let finished   = false
    // The client has gone, but the WORK has not. Writes become no-ops rather than errors on a dead
    // socket, and the handler carries on to its own completion and persistence.
    let clientGone = false

    function sendEvent(event, data) {
        if (clientGone) return
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // keep-alive ping so an idle proxy (Render/nginx) doesn't cut the connection
    const heartbeat = setInterval(() => { if (!clientGone) res.write(': ping\n\n') }, HEARTBEAT_MS)

    // Stoppable by id for as long as it runs. Released in finish(), however the turn ends.
    const release = registerTurn(turnId, ac, userId)

    res.on('close', () => {
        clearInterval(heartbeat)
        // Deliberately NOT ac.abort(): a closed socket means the user navigated away, and the turn
        // they started is still worth finishing. Only an explicit stop aborts.
        clientGone = true
    })

    // Stop the heartbeat once the work is done, and let go of the turn id.
    function finish() {
        finished = true
        clearInterval(heartbeat)
        release()
    }

    return {
        sendEvent, signal: ac.signal, finish,
        get finished()   { return finished },
        // For a handler that wants to know nobody is watching — to skip a chart render, say. It must
        // NOT be used to skip persistence: saving the turn is the entire point of finishing it.
        get clientGone() { return clientGone },
    }
}

/**
 * The callback bag every streaming desk hands its `chatStream`, minus the per-desk extras.
 *
 * These four were written out verbatim in all seven controllers — `onReasoning` alone appeared
 * character-for-character seven times. That is fine until a payload gains a field, at which point
 * it is seven edits and six chances to forget one; the failure is silent, because a desk that
 * still sends the old shape just renders slightly wrong. Adding a field is now one line, here.
 *
 * `source` on reasoning is WHOSE thinking it is — the desk's own model, or the reasoning sidecar it
 * consulted (services/agentIO.js: REASONING_DESK / REASONING_CONSULT). Undefined for any caller
 * that doesn't tag, and the client defaults it to the desk, so nothing has to change in step.
 *
 * Spread it, then add what only that desk has:
 *   ...sseAgentCallbacks(sendEvent),
 *   onCoverage: (coverage) => sendEvent('coverage', { coverage }),
 *
 * @param {function} sendEvent  from startSseStream / streamAgentResponse
 */
export function sseAgentCallbacks(sendEvent) {
    return {
        onToken:     (text)         => sendEvent('token',     { text }),
        onToolStart: (tool)         => sendEvent('status',    { tool }),
        onReasoning: (text, source) => sendEvent('reasoning', { text, source }),
        onChart:     (chart)        => sendEvent('chart',     chart),
    }
}

// Run a streaming agent turn with the standard SSE lifecycle every agent controller
// shares: open the stream, run the handler, and on success `finish()` + emit a `done`
// (skipped if the client already aborted); on error, `finish()` + emit an `error`
// (or stay silent if the client is gone). The controller supplies only `handler`,
// which receives { sendEvent, signal } — it reads the model off the body and calls chatStream
// (wiring token/tool/reasoning events via sendEvent) and RETURNS the `done` payload.
// Post-stream side effects belong inside the handler. Gate them on `!signal.aborted` — which now means
// "the user did not stop this" and NOT "the client is still connected", so a turn the user walked away
// from still saves itself.
//
// Body validation that may 4xx must happen in the controller BEFORE calling this — once
// the SSE headers are flushed we can't send a normal status code.
export async function streamAgentResponse(req, res, { log, handler }) {
    // The client mints the id and sends it with the turn, so Stop has something to name. A request
    // without one still streams; it just cannot be stopped remotely.
    const { sendEvent, signal, finish } = startSseStream(req, res, {
        turnId: typeof req.body?.turnId === 'string' ? req.body.turnId : null,
        userId: req.user?._id ?? null,
    })
    try {
        const donePayload = await handler({ sendEvent, signal })
        finish()
        if (!signal.aborted) {
            sendEvent('done', donePayload ?? {})
            res.end()
        }
    } catch (err) {
        finish()
        if (signal.aborted) return   // the user stopped it — the error is not news
        logger.error(log, 'stream failed', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
}
