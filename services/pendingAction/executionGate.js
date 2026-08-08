// THE market-hours gate. One question, asked in one place, by every path that is about to send an
// order to a venue: can this run right now, and if not, queue it.
//
// WHY THIS EXISTS. Hours policy was decided independently at five call sites and they disagreed:
//   ideaExecution.placeOrdersForIdea   refuses with { ok:false, reason:'market_closed' }
//   tradeIdeas._attachImmediatePlan    defers the entity to orderState 'awaiting_market'
//   portfolioRebalance._addToItem      fires a market order, no check
//   portfolioRebalance._trimItem       fires a closing order, no check
//   portfolioRebalance._exitItem       fires a closing order, no check
// The last three are why an accepted review at 02:00 could scale into a holding at the PREVIOUS
// DAY'S CLOSE and report success. The paper venue doesn't stop it either: exit pricing degrades to
// the day close on purpose, and entry pricing guards against a MISSING price, which is not the same
// as a shut market — FMP answers 200 with the last close at 2am, so a stale print passes as live.
//
// The rule, decided 2026-08-07: NOTHING executes off-hours, paper included. A real market order
// cannot fill into a closed market, and a simulation that fills anyway is not simulating anything.
//
// The gate does not merely refuse — refusing alone would lose the user's decision. It ENQUEUES,
// so the answer to "what happened to it" is a row in a list rather than an error the user read
// once. Callers do exactly one thing with the result: proceed, or return it.

import { getMarketStatus } from '../market.service.js'
import { logger } from '../logger.service.js'
import { enqueue } from './pendingAction.repo.js'
import { hasOriginHandler, deskForOrigin } from './originRegistry.js'

const LOG = '[executionGate]'

/**
 * Gate one about-to-execute action.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.asset
 * @param {string|null} [p.assetClass]
 * @param {string|null} [p.direction]
 * @param {{ kind: string, entityId: string, ref?: string|null, label?: string|null }} p.origin
 * @param {{ type: string }} p.action    the verb + everything needed to replay it at the open
 * @param {object} [deps]                injectable clock/status/queue for tests
 *
 * @returns {Promise<{ deferred: false } | { deferred: true, ok: true, id, nextOpenMs, deduped? }>}
 *   `deferred:false` — the venue is open, the caller proceeds exactly as before.
 *   `deferred:true`  — the action is queued and the caller must NOT touch the broker.
 *
 * NB the queue write failing still returns `deferred:true`. The market is shut either way, so
 * executing would be wrong; losing the row is a bookkeeping failure, and pretending the order can
 * go through is a trading one.
 */
export async function deferIfClosed({ userId, asset, assetClass = null, direction = null, origin, action, queuedBy = 'user' }, deps = {}) {
    const { status = getMarketStatus, queue = enqueue } = deps

    const { open, nextOpenMs } = status(asset, assetClass)
    if (open) return { deferred: false }

    // An origin with no cancel handler cannot be queued: the item would sit in the list and its
    // desk would never learn if the user dropped it. Fail LOUD to the caller rather than queue
    // something the app can't fully honour — this is what stops a new producer half-shipping.
    if (!hasOriginHandler(origin?.kind)) {
        logger.error(LOG, `refusing to queue an unregistered origin '${origin?.kind}' (${asset}) — see originRegistry`)
        return { deferred: true, ok: false, reason: 'unregistered_origin', nextOpenMs }
    }

    const res = await queue({
        userId, asset, assetClass, direction,
        origin: { ...origin, desk: origin.desk ?? deskForOrigin(origin.kind) },
        action,
        queuedReason: 'market_closed',
        nextOpenMs,
        queuedBy,
    })

    if (!res.ok) {
        logger.error(LOG, `could not queue ${action?.type} on ${asset} — the decision was lost`, res.reason)
        return { deferred: true, ok: false, reason: res.reason ?? 'enqueue_failed', nextOpenMs }
    }
    return { deferred: true, ok: true, id: res.id, nextOpenMs, ...(res.deduped ? { deduped: true } : {}) }
}

export const executionGate = { deferIfClosed }
