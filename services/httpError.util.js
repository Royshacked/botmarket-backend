/**
 * An error that MAY reach the client — status and sentence both.
 *
 * `expose` is the marker the global error handler (api/_shared/handle.util.js → errorHandler) reads:
 * an error WITHOUT it is answered as a 500 with a generic body in production, whatever `status` it
 * happens to carry. The distinction exists because `status` alone is ambiguous — `http.util.getJson`
 * stamps a PROVIDER's status on the errors it throws (a Finnhub 429, a cTrader 401 the adapter reads
 * as "reconnect"), and none of those is an answer to OUR client. Only a status minted here, by the
 * code that wrote the sentence for the user, is. It is the convention `http-errors` and body-parser
 * already use: their 4xx errors arrive with `expose: true` and are answered the same way.
 *
 * Before this, `const err = new Error(msg); err.status = 404; throw err` was written out at 28 sites.
 *
 * @param {number} status   the HTTP status the client should see
 * @param {string} message  the sentence the client should see — written for the user, not the log
 * @param {object} [extra]  further fields to carry on the error (a `reason` slug, a `detail`)
 */
export function httpError(status, message, extra = null) {
    const err = new Error(message)
    err.status = status
    err.expose = true
    if (extra) Object.assign(err, extra)
    return err
}
