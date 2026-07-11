import { logger } from './logger.service.js'
import { normalizeTimeframe } from './timeframe.service.js'
import { normalizeTreeNode, firstLeafTimeframe } from './conditionTree.service.js'
import { cleanConviction } from './conviction.util.js'
import { stripEmitTags } from './agentUtils.js'

const LOG = '[ideaStateParser]'
const MAX_RECENT_MESSAGES = 6

export function _parseResponse(raw, priorState, userPrompt) {
    let text = raw ?? ''
    let tradeIdea = null
    let updatedState = null


    // Strip the UI-emit tags globally (consistent with stripEmitTags used elsewhere) so a
    // tag emitted more than once never survives into the reply.
    text = stripEmitTags(text, ['asset', 'phase']).trim()

    const tradeMatch = text.match(/<trade_idea>([\s\S]*?)<\/trade_idea>/)
    if (tradeMatch) {
        try {
            tradeIdea = JSON.parse(tradeMatch[1].trim())
            // Normalise timeframes in all condition tree nodes
            if (tradeIdea) {
                const entryTf = firstLeafTimeframe(tradeIdea.entry_condition) ?? null
                tradeIdea.entry_condition = normalizeTreeNode(tradeIdea.entry_condition, entryTf)
                tradeIdea.stop_loss       = normalizeTreeNode(tradeIdea.stop_loss,       entryTf)
                tradeIdea.take_profit     = normalizeTreeNode(tradeIdea.take_profit,     entryTf)
            }
        } catch {
            logger.warn(LOG, 'trade_idea parse failed', { raw: tradeMatch[1] })
        }
        text = text.replace(/<trade_idea>[\s\S]*?<\/trade_idea>/, '').trim()
    }

    const stateMatch = text.match(/<state>([\s\S]*?)<\/state>/)
    if (stateMatch) {
        try {
            updatedState = JSON.parse(stateMatch[1].trim())
        } catch (err) {
            logger.warn(LOG, 'state parse failed', { raw: stateMatch[1], err: err.message })
        }
        text = text.replace(/<state>[\s\S]*?<\/state>/, '').trim()
    }

    if (!updatedState || !_isValidState(updatedState)) {
        updatedState = _fallbackState(priorState, userPrompt, text)
    } else {
        // recent_messages is tracked backend-side, not emitted by the LLM — it was
        // pure output-token waste to have the model retype the conversation verbatim
        // every turn. Build it here from prior history + this turn's user/assistant
        // exchange (same logic as _fallbackState).
        updatedState.recent_messages = _buildRecentMessages(priorState, userPrompt, text)
        const pt      = updatedState.structured_state.pending_trade
        const priorPt = priorState?.structured_state?.pending_trade

        logger.info(LOG, 'parsed pending_trade', JSON.stringify({
            entry_timeframe:  pt?.entry_timeframe,
            stop_timeframe:   pt?.stop_timeframe,
            tp_timeframe:     pt?.tp_timeframe,
            entry_cond_count: pt?.entry_conditions?.length,
            first_entry_tf:   pt?.entry_conditions?.[0]?.timeframe,
        }))

        // if the LLM omitted pending_trade entirely, keep the prior values
        if (!pt && priorPt) {
            updatedState.structured_state.pending_trade = priorPt
        } else if (pt) {
            // ── Migrate old flat 'timeframe' field → entry_timeframe ──────────────
            if (pt.timeframe && !pt.entry_timeframe) {
                pt.entry_timeframe = normalizeTimeframe(pt.timeframe)
            }
            delete pt.timeframe   // always remove — never send old field back to LLM

            // Normalise group-level TF fields
            pt.entry_timeframe = normalizeTimeframe(pt.entry_timeframe) || normalizeTimeframe(priorPt?.entry_timeframe) || null
            pt.stop_timeframe  = normalizeTimeframe(pt.stop_timeframe)  || null
            pt.tp_timeframe    = normalizeTimeframe(pt.tp_timeframe)    || null

            // Normalise per-condition timeframe strings (LLM often writes "15m", "4 hours", etc.)
            pt.entry_conditions = _normalizeConditions(pt.entry_conditions)
            pt.stop_conditions  = _normalizeConditions(pt.stop_conditions)
            pt.tp_conditions    = _normalizeConditions(pt.tp_conditions)

            // Best available entry TF: condition-level → group-level → prior group-level → prior condition-level
            const entryTf = pt.entry_conditions[0]?.timeframe
                || pt.entry_timeframe
                || priorPt?.entry_timeframe
                || priorPt?.entry_conditions?.[0]?.timeframe
                || normalizeTimeframe(priorPt?.timeframe)   // migrate prior old-format too
                || null

            // Backfill group-level TF if LLM omitted it
            if (!pt.entry_timeframe) pt.entry_timeframe = entryTf

            // Carry forward per-condition timeframes from prior state if LLM omitted them
            _fillMissingTimeframes(pt.entry_conditions, priorPt?.entry_conditions, entryTf)
            _fillMissingTimeframes(pt.stop_conditions,  priorPt?.stop_conditions,  pt.stop_timeframe  ?? entryTf)
            _fillMissingTimeframes(pt.tp_conditions,    priorPt?.tp_conditions,    pt.tp_timeframe    ?? entryTf)

            // Carry forward logic operators — default AND/OR if LLM omitted them
            pt.entry_logic = pt.entry_logic || priorPt?.entry_logic || 'AND'
            pt.stop_logic  = pt.stop_logic  || priorPt?.stop_logic  || 'OR'
            pt.tp_logic    = pt.tp_logic    || priorPt?.tp_logic    || 'OR'

            // Carry forward quantity
            if (pt.quantity == null && priorPt?.quantity != null) pt.quantity = priorPt.quantity
            if (pt.quantity != null) pt.quantity = Number(pt.quantity) || null

            // Carry forward reward-to-risk — recomputed by the model whenever a level
            // changes, but kept on turns where it re-emits pending_trade without it so
            // the summary-panel R:R doesn't flicker out.
            if (pt.rr == null && priorPt?.rr != null) pt.rr = priorPt.rr
            if (pt.rr != null) pt.rr = Number(pt.rr) || null

            // Carry forward conviction — once the model has judged the setup, keep
            // that assessment on later turns where it re-emits pending_trade without
            // re-stating it (very common). cleanConviction nulls a malformed block;
            // fall back to the prior good one so the chip/rationale don't flicker out.
            pt.conviction = cleanConviction(pt.conviction) || cleanConviction(priorPt?.conviction) || null

            // Normalise additional entries
            if (!Array.isArray(pt.additional_entries)) {
                pt.additional_entries = priorPt?.additional_entries ?? []
            } else {
                pt.additional_entries = pt.additional_entries.map(ae => ({
                    conditions: _normalizeConditions(ae.conditions),
                    logic:      ae.logic ?? 'AND',
                    quantity:   ae.quantity != null ? Number(ae.quantity) || null : null,
                }))
            }
        }
    }

    return { reply: text, updatedState, tradeIdea }
}

