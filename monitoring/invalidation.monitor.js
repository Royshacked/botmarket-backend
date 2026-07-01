/**
 * Invalidation monitor — deterministic entry-range watcher with an approach guard.
 *
 * An idea's invalidation is the actionable entry price RANGE the agent derived
 * from chart structure (idea.invalidation.range = { lower, upper, *Anchor }). The
 * setup is alive only while price stays inside the band; a candle CLOSE outside
 * either edge invalidates it:
 *   - lower edge → the defended structure broke ("wrong")
 *   - upper edge → entry unreachable / R:R gone ("missed/gone")
 *
 * DISTANT ENTRIES (approach guard). When the entry sits far from current price
 * (e.g. "buy the false break of 10" while price is at 100), price STARTS outside
 * the envelope on the side it must travel from — so firing the envelope straight
 * away is wrong (the setup hasn't missed, it just hasn't arrived). The watcher is
 * therefore a two-state machine, pre-entry:
 *   - WAITING  — the entry envelope is disarmed. We only flag price running the
 *                WRONG way: a close past the agent's away pivot (`range.approach`,
 *                "ran away, not coming") OR a close clean THROUGH the far side of
 *                the zone without ever setting up ("overshoot"). Either fires a
 *                softer `drifting` status.
 *   - ARMED    — reached the moment any candle CLOSES inside [lower, upper]. From
 *                here the normal envelope owns it and a close outside fires `fired`.
 * Arming is STATE-based, not a rising edge: an idea authored with price already in
 * the zone arms on the first tick, and a dip into the zone between checks still arms.
 *
 * Runs continuously — pre-entry AND in-position. In-position there is no waiting
 * phase (you're past entry): the envelope runs directly as an advisory ("structure
 * broke, but the stop still owns the exit"). Exits are ALWAYS stop-owned;
 * invalidation only INFORMS, it never executes.
 *
 * A fire-once latch (invalidation_status) stops re-firing until the user acts
 * (edit re-arms it, dismiss clears it). `invalidation_armed` latches the waiting→
 * armed transition and is cleared alongside the status on edit/dismiss.
 *
 * Bot notification payload shape (type: 'invalidation_alert'):
 *   { ideaId, asset, status, edge, level, anchor, reason, inPosition }
 */

import { evaluateTree }                     from './monitor.orchestrator.js'
import { sendBotMessage }                   from '../api/chat/chat.service.js'
import { resolveEntryTimeframe, candleMs }  from './monitorUtils.js'
import { logger }                           from '../services/logger.service.js'

const LOG = '[invalidation.monitor]'

const _leaf = (condition, tf) => ({ condition, type: 'structured', timeframe: tf })

/**
 * Check the entry-range invalidation for an idea.
 *
 * @param {object} db          Mongo db handle
 * @param {object} idea        The idea document
 * @param {object} symbolMap   symbol → Candle[] (built by the caller for the entry timeframe)
 * @param {object} [opts]
 * @param {boolean} [opts.inPosition=false]  true when the idea is already long/short
 *
 * Silently skips when:
 *   - the idea is a portfolio holding (governed by the scheduled portfolio review)
 *   - the idea has no invalidation range
 *   - invalidation_status is already set (latched; awaiting user action)
 */
