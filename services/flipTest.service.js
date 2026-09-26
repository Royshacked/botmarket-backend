// THE FLIP TEST — the same evidence, argued the other way, by somebody who cannot see the plan.
//
// A desk that checks its own direction agrees with itself. That is not a quirk of one model, it is
// what the medium does: asked "are you sure?", it produces the reasoning for whichever answer is
// already on the page. So the only honest version of this check needs two things the desk cannot
// supply about its own work — an independent judge, and an evidence pack the judge's counterpart did
// not assemble (docs/design/mentor-challenge.md §2).
//
// THE BLINDING IS THE WHOLE DESIGN, and it is why this is a service rather than a paragraph in the
// prompt. If Mentor wrote the case file, it would hand over the numbers that suit the plan it already
// drew and get back the weak counter-case it expected — a ritual that costs a model call and returns
// reassurance. So the tool takes only what IDENTIFIES the question (symbol, rung, horizon, and the
// direction already chosen). Every number is fetched here, by the same readers the desk itself uses,
// and the model contributes nothing to the pack.
//
// WHAT IT CANNOT SEE, and says so: macro tone, news, and the catalyst calendar. The pack is structure,
// levels, liquidity, imbalances and indicator values. A flip verdict must never be allowed to
// overrule a dated catalyst it was never shown.
//
// THREE OUTCOMES, and the middle one is the valuable one:
//   stands     — the counter-case is weak. The original read is chart-driven.
//   two_sided  — the chart supports both about equally. Nothing else in the app produces this
//                sentence, and it is the honest cap on a plan's conviction.
//   reversed   — the numbers favour the other side. The direction rung reopens, and everything below
//                it is void (the cascade — principle 8 of the design).
//
// Transport is the shared sidecar (deepThink). What to ask it, and what the answer means, is this
// file's — the house rule: share the pipe, not the judgment.

import { deepThink } from './deepThink.service.js'
import { recordUsage } from './tokenUsage.service.js'
import { normalizeTimeframe } from './timeframe.service.js'
import { smcBars, smcReadText, SMC_TOOL_NAMES } from './tools/smc.tools.js'
import { makeIndicatorsHandler, makeQuoteHandler } from './tools/marketData.tools.js'
import { logger } from './logger.service.js'

const LOG = '[flipTest]'

/** The tool name, exported so the declaration and the handler wiring agree by reference. */
export const FLIP_TOOL = 'flip_test'

// Booked separately from `consult` so the question this feature lives or dies on is answerable:
// what does an attacked plan cost, and how often is the attack reached for? Buried inside the
// desk's chat spend, or inside the sidecar's own bucket, neither is visible.
const LEDGER_TAG = 'flip'

// The rung the pack ALWAYS includes, whatever was asked for. A flip test run only on the rung the
// plan was drawn on could be steered by naming a friendly timeframe; the daily is where the
// structure that decides a direction lives, and it cannot be dodged.
const ANCHOR_RUNG = 'day'

const INDICATORS = 'atr, vwap, ema(20), ema(50), rsi(14)'

const SYSTEM = `You are a second trading desk. You are handed the measurements for one instrument and the direction somebody else has chosen, and asked to make the strongest HONEST case for the opposite side.

You cannot see their plan, their thesis or their reasoning, and you are not reviewing it. You have the numbers and the direction. Build the best case against it.

RULES
- Only what the numbers support. If the opposite case is weak, say it is weak. A manufactured counter-case is worse than none, because it will be believed and it will cost somebody a trade that was fine.
- Name exact prices, taken from the levels you were given: an entry, a stop, and a first target.
- Price it: R = (first target − entry) ÷ (entry − stop), mirrored for a short. State the number. Under 1R the opposite case is not a trade, and you say so plainly.
- You have structure, levels, liquidity, imbalances and indicator values. You have NO macro read, NO news, and NO catalyst calendar. Never speculate about them; if the honest answer depends on one, say which.

ANSWER IN THIS SHAPE, and nothing else:
VERDICT: this | neither | the_other
  this      = the direction they chose is the one these numbers favour
  neither   = the numbers support both sides about equally
  the_other = the numbers favour the opposite side
Then at most 120 words: the opposite case with its three prices and its R, and the ONE fact that decides between the two sides.`

/** The document's word for each verdict. What the verdict MEANS for a plan is this file's judgment. */
const VERDICTS = { this: 'stands', neither: 'two_sided', the_other: 'reversed' }

