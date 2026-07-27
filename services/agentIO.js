import { logger } from './logger.service.js'
import { resolveAgentStream } from './agentUtils.js'

// The agent I/O protocol — the mechanics every streaming agent repeats verbatim.
//
// Each agent talks to the model the same way: open a stream, suppress its emit tags, capture the
// live ones, then pull a JSON block out of the raw reply and merge it onto the draft so far. Only
// the TAGS and the SHAPE differ, and those are the agent's own business.
//
// Before this module the mechanics were copied per agent: `_parseKairosResponse`,
// `_parseMentorResponse` and `_parseAnalystResponse` were the same eight lines with a different
// tag; `_mergeCallDraft` and `_mergeSetupDraft` were character-for-character identical; and the
// bounded phase-capture closure appeared five times with only its upper bound changed.

/**
 * Pull one `<tag>…</tag>` JSON block out of a raw model reply.
 *
 * Returns null when the block is absent OR malformed — a half-parsed draft is worse than none,
 * because the client replaces its worksheet wholesale and would wipe settled fields. A malformed
 * block is warn-logged (models do emit truncated JSON) but never throws: one bad block must not
 * take down a turn that also contained a perfectly good reply.
 *
 * The tag is matched EXACTLY, which matters more than it looks: `<setup>` and `<setups>` share a
 * prefix, and a loose match would parse the candidate offer as a worksheet.
 */
export function parseEmitBlock(raw, tag, log = '[agentIO]') {
    const m = String(raw ?? '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    if (!m) return null
    try {
        return JSON.parse(m[1].trim())
    } catch (err) {
        logger.warn(log, `${tag} JSON parse failed:`, err.message)
        return null
    }
}

/**
 * Carry a draft forward across turns.
 *
 * Agents are told to re-emit the COMPLETE artifact every turn, but on an edit turn a model often
 * narrates "everything else stands" and emits only the field it changed. The client replaces its
 * draft wholesale, so that thin block would wipe already-settled work.
 *
 * SHALLOW BY DESIGN: a re-emitted array or object replaces its prior value outright, so the model
 * can still DROP a zone or clear a field with an explicit null. Only OMISSION is protected.
 * Returns null when there is no new artifact this turn, so the caller keeps what it has.
 */
export function mergeDraft(prev, next) {
    if (!next) return null
    if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return next
    return { ...prev, ...next }
}

/**
 * A bounded phase capture. The model emits `<phase>N</phase>` every turn; the number drives the UI
 * heading and the next turn's model routing, so an out-of-range or non-numeric value must be
 * ignored rather than forwarded.
 *
 * Returns the capture callback plus a getter for the last valid value — agents need both, and
 * hand-rolling the closure five times is how the bounds drifted (1–5, 1–6, 1–7 by agent).
 */
export function makePhaseCapture(maxPhase, onPhase) {
    let captured = null
    return {
        capture: (p) => {
            const n = parseInt(p, 10)
            if (Number.isFinite(n) && n >= 1 && n <= maxPhase) {
                captured = n
                onPhase?.(n)
            }
        },
        get: () => captured,
    }
}

/**
 * Open a model stream for an agent and return its raw text.
 *
 * Wraps the three lines every agent repeats: resolve the model + usage recorder, log the start,
 * and call the provider's streaming fn with the standard argument bag. `meta` adds agent-specific
 * fields to the start log (asset, account count, edit mode…) without each agent re-deriving
 * `model` and `provider` for its own log line.
 *
 * Deliberately does NOT parse: what comes back out of the stream is the agent's own contract.
 */
export async function runAgentStream({
    log = '[agentIO]', requestedModel, userId,
    messages, systemPrompt, tools, toolHandlers,
    reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning,
    meta = {},
    // Injectable so the argument-bag contract can be tested without a provider or a real model id.
    _resolve = resolveAgentStream,
}) {
    const { model, streamFn, provider, onUsage } = _resolve(requestedModel, userId)

    logger.info(log, 'chatStream start', { messageCount: messages?.length ?? 0, model, provider, ...meta })

    return streamFn({
        model, promptOrMessages: messages, systemPrompt, tools, toolHandlers,
        reasoningEffort, signal, onToken, tagCaptures, onToolStart, onReasoning, onUsage,
    })
}
