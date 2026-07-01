/**
 * Invalidation monitor — deterministic entry-range watcher.
 *
 * An idea's invalidation is the actionable entry price RANGE the agent derived
 * from chart structure (idea.invalidation.range = { lower, upper, *Anchor }).
 * The setup is alive only while price stays inside the band; a candle CLOSE
 * outside either edge invalidates it:
 *   - lower edge → the defended structure broke ("wrong")
 *   - upper edge → entry unreachable / R:R gone ("missed/gone")
 *
 * Runs continuously — pre-entry AND in-position — with the SAME flow: fire →
 * notify the user in social chat + deep-link the idea into edit mode. Exits are
 * ALWAYS stop-owned; invalidation only INFORMS, it never executes. In-position
 * a fire is advisory ("structure broke, but the stop still owns the exit").
 *
 * Measurement is a deterministic boolean (price in/out of range) evaluated via
 * the same structured-leaf machinery the entry evaluator uses — no AI in the
 * hot path. A fire-once latch (invalidation_status) stops re-firing until the
 * user acts (edit re-arms it, dismiss clears it).
 *
 * Bot notification payload shape (type: 'invalidation_alert'):
 *   { ideaId, asset, edge, level, anchor, reason, inPosition }
 */

import { evaluateTree }         from './monitor.orchestrator.js'
import { sendBotMessage }       from '../api/chat/chat.service.js'
import { resolveEntryTimeframe } from './monitorUtils.js'
import { logger }               from '../services/logger.service.js'

const LOG = '[invalidation.monitor]'

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
    const tf      = resolveEntryTimeframe(idea)
    const floorAt = inPosition
        ? (idea.entryTriggeredAt ?? idea.savedAt ?? null)
        : (idea.entryFloorAt     ?? idea.savedAt ?? null)

    // One structured (candle-close) leaf per edge. Evaluated individually so the
    // fired edge is known unambiguously for the notification wording.
    const edges = []
    if (range.lower != null) edges.push({ edge: 'lower', leaf: { condition: `closes below ${range.lower}`, type: 'structured', timeframe: tf } })
    if (range.upper != null) edges.push({ edge: 'upper', leaf: { condition: `closes above ${range.upper}`, type: 'structured', timeframe: tf } })

    logger.info(LOG, `[${id}] Checking invalidation range [${range.lower ?? '-'}, ${range.upper ?? '-'}] (${inPosition ? 'in-position' : 'pre-entry'})`)

    for (const { edge, leaf } of edges) {
        let triggered
        try {
            ;({ triggered } = await evaluateTree(leaf, symbolMap, asset, floorAt, [], null))
        } catch (err) {
            logger.warn(LOG, `[${id}] Invalidation eval error on ${edge} edge: ${err.message}`)
            continue
        }
        if (!triggered) continue

        const level  = range[edge]
        const anchor = edge === 'lower' ? range.lowerAnchor : range.upperAnchor
        const reason = _reason(edge, level, anchor, inPosition)

        logger.info(LOG, `[${id}] ⚠️ Invalidation fired (${edge} edge @ ${level}): ${reason}`)

        await db.collection('ideas').updateOne(
            { id },
            { $set: { invalidation_status: 'fired', invalidation_edge: edge, invalidation_reason: reason } },
        )
        await _notify(idea, edge, level, anchor, reason, inPosition)
        return
    }

    logger.info(LOG, `[${id}] Invalidation intact — price inside range`)
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

// --- Bot notification ---------------------------------------------------------

async function _notify(idea, edge, level, anchor, reason, inPosition) {
    if (!idea.userId) return
    const content = `Invalidation on ${idea.asset}: ${reason}`
    await sendBotMessage(idea.userId, content, 'invalidation_alert', {
        ideaId:     idea.id,
        asset:      idea.asset,
        edge,
        level,
        anchor:     anchor ?? null,
        reason,
        inPosition,
    })
}
