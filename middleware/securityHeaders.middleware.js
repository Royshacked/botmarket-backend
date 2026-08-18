// The response security headers.
//
// WRITTEN OUT RATHER THAN `helmet`, and that is a deliberate call rather than an oversight. Helmet
// is a bundle of `res.setHeader` calls plus a default Content-Security-Policy — and that CSP is the
// part that would matter here, because this process also serves the built frontend out of
// `public/`. Turning a strict CSP on blind against a Vite bundle and KLineCharts is how an app
// white-screens in production and nowhere else. Eight explicit headers are auditable in one screen,
// add no dependency, and match the way this file's neighbour already sets `Permissions-Policy`.
//
// CSP IS THEREFORE ABSENT, ON PURPOSE. Adding one is real work — inventory the inline scripts and
// styles the build emits, the blob/data URLs the chart surface uses, and the origins the frontend
// actually fetches — and it belongs in its own change with the app in front of you, not smuggled in
// behind a header sweep.

import { config } from '../services/config.js'

const ONE_YEAR = 60 * 60 * 24 * 365

/**
 * Set the standard hardening headers on every response.
 *
 * `Permissions-Policy: microphone=*` is carried over from server.js unchanged — the browser mic is
 * how voice input reaches /api/transcribe, and dropping it breaks that feature silently.
 */
export function securityHeaders(req, res, next) {
    // Stop the browser second-guessing a declared Content-Type. The one that bites: a JSON error
    // body sniffed as HTML becomes a scripting surface.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Nothing here is meant to be framed, and clickjacking a page whose buttons place broker
    // orders is not a theoretical concern.
    res.setHeader('X-Frame-Options', 'DENY')
    // Keep the path out of the Referer on cross-origin requests — entity ids live in our URLs.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    // Deny a cross-origin opener a handle on our window.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    // Speculative DNS lookups leak where the page is about to go.
    res.setHeader('X-DNS-Prefetch-Control', 'off')
    res.setHeader('Permissions-Policy', 'microphone=*')

    // HSTS only in production. On a dev box this is actively harmful: the browser pins
    // `localhost` to HTTPS for a year, and every plain-HTTP project on that port inherits it.
    if (config.isProduction) {
        res.setHeader('Strict-Transport-Security', `max-age=${ONE_YEAR}; includeSubDomains`)
    }

    next()
}