export async function checkInvalidation(db, idea, symbolMap, { inPosition = false } = {}) {
    // Portfolio holdings are governed by the scheduled portfolio review (which
    // re-validates the whole book against its thesis), NOT this intrabar watcher.
    if (idea.portfolioId) return
    const range = idea.invalidation?.range
    if (!range || (range.lower == null && range.upper == null)) return
    if (idea.invalidation_status != null) return   // latched; awaiting user action

    const { id, asset } = idea
    const { lower, upper } = range
    const tf      = resolveEntryTimeframe(idea)
    const floorAt = inPosition
        ? (idea.entryTriggeredAt ?? idea.savedAt ?? null)
        : (idea.entryFloorAt     ?? idea.savedAt ?? null)

    // ── Pre-entry WAITING state (only for a full, two-sided envelope) ────────────
    // Arm the moment price has closed inside the zone since the floor; until then a
    // distant entry only watches the approach corridor. A one-sided range has no
    // zone to arm into, so it falls straight through to the envelope check (legacy
    // behaviour — a single edge).
    const hasFullEnvelope = lower != null && upper != null
    if (!inPosition && hasFullEnvelope && !idea.invalidation_armed) {
        if (closedInZoneSinceFloor(symbolMap[asset], lower, upper, floorAt)) {
            await db.collection('ideas').updateOne({ id }, { $set: { invalidation_armed: true } })
            logger.info(LOG, `[${id}] Invalidation armed — price entered entry zone [${lower}, ${upper}]`)
            return   // the envelope takes over from the next tick
        }
        return _checkApproach(db, idea, symbolMap, { range, tf, floorAt })
    }

    // ── ARMED / in-position: the entry envelope ─────────────────────────────────
    logger.info(LOG, `[${id}] Checking invalidation envelope [${lower ?? '-'}, ${upper ?? '-'}] (${inPosition ? 'in-position' : 'armed'})`)

    // Pre-entry watches BOTH edges (a close above the upper edge means "don't enter —
    // too high / R:R gone"). In-position, only the ADVERSE edge invalidates: for a long
    // a close above the upper edge is favorable (the TP owns that exit), so we alert
    // only on a close below the lower edge — and the upper edge for a short.
    const dir         = idea.direction ?? idea.status
    const adverseEdge = dir === 'short' ? 'upper' : 'lower'
    const edges       = buildEnvelopeEdges(range, tf).filter(e => !inPosition || e.edge === adverseEdge)

    for (const { edge, level, anchor, leaf } of edges) {
        let triggered
        try {
            ;({ triggered } = await evaluateTree(leaf, symbolMap, asset, floorAt, [], null))
        } catch (err) {
            logger.warn(LOG, `[${id}] Invalidation eval error on ${edge} edge: ${err.message}`)
            continue
        }
        if (!triggered) continue

        const reason = _reason(edge, level, anchor, inPosition)
        logger.info(LOG, `[${id}] ⚠️ Invalidation fired (${edge} edge @ ${level}): ${reason}`)

        await db.collection('ideas').updateOne(
            { id },
            { $set: { invalidation_status: 'fired', invalidation_edge: edge, invalidation_reason: reason } },
        )
        await _notify(idea, 'fired', edge, level, anchor, reason, inPosition)
        return
    }

    logger.info(LOG, `[${id}] Invalidation intact — price inside range`)
}

// --- Waiting-state approach guard ---------------------------------------------

/**
 * Pre-entry, before the envelope arms: watch the corridor between current price
 * and the entry zone. Two structured close leaves fire the softer `drifting`
 * status, derived from where the away pivot sits relative to the envelope:
 *   approach >= upper (price coming DOWN into the zone):
 *     ran away  = close above approach   ·  overshoot = close below lower
 *   approach <= lower (price coming UP into the zone):
 *     ran away  = close below approach   ·  overshoot = close above upper
 */
async function _checkApproach(db, idea, symbolMap, { range, tf, floorAt }) {
    const { id, asset } = idea
    const { lower, upper, approach } = range

    const edges = buildApproachEdges(range, tf)
    if (!edges) {
        if (approach == null) logger.info(LOG, `[${id}] Waiting for price to reach entry zone [${lower}, ${upper}] (no approach edge authored)`)
        else                  logger.warn(LOG, `[${id}] Invalidation approach ${approach} sits inside the envelope [${lower}, ${upper}] — ignoring approach watch`)
        return
    }

    logger.info(LOG, `[${id}] Checking approach corridor toward [${lower}, ${upper}] (away @ ${approach})`)

    for (const { edge, level, anchor, leaf } of edges) {
        let triggered
        try {
            ;({ triggered } = await evaluateTree(leaf, symbolMap, asset, floorAt, [], null))
        } catch (err) {
            logger.warn(LOG, `[${id}] Approach eval error on ${edge} edge: ${err.message}`)
            continue
        }
        if (!triggered) continue

        const reason = _driftReason(edge, level, anchor)
        logger.info(LOG, `[${id}] ⚠️ Invalidation drifting (${edge} edge @ ${level}): ${reason}`)

        await db.collection('ideas').updateOne(
            { id },
            { $set: { invalidation_status: 'drifting', invalidation_edge: edge, invalidation_reason: reason } },
        )
        await _notify(idea, 'drifting', edge, level, anchor, reason, false)
        return
    }

    logger.info(LOG, `[${id}] Approach intact — price still en route to the entry zone`)
}

