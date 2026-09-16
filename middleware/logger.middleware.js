import { logger } from '../services/logger.service.js'

/**
 * One line per request: `GET /api/threads/unfinished`. Mounted per route by every router.
 *
 * It used to be `async` (for nothing) and wrote a five-line pretty-printed JSON object — baseUrl,
 * method and params, no path — into backend.log for every request, which is most of what that file
 * was. `originalUrl` carries the query string, which a route's own log lines never do.
 */
export function log(req, res, next) {
    logger.info(`${req.method} ${req.originalUrl}`)
    next()
}
