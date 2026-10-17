// One agent's rolling summary (unified-chat.md §6.1, plan phase 4 §6.1 step 5).
//
// When an agent's segment past its summary grows beyond maxMessages × 3 — the same high-water mark
// agentUtils.trimHistory cuts on — the oldest turns down to maxMessages are FOLDED into the summary
// instead of being thrown away. The summary changes only at that moment, so the cached prompt prefix
// stays byte-stable between folds, exactly as the trim's does.
//
// Haiku 4.5, fixed — a utility call, outside the house-model selector — booked to the user's usage like
// any call. It never touches the agent's working state. On any failure nothing changes: the desk trims
// the turn exactly as it does today, which is never worse than now.

import { callAnthropicOnce } from '../../providers/anthropic.provider.js'
import { CHEAP_MODEL } from '../llmModels.js'
import { recordUsage } from '../tokenUsage.service.js'
import { segmentOf, contextRole } from '../session.util.js'
import { logger } from '../logger.service.js'

const LOG = '[summarize]'
// The ceiling comes from the high-water mark the desks already trim on (agentUtils.trimHistory).
export const FOLD_FACTOR = 3

const SYSTEM = [
    'You keep the running summary of ONE desk\'s conversation with a trader, so the desk can carry on',
    'after its oldest turns are dropped. Rewrite the summary to include the new turns. Keep: the user\'s',
    'constraints and preferences, decisions made and why, entities named by their id or ticker, and open',
    'questions. Drop small talk, greetings and tool output. Never invent anything not in the turns.',
    'At most 300 words. Return only the summary text — no heading, no preamble.',
].join(' ')

/**
 * The turns to fold, or null when the segment is still under the ceiling.
 * @returns {{ fold: object[], throughSeq: number } | null}
 */
export function foldPlan(messages, agent, summary, maxMessages) {
    const through = Number.isFinite(summary?.throughSeq) ? summary.throughSeq : 0
    const open = segmentOf(messages, agent).filter(m => Number.isFinite(m.seq) && m.seq > through)
    if (!(maxMessages > 0) || open.length <= maxMessages * FOLD_FACTOR) return null
    const fold = open.slice(0, open.length - maxMessages)
    return { fold, throughSeq: fold.at(-1).seq }
}

export function makeSummarizer({ once = callAnthropicOnce, record = recordUsage, model = CHEAP_MODEL } = {}) {
    /**
     * Fold `turns` into `prior`. Returns the new summary text, or null on any failure.
     */
    return async function summarize({ userId, agent, prior = null, turns }) {
        const lines = turns.map(m => `${contextRole(m, agent) === 'user' ? 'USER' : 'DESK'}: ${m.content}`)
        const user  = `${prior ? `CURRENT SUMMARY:\n${prior}\n\n` : ''}NEW TURNS (${agent}):\n${lines.join('\n')}`
        try {
            const text = await once({
                model, systemPrompt: SYSTEM, user, maxTokens: 700,
                onUsage: (usage, m) => { record(userId, m, usage, 'summary').catch(() => {}) },
            })
            return typeof text === 'string' && text.trim() ? text.trim() : null
        } catch (err) {
            logger.warn(LOG, 'summary failed (the trim stands in)', err.message)
            return null
        }
    }
}

export const summarize = makeSummarizer()
