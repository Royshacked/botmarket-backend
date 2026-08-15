import { streamAnthropicWithTools } from '../providers/anthropic.provider.js'
import { recordUsage } from './tokenUsage.service.js'
import { logger } from './logger.service.js'

// ── The reasoning sidecar ─────────────────────────────────────────────────────
// Reasoning effort is a property of a THREAD, not of a turn. Changing it mid-conversation
// invalidates the message cache — the whole conversation is then re-read at 1× and re-written at
// 1.25× instead of read at 0.1× — which is why the user-facing reasoning knob is gone. But some
// decisions genuinely need depth: sizing, allocation, weighing two reads that disagree.
//
// So don't reconfigure the conversation. Ask a SECOND model, in its own request, carrying only the
// material that decision needs, and hand the answer back as a tool result. The desk's own request
// parameters never change, so its cache never dies, and the cost is the sidecar's small prompt
// rather than a re-read of the whole thread. That tradeoff IMPROVES with conversation length,
// where every per-turn design gets worse.
//
// This is the shared TRANSPORT only. What to think about — and when it is worth thinking about —
// is each desk's own judgment and stays in that desk's tool description (CLAUDE.md: share the
// pipe, not the judgment).
const LOG = '[deepThink]'

// The tool name, exported so the one place that auto-wires the handler (runAgentStream) and the one
// place that declares the schema (agentTools.registry) agree by reference rather than by two string
// literals that can drift apart silently — a mismatch would simply mean the tool never runs.
export const CONSULT_TOOL = 'consult'

// Opus 5 reasons by default and is the strongest model we route to. `high` rather than `max`:
// max shows diminishing returns and can overthink a bounded question, which is all this ever gets.
const DEFAULT_MODEL  = 'claude-opus-5'
const DEFAULT_EFFORT = 'high'

// Booked under its own agent tag rather than the calling desk's, so `byAgent.consult` answers the
// question this feature lives or dies on: is the sidecar cheaper than the depth it replaced?
const LEDGER_TAG = 'consult'

const SYSTEM = `You are a senior trading desk head consulted mid-analysis on ONE decision.

You are given a question and the material to answer it — nothing else. You cannot fetch data, and
you have no access to the conversation that produced the question. If the material is not enough
to decide, say exactly what is missing rather than guessing or hedging.

Answer the question that was asked, in a few sentences. Lead with the call, then the reasoning
that actually drove it. No preamble, no restating the question, no options survey — the desk asking
you needs a decision it can act on, not a menu. Where you are genuinely uncertain, say so and say
which way you lean.`

/**
 * Consult a stronger model about one bounded decision.
 *
 * Deliberately NOT an agent: no tools, no conversation history, no state. Everything it reasons
 * over arrives in `context`, which keeps the request small enough that its price is a rounding
 * error against the conversation it protects.
 *
 * @param {object}  opts
 * @param {string}  opts.question  the decision to make
 * @param {string} [opts.context]  the material to decide on — levels, account size, the conflict
 * @param {string} [opts.model]    override; the caller almost never should
 * @param {string} [opts.effort]   'low' | 'high'
 * @param {string} [opts.userId]   for usage attribution
 * @param {function} [opts.onReasoning]  the consulted model's thinking, streamed as it arrives
 * @returns {Promise<string>} the answer, or a readable failure the desk can carry on from
 */
export async function deepThink({
    question, context = '', model, effort, userId, onUsage, onReasoning,
    // Injectable so this function's OWN behaviour — the reasoning passthrough and the containment
    // around it — is reachable without a live model call. Everything else here is exercised through
    // makeConsultHandler's `_deepThink`.
    _stream = streamAnthropicWithTools,
} = {}) {
    const asked = String(question ?? '').trim()
    if (!asked) return 'No question was asked, so there is nothing to advise on.'

    const body = context.trim()
        ? `QUESTION\n${asked}\n\nMATERIAL\n${context.trim()}`
        : `QUESTION\n${asked}\n\n(No supporting material was provided.)`

    const picked = model ?? DEFAULT_MODEL
    try {
        // No `tools` and no history by design — that is what keeps the request small, and it is
        // also why the tool loop below never iterates: there is nothing for it to call.
        //
        // `onReasoning` costs NOTHING to pass. The thinking tokens are billed as output tokens
        // whether or not anyone reads them, so the depth we pay for here was already being thrown
        // away — surfacing it is free, and hiding it was the only thing that was expensive.
        // Source-agnostic on purpose: this is the shared transport, and WHOSE thinking this is
        // belongs to the caller that knows (runAgentStream tags it).
        const answer = await _stream({
            model:            picked,
            systemPrompt:     SYSTEM,
            promptOrMessages: [{ role: 'user', content: body }],
            tools:            [],
            reasoningEffort:  effort ?? DEFAULT_EFFORT,
            onUsage:          usage => onUsage?.(usage, picked),
            // A throwing consumer must not cost the desk the answer it already paid for — the same
            // containment the usage write below gets, for the same reason.
            onReasoning:      onReasoning ? (text) => { try { onReasoning(text) } catch { /* a viewer is not worth the turn */ } } : undefined,
        })
        logger.info(LOG, 'consulted', { userId, chars: answer?.length ?? 0 })
        return answer?.trim() || 'The consult returned nothing usable — decide on your own read.'
    } catch (err) {
        // A failed consult must never fail the desk's turn: the desk asked for a second opinion,
        // not for permission to continue. Hand back the failure as the answer and let it proceed.
        logger.warn(LOG, 'consult failed', { userId, message: err?.message })
        return `The consult could not be completed (${err?.message ?? 'unknown error'}). Proceed on your own read and say that you did.`
    }
}

/**
 * Wrap `deepThink` as a tool handler with a per-turn ceiling.
 *
 * The failure mode is over-consulting: every call is a second model request, and a desk that
 * reaches for it on easy questions turns a cost saving into a cost increase. The tool description
 * carries the judgment about WHEN; this is the backstop for when that judgment slips. One counter
 * per turn, because a fresh handler is built per `chatStream` call.
 */
export function makeConsultHandler({
    userId = null,
    maxPerTurn = 3,
    onReasoning = null,
    _deepThink = deepThink,
    _record = recordUsage,
} = {}) {
    let used = 0
    return async ({ question, context }) => {
        if (++used > maxPerTurn) {
            logger.warn(LOG, 'per-turn cap hit', { userId, maxPerTurn })
            return `You have already consulted ${maxPerTurn} times this turn, which is the limit. Decide on your own read and say that you did.`
        }
        return _deepThink({
            question, context, userId, onReasoning,
            // Best-effort, like every other usage write: a ledger hiccup must not cost the desk an
            // answer it already paid for. try/catch AND .catch — recordUsage can fail either way
            // (a synchronous throw before it ever awaits, or a rejected promise), and catching only
            // the async half lets the other one escape into the desk's turn.
            onUsage: (usage, model) => {
                try { Promise.resolve(_record(userId, model, usage, LEDGER_TAG)).catch(() => {}) }
                catch { /* ledger is not worth an answer */ }
            },
        })
    }
}
