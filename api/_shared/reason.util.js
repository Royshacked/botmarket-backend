// ONE reason → HTTP answer, for every kind.
//
// Services report refusals as a terse `reason` slug ({ ok:false, reason:'in_position' }). This is
// the only place that decides what a slug MEANS over HTTP, so two kinds cannot answer the same
// refusal differently — which is exactly what had happened: deleting an entity that holds a live
// broker position was 409 on the idea route and 400 on the setup route, and 'already_closed'
// (409, ideas) and 'closed_is_terminal' (400, setups) were the same refusal spelled twice.
//
// Same split as makeEntityCrud: the MECHANISM lives here, the JUDGMENT stays with the kind. A
// reason belongs in this table only when more than one kind can raise it. Anything a single route
// owns — the setup Generate gate, manual-mode fills, resting-order activation — is passed in as an
// `overrides` argument and stays with that route.

/**
 * Cross-kind reasons: [status, message].
 *
 * The 4xx split: 403/404 are about REACHING the entity; 409 means "well-formed request, the
 * entity's STATE refuses it" (retry after changing that state); 400 means the request itself is
 * wrong.
 */
const SHARED = {
    not_found: [404, 'Not found'],
    forbidden: [403, 'Forbidden'],

    // Conflicts — the entity's state says no.
    in_position:        [409, 'Live on the broker — close the position first'],
    already_placed:     [409, 'Orders already placed'],
    already_closed:     [409, 'Already closed'],
    closed_is_terminal: [409, 'Closed is terminal — it cannot be reopened'],
    // Shared because placement is kind-blind: an idea, a portfolio item and a setup all confirm
    // through placeOrdersForIdea, so all three can hit a shut market. 409 rather than 400 — the
    // request is perfectly well formed, it is the venue's state that refuses, and it becomes valid
    // again at the open with no change from the caller.
    market_closed:      [409, 'Market is closed — this order can be placed when it reopens'],

    // Malformed or inapplicable requests.
    invalid_status:   [400, 'Invalid status value'],
    nothing_to_patch: [400, 'Nothing to update'],
}

/**
 * Resolve a reason to [status, message]. Overrides WIN over the shared table, so a route can
 * always narrow the wording for its own kind — but if it wants a different STATUS for a shared
 * reason, that is a disagreement between kinds and belongs in SHARED, not in one caller.
 *
 * @param {string} reason
 * @param {Object<string,[number,string]>|Function|null} [overrides] a table, or a matcher
 *   `(reason) => [status, message] | null` for prefix families (`missing_*`, `cannot_arm_*`).
 * @returns {[number,string]|null} null when nothing claims the reason.
 */
function resolve(reason, overrides = null) {
    if (typeof overrides === 'function') {
        const hit = overrides(reason)
        if (hit) return hit
    } else if (overrides && Object.prototype.hasOwnProperty.call(overrides, reason)) {
        return overrides[reason]
    }
    return SHARED[reason] ?? null
}

/**
 * Map a reason to an HTTP status. Unknown reasons take `fallback` — 400 where a malformed request
 * is the likelier cause, 500 where reaching that line at all means the service broke.
 */
export function reasonToStatus(reason, fallback = 400, overrides = null) {
    return resolve(reason, overrides)?.[0] ?? fallback
}

/**
 * Answer a failed `{ ok:false, reason }` result.
 *
 * The body is ALWAYS `{ error, reason }`: `error` is human, `reason` is the slug a client can
 * branch on. Both are sent even when the message is a fallback, so a client never has to parse
 * prose to tell one refusal from another.
 *
 * @param {import('express').Response} res
 * @param {string} reason
 * @param {Object} [opts]
 * @param {number} [opts.fallback]         status for a reason nothing claims
 * @param {string} [opts.fallbackMessage]  message for that case (defaults to the slug itself)
 * @param {Object|Function} [opts.overrides] route-owned reasons (see resolve)
 * @param {Object} [opts.extra]            extra body fields (e.g. broker `results` on a 502)
 */
export function sendReason(res, reason, { fallback = 400, fallbackMessage = null, overrides = null, extra = null } = {}) {
    const hit = resolve(reason, overrides)
    const [status, message] = hit ?? [fallback, fallbackMessage ?? reason ?? 'request_failed']
    return res.status(status).send({ error: message, ...(reason ? { reason } : {}), ...(extra ?? {}) })
}

/** The shared table, for tests and for callers that need a message without answering. */
export { SHARED as SHARED_REASONS }
