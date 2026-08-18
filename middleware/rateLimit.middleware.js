// Rate limiting. THREE limiters, because the three things being protected fail differently.
//
//   apiLimiter    a runaway backstop across /api          — protects the process
//   authLimiter   sign-in / sign-up                       — protects the accounts
//   agentLimiter  the desk streams                        — protects the BILL
//
// The third is the one that matters commercially and is easy to miss: every agent turn buys
// Anthropic tokens, so an unthrottled `/stream` endpoint is an uncapped cost line that any user —
// or any loop left running in a browser tab — can drive. There is no technical failure to notice
// until the invoice arrives.
//
// STORAGE IS IN-MEMORY, which is correct here and will not stay correct. It matches the
// documented single-instance constraint (docs/architecture/single-instance.md): with one process
// the counters are complete. Behind two, each keeps its own and the effective limit doubles. That
// belongs on the same list as everything else in that document, not in a Redis dependency bought
// before it is needed.

import { createHash } from 'crypto'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { config } from '../services/config.js'
import { logger } from '../services/logger.service.js'

const LOG = '[rateLimit]'

/** One JSON error shape for every limiter — the client already handles `{ error }`. */
function _reject(message) {
    return (req, res) => {
        logger.warn(LOG, `${req.method} ${req.originalUrl} limited (${req.ip})`)
        res.status(429).json({ error: message })
    }
}

/**
 * IP key. Goes through `ipKeyGenerator` rather than reading `req.ip`, which matters for IPv6: a
 * single subscriber is handed a whole /64, so keying on the raw address gives one person ~10^19
 * buckets and no limit at all. The helper collapses the prefix.
 */
const _byIp = (req) => ipKeyGenerator(req.ip)

/**
 * Session key, for the surfaces behind `requireAuth`.
 *
 * The session cookie is used here as an OPAQUE STRING and is never trusted as an identity — it is
 * not verified, and nothing downstream reads this value. That is sound for a counter and unsound
 * for anything else, so the distinction is worth stating: a forged cookie buys a fresh bucket, but
 * it also buys a 401 from `requireAuth`, and `apiLimiter` is still counting the IP underneath.
 *
 * Why not `req.user._id`: these limiters mount at the app level in server.js, ahead of the routers
 * that apply `requireAuth`, so `req.user` does not exist yet. Keying on the IP instead would put
 * every user behind one office NAT — or one mobile carrier — into a single shared bucket.
 */
const _bySession = (req) => {
    const token = req.cookies?.token
    if (!token) return _byIp(req)
    // HASHED, not the token itself. The store holds every active key for the whole window, so
    // keying on the raw value would park live session credentials in a long-lived in-memory map
    // for fifteen minutes at a time. A truncated digest is exactly as good a bucket and carries
    // nothing worth stealing.
    return `s:${createHash('sha256').update(token).digest('base64url').slice(0, 22)}`
}

function _make({ windowMs, limit, keyGenerator, message }) {
    return rateLimit({
        windowMs,
        limit,
        keyGenerator,
        standardHeaders: 'draft-7',   // RateLimit / RateLimit-Policy
        legacyHeaders: false,
        // A limiter that turns itself off when nobody is looking is not a limiter. The one case
        // that IS skipped is the disable switch, handled by the no-op below.
        handler: _reject(message),
    })
}

/** A pass-through with the same shape, so server.js mounts the same way either way. */
const _noop = (req, res, next) => next()

if (config.rateLimitDisabled) {
    logger.warn(LOG, 'RATE_LIMIT_DISABLED is set — every limiter is a pass-through')
}

/**
 * The blanket ceiling. Deliberately generous: this is not a quota, it is the thing that stops one
 * misbehaving client saturating the event loop. A normal session sits far below it — the floor
 * alone polls positions and prices — so a user who trips this has a runaway somewhere.
 */
export const apiLimiter = config.rateLimitDisabled ? _noop : _make({
    windowMs: 60_000,
    limit: config.rateLimitApiPerMin,
    keyGenerator: _byIp,
    message: 'Too many requests — slow down and try again shortly.',
})

/**
 * Credential endpoints. IP-keyed on purpose: the attacker being priced out here is trying many
 * accounts from one place, which is precisely the pattern a per-account limit misses.
 */
export const authLimiter = config.rateLimitDisabled ? _noop : _make({
    windowMs: 15 * 60_000,
    limit: config.rateLimitAuthPer15m,
    keyGenerator: _byIp,
    message: 'Too many sign-in attempts. Wait a few minutes and try again.',
})

/**
 * The desk streams. The cost ceiling — see the header. Sized so a working session never notices
 * (a busy hour at one desk is single-digit turns) while a loop hammering `/stream` stops within
 * a minute rather than within a billing period.
 */
export const agentLimiter = config.rateLimitDisabled ? _noop : _make({
    windowMs: 15 * 60_000,
    limit: config.rateLimitAgentPer15m,
    keyGenerator: _bySession,
    message: 'You have run a lot of agent turns in a short window. Give it a few minutes.',
})
