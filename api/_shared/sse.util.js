// Shared Server-Sent-Events boilerplate for the streaming endpoints
// (orchestrator / portfolio / scanner / news-feed). Sets the SSE headers,
// disables proxy buffering, starts a keep-alive heartbeat, and wires an
// AbortController to the response close so a client disconnect (Stop / navigate
// away) aborts the work instead of letting it finish silently.
//
// Listen on res, not req — req's 'close' fires as soon as the request body is
// fully received (Node ≥ ~18), which would abort every stream instantly. res
// 'close' fires only when the response connection actually closes.

import { logger } from '../../services/logger.service.js'

const HEARTBEAT_MS = 30000

export function startSseStream(req, res) {
    res.setHeader('Content-Type',       'text/event-stream')
    res.setHeader('Cache-Control',      'no-cache')
    res.setHeader('Connection',         'keep-alive')
    res.setHeader('X-Accel-Buffering',  'no') // disable Render/nginx proxy buffering
    res.flushHeaders()

    function sendEvent(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const ac = new AbortController()
    let finished = false

    // keep-alive ping so an idle proxy (Render/nginx) doesn't cut the connection
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)

    res.on('close', () => {
        clearInterval(heartbeat)
        if (!finished) ac.abort()
    })

    // Mark the stream finished so a normal close after completion doesn't abort,
    // and stop the heartbeat once the work is done.
    function finish() {
        finished = true
        clearInterval(heartbeat)
    }

    return { sendEvent, signal: ac.signal, finish, get finished() { return finished } }
}

// Run a streaming agent turn with the standard SSE lifecycle every agent controller
// shares: open the stream, run the handler, and on success `finish()` + emit a `done`
// (skipped if the client already aborted); on error, `finish()` + emit an `error`
// (or stay silent if the client is gone). The controller supplies only `handler`,
// which receives { sendEvent, signal } — it does its own resolveModel + chatStream
// (wiring token/tool/reasoning events via sendEvent) and RETURNS the `done` payload.
// Any post-stream side effects belong inside the handler (gate them on !signal.aborted
// to match the "only when the client is still listening" rule).
//
// Body validation that may 4xx must happen in the controller BEFORE calling this — once
// the SSE headers are flushed we can't send a normal status code.
export async function streamAgentResponse(req, res, { log, handler }) {
    const { sendEvent, signal, finish } = startSseStream(req, res)
    try {
        const donePayload = await handler({ sendEvent, signal })
        finish()
        if (!signal.aborted) {
            sendEvent('done', donePayload ?? {})
            res.end()
        }
    } catch (err) {
        finish()
        if (signal.aborted) return   // client gone — nothing to send
        logger.error(log, 'stream failed', err)
        sendEvent('error', { message: 'Streaming failed' })
        res.end()
    }
}