/**
 * True when any candle at/after the floor CLOSED strictly inside (lower, upper).
 * State-based on purpose: unlike a rising-edge leaf this also arms an idea that was
 * authored with price already in the zone (its live candles read inside → armed).
 */
export function closedInZoneSinceFloor(candles, lower, upper, floorAt) {
    if (!Array.isArray(candles) || lower == null || upper == null) return false
    for (const c of candles) {
        if (c?.c == null) continue
        if (floorAt != null && candleMs(c.t) < floorAt) continue
        if (c.c > lower && c.c < upper) return true
    }
    return false
}

/**
 * The armed-envelope edges: a close outside [lower, upper] invalidates. One leaf per
 * present edge (a one-sided range yields a single edge — legacy behaviour).
 */
export function buildEnvelopeEdges(range, tf) {
    const { lower, upper } = range
    const edges = []
    if (lower != null) edges.push({ edge: 'lower', level: lower, anchor: range.lowerAnchor, leaf: _leaf(`closes below ${lower}`, tf) })
    if (upper != null) edges.push({ edge: 'upper', level: upper, anchor: range.upperAnchor, leaf: _leaf(`closes above ${upper}`, tf) })
    return edges
}

/**
 * The waiting-state approach edges, derived from where the away pivot sits relative to
 * the envelope. Returns null when there is nothing to watch: no `approach` authored, or
 * it sits inside the envelope (malformed). Two edges otherwise (ran-away + overshoot):
 *   approach >= upper (price coming DOWN into the zone):
 *     ran away  = close above approach   ·  overshoot = close below lower
 *   approach <= lower (price coming UP into the zone):
 *     ran away  = close below approach   ·  overshoot = close above upper
 */
export function buildApproachEdges(range, tf) {
    const { lower, upper, approach, approachAnchor } = range
    if (approach == null || lower == null || upper == null) return null

    if (approach >= upper) {
        return [
            { edge: 'approach',  level: approach, anchor: approachAnchor,    leaf: _leaf(`closes above ${approach}`, tf) },
            { edge: 'overshoot', level: lower,    anchor: range.lowerAnchor, leaf: _leaf(`closes below ${lower}`,    tf) },
        ]
    }
    if (approach <= lower) {
        return [
            { edge: 'approach',  level: approach, anchor: approachAnchor,    leaf: _leaf(`closes below ${approach}`, tf) },
            { edge: 'overshoot', level: upper,    anchor: range.upperAnchor, leaf: _leaf(`closes above ${upper}`,    tf) },
        ]
    }
    return null   // approach inside the envelope — malformed, nothing to watch
}

// --- Reason wording -----------------------------------------------------------

function _reason(edge, level, anchor, inPosition) {
    const dir = edge === 'lower' ? 'below' : 'above'
    const ref = anchor ? ` (${anchor})` : ''
    if (inPosition) {
        return `Price closed ${dir} ${level}${ref} — the structure the trade relied on broke. The stop still owns the exit; review whether to hold, tighten, or close.`
    }
    return `Price closed ${dir} ${level}${ref} — it left the actionable entry range. The entry setup needs a rethink.`
}

function _driftReason(edge, level, anchor) {
    const ref = anchor ? ` (${anchor})` : ''
    if (edge === 'approach') {
        return `Price closed past ${level}${ref}, running away from the entry — the setup may no longer come to you. Review or let it go.`
    }
    return `Price closed clean through ${level}${ref} without ever setting up — it blew past the entry zone. The setup didn't materialize; rethink.`
}

// --- Bot notification ---------------------------------------------------------

async function _notify(idea, status, edge, level, anchor, reason, inPosition) {
    if (!idea.userId) return
    const content = `Invalidation on ${idea.asset}: ${reason}`
    await sendBotMessage(idea.userId, content, 'invalidation_alert', {
        ideaId:     idea.id,
        asset:      idea.asset,
        status,
        edge,
        level,
        anchor:     anchor ?? null,
        reason,
        inPosition,
    })
}
