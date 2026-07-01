// Shared Server-Sent-Events boilerplate for the streaming endpoints
// (orchestrator / portfolio / scanner / news-feed). Sets the SSE headers,
// disables proxy buffering, starts a keep-alive heartbeat, and wires an
// AbortController to the response close so a client disconnect (Stop / navigate
// away) aborts the work instead of letting it finish silently.
//
// Listen on res, not req — req's 'close' fires as soon as the request body is
// fully received (Node ≥ ~18), which would abort every stream instantly. res
// 'close' fires only when the response connection actually closes.

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
