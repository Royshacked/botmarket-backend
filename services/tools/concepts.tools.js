/**
 * `explain_concept` — the teaching tool.
 *
 * THE POINT OF IT BEING A TOOL is that it makes the authored/improvised boundary observable. With
 * a glossary pasted into the system prompt the model blends vetted text and its own knowledge
 * invisibly, and nobody can tell afterwards which one the user got. As a tool call, either it was
 * invoked — the user read reviewed copy, verbatim — or it wasn't, and the prompt's guard-rails
 * applied instead. The tool-status chip shows the user a definition was looked up.
 *
 * A MISS IS NOT AN ERROR. The concept set covers what a beginner needs to consent safely, not the
 * whole of trading, so "wedge pattern" legitimately isn't in it. Returning a toolError there would
 * tell the model something went wrong and invite an apology; instead it gets an explicit
 * instruction to explain the thing itself, carefully. The fallback is half the design.
 *
 * NOT bound to a userId — a definition is the same for everyone, which is exactly why it can be
 * written once. Anchoring it to the user's own position is the prompt's job, using the venue and
 * watchlist reads that already exist.
 */

import { makeToolHandler } from '../agentUtils.js'
import { getConcept } from '../concepts.service.js'

const LOG = '[concepts]'

/** What the model is told when a concept isn't in the authored set. */
export function fallbackFor(concept) {
    const asked = String(concept ?? '').trim() || 'that'
    return [
        `No authored explanation for "${asked}".`,
        'Explain it yourself, in plain language, as you would to someone who has never traded:',
        'what it is, why it exists, and what it costs them. Keep it basic and short of jargon.',
        'Do NOT invent specifics — no made-up numbers, thresholds or rules of thumb. If you are not',
        'confident about a detail, say so plainly rather than filling the gap.',
        'And keep describing, never prescribing: what their own number should be is a desk\'s call.',
    ].join(' ')
}

export function makeConceptHandlers(deps = {}) {
    const { lookup = getConcept } = deps
    return {
        explain_concept: makeToolHandler('explain_concept',
            async ({ concept } = {}) => {
                const found = lookup(concept)
                // Verbatim. Paraphrasing authored copy would defeat the reason it was authored.
                return found ? found.body : fallbackFor(concept)
            },
            (err) => `Could not look up that concept: ${err.message}`, LOG),
    }
}

/**
 * The tool DESCRIPTION — the instruction the model reads.
 *
 * It describes the SHAPE of the authored set rather than listing it. Interpolating the live keys
 * would read better to the model but would tie the tool's snapshot to the content file, so adding
 * a concept — a copy edit, by whoever writes the copy — would fail a test and need the fixture
 * regenerated. Precision isn't needed here anyway: the tool is worth calling for anything, because
 * a miss still returns useful guidance.
 */
export const CONCEPT_TOOL_SPEC = {
    explain_concept: `A plain-language explanation of a trading concept, written for someone who has never traded — what it is, why it exists, what it costs them, and the mistake beginners make. Call it whenever the user asks what something means, or when you are about to use a term they may not know. Authored explanations cover the basics a beginner meets in this app: stops, targets, entries, risk, position size, drawdown, R, risk-reward, long vs short, order types, fills, invalidation, thesis, conviction, paper vs live, and why a stop being hit is not a failure. Anything else returns guidance on explaining it yourself. Use the text it gives you AS-IS rather than rewriting it. This is TEACHING, not advice: it explains what a stop is, it never says where the user's stop should go.`,
}
