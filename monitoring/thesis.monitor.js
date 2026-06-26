/**
 * Thesis stress trigger monitor.
 *
 * Runs in parallel with entry condition evaluation for every 'looking' idea.
 * Converts plain-English stress trigger strings into structured leaves, evaluates
 * them against the same candle data the entry evaluator uses, and when one fires
 * asks the AI whether the original thesis is still intact, weakening, or broken.
 *
 * Bot notification payload shape (type: 'thesis_alert'):
 *   { ideaId, asset, thesis_status, reason, firedTrigger }
 */

import { evaluateTree }   from './monitor.orchestrator.js'
import { claudeJSON }     from './monitor.claude.js'
import { sendBotMessage } from '../api/chat/chat.service.js'
import { firstLeaf }      from '../services/conditionTree.service.js'
import { logger }         from '../services/logger.service.js'

const LOG = '[thesis.monitor]'

const EVAL_SYSTEM = `You evaluate whether a trade thesis is still valid given a price stress event.

Input JSON fields:
- asset: the traded asset
- thesis_reasoning: the original entry thesis
- key_assumptions: list of assumptions that must hold for the thesis
- stress_trigger_fired: the price condition that just triggered

Return ONLY valid JSON, no other text:
{
  "thesis_status": "holding" | "weakening" | "invalidated",
  "reason": "one concise sentence explaining the assessment"
}`

/**
 * Check entry thesis stress triggers for a 'looking' idea.
 * Silently skips when:
 *   - the idea has no entry thesis stress triggers
 *   - thesis_status is already set (user must act before monitoring re-evaluates)
 */
export async function checkThesis(db, idea, symbolMap) {
    const triggers = idea.thesis?.entry?.stress_triggers
    if (!Array.isArray(triggers) || triggers.length === 0) return
    if (idea.thesis_status != null) return   // already assessed; awaiting user action

    const { id, asset } = idea
    const tf      = _entryTf(idea)
    const floorAt = idea.entryFloorAt ?? idea.savedAt ?? null

    // Wrap each plain-English trigger string as a structured leaf, then OR them.
    // Any single trigger firing is enough to prompt a thesis re-evaluation.
    const children = triggers.map(t => ({ condition: t, type: 'structured', timeframe: tf }))
    const tree     = children.length === 1 ? children[0] : { operator: 'OR', children }

    logger.info(LOG, `[${id}] Checking ${triggers.length} thesis stress trigger(s)`)

    let triggered, which
    try {
        ;({ triggered, which } = await evaluateTree(tree, symbolMap, asset, floorAt, [], null))
    } catch (err) {
        logger.warn(LOG, `[${id}] Stress trigger eval error: ${err.message}`)
        return
    }

    if (!triggered) {
        logger.info(LOG, `[${id}] Thesis intact -- no stress triggers fired`)
        return
    }

    logger.info(LOG, `[${id}] Stress trigger fired: "${which}"`)

    const { thesis_status, reason } = await _aiEval(idea, which)
    logger.info(LOG, `[${id}] Thesis -> ${thesis_status}: ${reason}`)

    await db.collection('ideas').updateOne({ id }, { $set: { thesis_status, thesis_status_reason: reason } })

    if (thesis_status !== 'holding') {
        await _notify(idea, thesis_status, reason, which)
    }
}

// --- AI thesis re-evaluation --------------------------------------------------

async function _aiEval(idea, firedTrigger) {
    const entry = idea.thesis?.entry ?? {}
    try {
        const result = await claudeJSON(EVAL_SYSTEM, JSON.stringify({
            asset:                idea.asset,
            thesis_reasoning:     entry.reasoning       ?? '',
            key_assumptions:      entry.key_assumptions ?? [],
            stress_trigger_fired: firedTrigger,
        }))
        const VALID = ['holding', 'weakening', 'invalidated']
        const status = VALID.includes(result.thesis_status) ? result.thesis_status : 'weakening'
        return { thesis_status: status, reason: String(result.reason ?? '') }
    } catch (err) {
        logger.warn(LOG, `AI thesis eval failed for idea ${idea.id}: ${err.message}`)
        return { thesis_status: 'weakening', reason: `Stress trigger fired: "${firedTrigger}"` }
    }
}

// --- Bot notification ---------------------------------------------------------

async function _notify(idea, thesis_status, reason, firedTrigger) {
    if (!idea.userId) return
    const label   = thesis_status === 'invalidated' ? 'Thesis invalidated' : 'Thesis weakening'
    const content = `${label} on ${idea.asset}: ${reason}`
    await sendBotMessage(idea.userId, content, 'thesis_alert', {
        ideaId: idea.id,
        asset:  idea.asset,
        thesis_status,
        reason,
        firedTrigger,
    })
}

// --- Helpers ------------------------------------------------------------------

function _entryTf(idea) {
    const tree = idea.entry_condition_tree
    if (tree) {
        const leaf = firstLeaf(tree)
        if (leaf?.timeframe) return leaf.timeframe
    }
    return idea.entry_conditions?.[0]?.timeframe
        ?? idea.entry_timeframe
        ?? idea.timeframe
        ?? 'day'
}
