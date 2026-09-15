import { logger } from '../../services/logger.service.js'

/**
 * Wrap an async request handler so a throw is logged WITH the caller's tag and route context,
 * then handed to the one global error handler in server.js — which is the only place a JSON
 * error response is formatted.
 *
 * Grew out of broker.controller, whose twelve handlers each closed with a byte-identical
 * `catch (err) { logger.error(...); res.status(err.status ?? 500).json({ error: err.message }) }`
 * — the global handler re-typed twelve times. paper.controller had the same in a `_fail` helper.
 * The log line is the one part that carried information, so it stays and gains the method + URL
 * (`getPositions GET /api/broker/ctrader/positions`), which names the broker and account without
 * the wrapper knowing what a broker is.
 *
 * Status-carrying errors (`err.status = 404 / 409 / 401`) reach the client as before: the global
 * handler reads `err.status`.
 *
 * NOT for handlers answering a browser NAVIGATION (an OAuth redirect): those must redirect back to
 * the app with a reason, not render `{"error":…}` in the address bar. Keep their own try/catch.
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