function _isValidState(state) {
    return (
        state &&
        typeof state === 'object' &&
        typeof state.recent_chat_summary === 'string' &&
        state.structured_state &&
        typeof state.structured_state === 'object'
    )
}

// Build the rolling chat history backend-side from prior history + this turn's
// exchange. The LLM no longer emits recent_messages (saves premium output tokens).
export function _buildRecentMessages(priorState, userPrompt, replyText) {
    return _trimMessages([
        ...(priorState?.recent_messages ?? []),
        ...(userPrompt?.trim() ? [{ role: 'user', content: userPrompt.trim() }] : []),
        ...(replyText?.trim() ? [{ role: 'assistant', content: replyText.trim() }] : []),
    ])
}

function _fallbackState(priorState, userPrompt, replyText) {
    const prior = priorState && typeof priorState === 'object' ? priorState : emptyAnalysisState()
    const recent_messages = _buildRecentMessages(prior, userPrompt, replyText)
    return {
        recent_messages,
        recent_chat_summary: prior.recent_chat_summary ?? '',
        // preserve the full prior structured_state — never wipe trade params on fallback
        structured_state: prior.structured_state ?? emptyAnalysisState().structured_state,
    }
}

function _trimMessages(messages) {
    if (!Array.isArray(messages)) return []
    return messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content.trim() }))
        .slice(-MAX_RECENT_MESSAGES)
}

// ─── Condition normalisation ──────────────────────────────────────────────────

function _normalizeConditions(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map(c => {
        if (typeof c === 'string') return { condition: c, type: 'structured', timeframe: null }
        return { ...c, timeframe: normalizeTimeframe(c.timeframe) }
    })
}

/**
 * For each condition that is missing a timeframe, try to fill it from:
 * 1. The matching prior-state condition at the same index
 * 2. The defaultTf (entry TF) as the final fallback
 */
function _fillMissingTimeframes(conditions, priorConditions, defaultTf) {
    if (!Array.isArray(conditions)) return
    conditions.forEach((c, i) => {
        if (!c.timeframe) {
            c.timeframe = priorConditions?.[i]?.timeframe || defaultTf || null
        }
    })
}

export function emptyAnalysisState() {
    return {
        recent_messages: [],
        recent_chat_summary: '',
        structured_state: {
            active_asset: '',
            pending_trade: {
                direction: null,
                type:      null,
                asset_class: null,   // 'stock'|'etf'|'futures'|'forex'|'crypto' — set by the LLM from context
                quantity:  null,
                entry_timeframe: null,  // set as soon as user mentions a TF, even before conditions
                stop_timeframe: null,   // null = inherit entry_timeframe
                tp_timeframe: null,     // null = inherit entry_timeframe
                entry_logic: 'AND',
                entry_conditions: [],       // [{ condition, type, timeframe }]
                stop_logic: 'OR',
                stop_conditions: [],        // [{ condition, type, timeframe }]
                tp_logic: 'OR',
                tp_conditions: [],          // [{ condition, type, timeframe }]
                additional_entries: [],     // [{ conditions, logic, quantity }]
                notes: null,
                rr: null,                   // reward-to-risk ratio (number, e.g. 1.5); null until entry+stop+target levels exist
            },
        },
    }
}
