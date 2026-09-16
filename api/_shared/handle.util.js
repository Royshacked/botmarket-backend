import { logger } from '../../services/logger.service.js'
import { config } from '../../services/config.js'

/**
 * Wrap an async request handler so a throw is logged WITH the caller's tag and route context,
 * then handed to the one global error handler below — which is the only place a JSON error
 * response is formatted.
 *
 * Grew out of broker.controller, whose twelve handlers each closed with a byte-identical
 * `catch (err) { logger.error(...); res.status(err.status ?? 500).json({ error: err.message }) }`
 * — the global handler re-typed twelve times. paper.controller had the same in a `_fail` helper.
 * The log line is the one part that carried information, so it stays and gains the method + URL
 * (`getPositions GET /api/broker/ctrader/positions`), which names the broker and account without
 * the wrapper knowing what a broker is.
 *
 * An error minted with `httpError(status, message)` (services/httpError.util.js) reaches the client
 * with both; anything else is a 500 — see errorHandler for the rule.
 *
 * NOT for handlers answering a browser NAVIGATION (an OAuth redirect): those must redirect back to
 * the app with a reason, not render `{"error":…}` in the address bar. Keep their own try/catch.
 *
 * NOT for a handler that must act on the failure before answering (pendingAction's execute unwinds
 * a claimed row): that one keeps an inner try/catch for the unwind and RETHROWS, so the wrapper still
 * logs it and the client still gets the one shape.
 *
 * @param {string} log     the controller's log tag, e.g. '[broker:controller]'
 * @returns {(label: string, fn: (req, res) => any) => import('express').RequestHandler}
 */
export function makeHandle(log) {
    return function handle(label, fn) {
        return async (req, res, next) => {
            try {
                await fn(req, res)
            } catch (err) {
                logger.error(log, `${label} ${req.method} ${req.originalUrl}:`, err.message)
                next(err)
            }
        }
    }
}

/**
 * THE global error handler — mounted last in server.js, and the only place a thrown error becomes a
 * JSON body. Every controller reaches it through makeHandle (or Express's own `next(err)`).
 *
 * WHAT AN ERROR MAY TELL THE CLIENT — decided 2026-09-16, the §9 review:
 *
 *   • An error that says so (`err.expose`, minted by `httpError(status, message)`) is answered with
 *     ITS status and ITS sentence. The code that threw it wrote that sentence for the user — a 404
 *     "User not found", a 409 "Username already exists", a 503 "no engine on this host".
 *
 *   • Anything else is a 500. In production the body says only 'Internal server error'; the message
 *     and stack go to the log with the route. In development the message ships, because the
 *     developer is the reader — the same split Express's default handler makes.
 *
 * Why not "any `err.status`": `http.util.getJson` stamps a PROVIDER's status on what it throws, and
 * the cTrader adapter reads that 401 as "reconnect". Without the marker, a Finnhub 429 inside a
 * calendar read would have answered the client 429 "finnhub 429" — a provider's status wearing ours.
 *
 * Why not `err.message` on a 500, as it was: the client shows `data.error` in a toast, so a duplicate
 * username on PATCH /api/users/:id rendered "E11000 duplicate key error collection: test.users index:
 * username_1 dup key: …" to the user — the database name, the collection and the index.
 *
 * body-parser's errors (a malformed JSON body) arrive as `{ status: 400, expose: true }` and are
 * answered like ours. If the headers are already out (a stream that threw after flushing) there is
 * no body left to write; Express's default handler closes the socket.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err)
    const minted = err?.expose === true && Number.isInteger(err.status) && err.status >= 400 && err.status < 600
    const status = minted ? err.status : 500
    if (status >= 500) logger.error('[http]', `${req.method} ${req.originalUrl} → ${status}`, err)
    const message = minted ? (err.message || 'Request failed')
        : (config.isProduction ? 'Internal server error' : (err?.message || 'Internal server error'))
    res.status(status).json({ error: message })
}