/**
 * The tool description. Mentor's own WHEN-clause is not a parameter here the way `consult`'s is:
 * there is exactly one desk with a plan to attack, and one situation to reach for it in.
 */
export const FLIP_DESCRIPTION = `Have this plan's DIRECTION attacked by a second desk that cannot see your conversation. The server assembles the evidence itself — structure, levels, liquidity, imbalances, indicators, on the rung you name and on the daily — and a stronger model argues the opposite side from those numbers and returns a verdict: \`stands\` (the counter-case is weak), \`two_sided\` (the chart supports both about equally) or \`reversed\` (the numbers favour the other way).

You cannot influence what it is shown, which is the point: you supply only the ticker, the rung, the horizon and the direction already chosen. It has no macro read, no news and no catalyst calendar, so it must never be allowed to overrule a dated event.

Reach for it when the user ASKS for their direction challenged, and — once, at the moment a setup goes ready — when real money is behind it (a \`live\` or \`manual\` account). Never on paper unless asked, never twice on the same levels, and never on a plan the user brought unless they ask outright: taking someone's own plan down and then arguing with its direction is not what they came for.`

/**
 * Pull `VERDICT: x` off the front of the sidecar's answer.
 *
 * Tolerant, and null when unreadable — a verdict we cannot parse must not become a verdict we
 * invent. The prose still reaches the desk either way; only the recorded provenance is lost.
 */
export function parseVerdict(text) {
    const m = /verdict\s*[:-]\s*(this|neither|the_other)\b/i.exec(String(text ?? ''))
    return m ? VERDICTS[m[1].toLowerCase()] : null
}

/**
 * Assemble the evidence pack. Every read is contained on its own: a provider that fails costs the
 * pack one section and is named as missing, because a silently thinner pack is exactly the bias this
 * service exists to remove.
 *
 * The readers are the desk's own (`smcReadText`, the indicator and quote handlers), so the judge sees
 * the same numbers in the same words the desk would have — one reader, not a second implementation
 * that could drift into a kinder read.
 */
export async function buildPack({ symbol, timeframe, _bars = smcBars, _read = smcReadText, _indicators, _quote } = {}) {
    const T     = String(symbol ?? '').toUpperCase().trim()
    const rung  = normalizeTimeframe(timeframe) || ANCHOR_RUNG
    const rungs = [...new Set([rung, ANCHOR_RUNG])]

    const indicators = _indicators ?? makeIndicatorsHandler(LOG)
    const quote      = _quote ?? makeQuoteHandler(LOG)

    const sections = []
    const missing  = []

    const q = await Promise.allSettled([quote({ ticker: T })])
    if (q[0].status === 'fulfilled') sections.push(`QUOTE\n${_stringify(q[0].value)}`)
    else missing.push('the live quote')

    for (const tf of rungs) {
        try {
            const bars = await _bars(T, tf)
            if (!bars?.length) { missing.push(`${tf} candles`); continue }
            sections.push(`STRUCTURE ON THE ${tf.toUpperCase()}\n${SMC_TOOL_NAMES.map(n => _read(n, T, tf, bars)).join('\n')}`)
        } catch (err) {
            logger.warn(LOG, `pack: ${tf} structure failed`, { symbol: T, message: err?.message })
            missing.push(`${tf} structure`)
        }
    }

    const ind = await Promise.allSettled([indicators({ ticker: T, timeframe: rung, indicators: INDICATORS })])
    if (ind[0].status === 'fulfilled') sections.push(`INDICATORS\n${_stringify(ind[0].value)}`)
    else missing.push('indicator values')

    return {
        rungs,
        missing,
        text: sections.join('\n\n') || 'No numbers could be fetched.',
        // Enough to be worth asking about at all: a quote and one structural read. Below that the
        // judge would be reasoning from nothing, and an opinion formed from nothing is the one output
        // that must never reach the desk wearing a verdict.
        usable: sections.length >= 2,
    }
}

const _stringify = (v) => (typeof v === 'string' ? v : JSON.stringify(v))

/**
 * Run one flip test. Never throws: a failure comes back as prose the desk can carry on from, exactly
 * as a failed consult does — the desk asked for its plan to be attacked, not for permission to keep
 * working.
 *
 * @returns {Promise<{ text: string, verdict: string|null }>}
 */
