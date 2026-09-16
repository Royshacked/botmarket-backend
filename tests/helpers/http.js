// A minimal Express `res` double and the one way to drive a handler the way the SERVER does.
//
// Several test files each grew their own `fakeRes` — subtly different (statusCode vs code, json vs
// send, some with headersSent, some without), and two hand-rolled the makeHandle → errorHandler
// glue inline. The consequence the §9 CR caught: a test that drives a handler as a bare (req, res)
// asserts what the handler THREW, not what the client receives — and the broker's 424 became a 500
// with no test noticing. `runHandler` closes that gap by construction: it runs the same pipe
// server.js mounts, so what it returns is what the user gets.
//
// Not adopted everywhere on purpose: a test of the error handler itself, or of sendReason, or of
// requireAdmin, answers through its own narrow double and would only be obscured by this one.

import { errorHandler } from '../../api/_shared/handle.util.js'

/** A recording Express response: `statusCode` / `body`, chainable status()/json()/send()/end(). */
export function fakeRes() {
    const res = { statusCode: 200, body: null, headersSent: false, headers: {} }
    res.status = c => { res.statusCode = c; return res }
    res.json   = b => { res.body = b; res.headersSent = true; return res }
    res.send   = b => { res.body = b; res.headersSent = true; return res }
    res.set    = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res }
    res.end    = b => { if (b !== undefined) res.body = b; res.headersSent = true; return res }
    return res
}

/**
 * Run a makeHandle-wrapped handler through the WHOLE request pipe — the handler, then the one global
 * errorHandler on any throw — exactly as an incoming request would. Returns the recording `res`, so
 * an assertion sees the status and body the CLIENT would, not the error the handler threw.
 *
 * @param {Function} handler  a (req, res, next) express handler (typically from makeHandle)
 * @param {object}   req      the request double ({ params, query, body, user, ... })
 * @param {object}   [opts]   { method, url } — what the error handler logs the route as
 */
export async function runHandler(handler, req = {}, { method = 'GET', url = '/api/test' } = {}) {
    const r = { method, originalUrl: url, ...req }
    const res = fakeRes()
    await handler(r, res, err => errorHandler(err, r, res, () => {}))
    return res
}