export async function flipTest({
    symbol, timeframe = null, horizon = null, direction = null,
    userId = null, onReasoning = null, onUsage = null,
    _pack = buildPack, _think = deepThink,
} = {}) {
    const T   = String(symbol ?? '').toUpperCase().trim()
    const dir = direction === 'short' ? 'short' : direction === 'long' ? 'long' : null
    if (!T || !dir) {
        return { text: 'A flip test needs the ticker and the direction the plan takes. Nothing was run.', verdict: null }
    }

    // CONTAINED WHOLE, not just per section. buildPack guards each read, but the fetch layer under it
    // can still throw before any of them runs (a bad symbol, a dead provider client) — and a desk that
    // asked for its plan to be attacked did not ask for permission to keep working.
    let pack
    try { pack = await _pack({ symbol: T, timeframe }) }
    catch (err) {
        logger.warn(LOG, 'pack failed', { userId, symbol: T, message: err?.message })
        return { text: `The evidence for a flip test could not be gathered (${err?.message ?? 'unknown error'}), so the direction was NOT checked. Say so rather than implying it was.`, verdict: null }
    }
    if (!pack.usable) {
        return {
            text: `The evidence pack could not be assembled (${pack.missing.join(', ') || 'no data'}), so the direction was NOT checked. Say so rather than implying it was.`,
            verdict: null,
        }
    }

    const caveat = pack.missing.length ? `\n\nNOT AVAILABLE: ${pack.missing.join(', ')}. Reason only from what is here.` : ''
    const answer = await _think({
        question: `A trader is planning a ${dir.toUpperCase()} on ${T}${horizon ? ` over a ${horizon} horizon` : ''}, drawn on the ${pack.rungs[0]}. Make the strongest honest case for the ${dir === 'long' ? 'SHORT' : 'LONG'} side from these numbers, and say which side they actually favour.`,
        context: `${pack.text}${caveat}`,
        system: SYSTEM,
        userId, onReasoning, onUsage,
    })

    const verdict = parseVerdict(answer)
    logger.info(LOG, 'flip', { userId, symbol: T, dir, rungs: pack.rungs.join('+'), verdict, missing: pack.missing.length })
    return { text: answer, verdict }
}

/**
 * Wrap `flipTest` as a tool handler, capped at ONE per turn.
 *
 * One, not three like the consult: a second flip test on the same plan asks the same question of the
 * same numbers, and the only thing a desk could do with a different answer is pick the one it liked.
 * That is the failure mode this whole feature exists to prevent, so the cap is part of the design
 * rather than a cost guard.
 *
 * `onVerdict` is how the SERVER records what happened. The verdict must never be authored by the
 * model it is a verdict about — a desk that files its own `stands` on a read that came back
 * `reversed` has produced provenance worth less than none.
 */
export function makeFlipHandler({
    userId = null, agent = null, onReasoning = null, onVerdict = null,
    _flipTest = flipTest, _record = recordUsage,
} = {}) {
    const tag = agent ? `${LEDGER_TAG}:${agent}` : LEDGER_TAG
    let used  = 0
    return async ({ symbol, timeframe, horizon, direction } = {}) => {
        if (++used > 1) {
            logger.warn(LOG, 'second flip test refused', { userId })
            return 'This plan has already been attacked once this turn. Running it again asks the same question of the same numbers — use the verdict you have.'
        }
        let text, verdict
        try {
            ({ text, verdict } = await _flipTest({
                symbol, timeframe, horizon, direction, userId, onReasoning,
                onUsage: (usage, model) => {
                    try { Promise.resolve(_record(userId, model, usage, tag)).catch(() => {}) }
                    catch { /* a ledger hiccup must not cost an answer already paid for */ }
                },
            }))
        } catch (err) {
            // flipTest contains its own failures, so reaching here means something under it broke in a
            // way it did not expect. Belt and braces, for the same reason the consult handler has them:
            // a tool that throws takes the desk's whole turn with it.
            logger.warn(LOG, 'flip handler failed', { userId, message: err?.message })
            return `The flip test could not be run (${err?.message ?? 'unknown error'}). Proceed on your own read and say that you did.`
        }
        if (verdict && onVerdict) {
            try { onVerdict(verdict) } catch { /* a recorder is not worth the turn */ }
        }
        return text
    }
}
