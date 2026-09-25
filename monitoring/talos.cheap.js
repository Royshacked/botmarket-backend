// Talos's CHEAP read — the tier that decides whether the expensive one is worth paying for.
//
// docs/design/talos-two-tier.md §Phase 3. One model call, NO TOOLS, no vision, no chart. It is
// handed numbers — the candles on the watched rung, the indicators computed from them, the price,
// the plan's conditions in the trader's own words — and answers two questions: is the setup fired,
// and should the expensive read run.
//
// WHY IT IS A MODEL CALL AND NOT CODE. Conditions are TEXT and stay text; there is no taxonomy
// anywhere in this kind. Code could only evaluate them by first mapping them onto an enum, which is
// exactly what the `setup` kind exists to not have. A small model reads the sentence directly: it
// answers "close above 100" off the rows, and says `unknown` to "a false break down at the previous
// daily low", which is not a failure — it is the answer, and saying it is what this tier is for.
//
// WHAT IT MAY NEVER DO. It has no verdict vocabulary, no guards, no proposals, and it never places
// an order. `fired` is a REFERRAL, not a decision: the expensive read re-judges the same question
// with a chart in front of it and owns the outcome. Both tiers answer "is the setup fired?" on
// purpose.
//
// MEASURED (2026-09-23, 95 recorded reads replayed through this prompt on Haiku 4.5, $0.33):
// 74 of 95 would have slept — 78% of wakes needing no expensive read at all, $15.68 → $3.80 on that
// sample. 20 came back `unknown` and every one escalated, which is the design working. The safety
// column is NOT established: only 2 of the 95 reads did anything, so "it does not miss actions" is
// not yet a claim that data can carry (see the plan's Open decision 3).

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../services/logger.service.js'
import { config } from '../services/config.js'
import { extractFirstJSON } from './parsers/llmReply.parser.js'
import {
    candleRows, formatCandles, indicatorsText, assessSystem, bookAssessUsage, legsText,
} from './assess.shared.js'
import { declaredConditions, pickScenario, paceRungs } from '../services/setup.schema.js'

const LOG = '[talos.cheap]'

const _client = new Anthropic({ apiKey: config.anthropicApiKey })

/**
 * The model the cheap tier runs on. Deliberately NOT the house Talos model: this read has one job,
 * no tools and a fixed answer shape, and paying the expensive tier's rate to decide whether to run
 * the expensive tier would be the joke version of this design.
 *
 * Haiku 4.5 is what the 95-read replay measured, and `TALOS_CHEAP_MODEL` overrides it so a
 * candidate can be swapped without a deploy.
 */
export const CHEAP_MODEL = config.talosCheapModel || 'claude-haiku-4-5'

/** The answer shape is a handful of short strings. Anything larger means it is writing an essay. */
const MAX_TOKENS = 1_024

/** What a condition can come back as. `unknown` is a first-class answer, not a failure. */
export const CHEAP_STATES = ['fired', 'not_fired', 'unknown']

// The system prompt is FROZEN and carries the 1h cache marker, so every cheap read in the system —
// every setup, every user — shares one cached prefix. With no tools block at all (the first thing
// in the cache prefix, before `system`), this is the best-caching object here.
const SYSTEM = `You are the CHEAP tier of a trade-setup monitor. You are handed numbers only — recent candles and a few indicators computed from them — and the plan's conditions, written by a trader in their own words.

You have NO tools. You cannot look at a chart, check news, or fetch anything. If a condition needs something the numbers in front of you cannot show — a shape, a pattern, a structural read like "a false break that failed", anything about news or another instrument — that is not a failure, it is the answer "unknown", and saying so is exactly what you are for.

For EACH condition return one of three states:
- "fired"     — the numbers in front of you show this is true right now.
- "not_fired" — the numbers in front of you show this is NOT true, and you are confident.
- "unknown"   — the numbers cannot settle it either way.

Be strict about "not_fired": claim it only when the numbers actually answer the question. A condition you cannot evaluate is "unknown", never "not_fired". Being wrong towards "unknown" costs one read; being wrong towards "not_fired" costs the user their trade.

You are NOT deciding whether to enter. You are deciding whether this is worth a proper look. Set "escalate" true if an expensive read — charts, structure, patterns, news — should run now: whenever anything fired, whenever anything is unknown, or whenever the picture looks like it is about to matter.

Always include "read": ONE short, plain first-person sentence — what you see and what you are doing about it.

Output ONLY a JSON object, no prose:
{"conditions":[{"id":"<id>","state":"fired|not_fired|unknown","note":"<short>"}],"escalate":true,"read":"<one sentence>"}`

/**
 * Which rung and which indicators this tier works on: what the last EXPENSIVE read declared
 * (`watch`), else the rung the setup would open on and the standard set. The fallback exists so the
 * cheap tier is usable before Phase 4.3 teaches the expensive read to declare anything. Pure.
 */
export function cheapWatch(setup) {
    const w = setup?.watch
    if (w?.rung) return { rung: w.rung, indicators: w.indicators ?? [] }
    return { rung: setup?.monitor_state?.timeframe || setup?.timeframe || paceRungs(setup)[0], indicators: [] }
}

/**
 * The plan's levels as PRICES — the same lines the expensive tier is handed (`legsText`), so the
 * tier that decides whether to escalate and the tier it escalates to are reading one vocabulary.
 * It used to be `JSON.stringify` of the stored zones, which handed a numbers-only read the band
 * shape (`{"lower":238.2,"upper":238.2}`) for a level the user wrote as a point.
 *
 * Entry and stop only, as before: this tier answers "is it fired", and a target is not that question.
 */
function _levelsBlock(setup, scenario) {
    const legs = [
        legsText(scenario?.entry_legs, 'ENTRY'),
        legsText(scenario?.stop_legs, 'STOP'),
    ].filter(Boolean).join('\n')
    return legs ? `PLAN LEVELS:\n${legs}` : 'PLAN LEVELS: (none priced)'
}

/** The conditions block, with an already-settled latching condition shown as settled. */
function _conditionLines(setup, conditions) {
    const resolved = setup?.monitor_state?.conditions ?? {}
    return conditions.map(c => {
        const prior = resolved[c.id]
        if (c.persistence === 'latching' && prior?.met === true) {
            return `- [${c.id}] (${c.weight}) ${c.text}\n    ALREADY ESTABLISHED on ${prior.at ?? 'an earlier wake'}. Treat as met; do not re-check.`
        }
        return `- [${c.id}] (${c.weight}, ${c.mode}) ${c.text}`
    })
}

/** The whole user turn. Pure given its inputs, so a test can read it without a fetch. */
export function buildCheapUserText(setup, { scenario, conditions, rung, candles, indicators, price }) {
    return [
        `SETUP: ${JSON.stringify({
            asset: setup.asset, direction: setup.direction, type: setup.type,
            trade_mode: setup.trade_mode, timeframe: setup.timeframe, thesis: setup.thesis,
        })}`,
        _levelsBlock(setup, scenario),
        conditions.length
            ? `CONDITIONS — judge exactly these, nothing else:\n${_conditionLines(setup, conditions).join('\n')}`
            : 'CONDITIONS: (none declared)',
        `CURRENT PRICE: ${price ?? 'unknown'}`,
        `RUNG: ${rung}`,
        candles ? `RECENT CANDLES (${rung}):\n${candles}` : null,
        indicators ? `INDICATORS (${rung}, computed from the candles above):\n${indicators}` : null,
        `PRIOR MEMO: ${setup.monitor_state?.memo || '(none)'}`,
    ].filter(Boolean).join('\n\n')
}

/**
 * Coerce whatever came back into the answer shape, and decide whether to escalate.
 *
 * THE MODEL CANNOT DECLINE TO ESCALATE. It may ask for a read for its own reasons, but `fired` or
 * `unknown` on any declared condition forces one, as does an unparseable reply — the failure mode of
 * this tier has to be "you paid for a read you were going to pay for anyway", never "your trade went
 * unwatched because a small model was confused". Pure.
 */
export function normalizeCheapReply(raw, declared) {
    const byId = new Map((Array.isArray(raw?.conditions) ? raw.conditions : [])
        .filter(c => c && typeof c.id === 'string')
        .map(c => [c.id, c]))

    const conditions = declared.map(d => {
        const got   = byId.get(d.id)
        const state = CHEAP_STATES.includes(got?.state) ? got.state : 'unknown'
        return { id: d.id, state, note: typeof got?.note === 'string' ? got.note.trim() : null }
    })

    const forced = conditions.some(c => c.state !== 'not_fired')
    return {
        conditions,
        escalate: forced || raw?.escalate === true,
        read: typeof raw?.read === 'string' ? raw.read.trim() : null,
    }
}

/**
 * Run one cheap read. Resolves to `{ conditions, escalate, read }`, or `{ escalate: true,
 * _failReason }` when anything at all goes wrong — a tier that cannot answer escalates.
 *
 * Deps injectable so the tests exercise this without network IO.
 */
export async function cheapRead(setup, ctx = {}, deps = {}) {
    const { rows = candleRows, send = _send } = deps
    const scenario = ctx.scenario ?? pickScenario(setup)
    const declared = declaredConditions(setup, scenario)
    const { rung }  = cheapWatch(setup)

    if (!declared.length) {
        // Nothing written in words means nothing this tier could judge. Escalate rather than invent
        // an opinion: whether a setup with no conditions should be read at all is the monitor's call.
        return { conditions: [], escalate: true, read: null, _failReason: 'no_conditions' }
    }

    try {
        const asset = String(setup.asset ?? '').toUpperCase()
        const bars  = await rows(asset, rung).catch(() => [])
        const userText = buildCheapUserText(setup, {
            scenario, conditions: declared, rung,
            candles: formatCandles(bars),
            indicators: indicatorsText(asset, bars, rung),
            price: ctx.price,
        })

        const res = await send({ system: assessSystem(SYSTEM), userText })
        bookAssessUsage(setup?.userId, CHEAP_MODEL, res?.usage, 'talosCheap')

        const text = (res?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('')
        // extractFirstJSON THROWS on junk rather than returning null — caught here so an
        // unparseable reply is its own reason in the journal, not indistinguishable from a dead
        // provider. Either way it escalates.
        let parsed
        try { parsed = extractFirstJSON(text) }
        catch {
            logger.warn(LOG, `[${setup.id}] unparseable cheap reply — escalating`)
            return { conditions: [], escalate: true, read: null, _failReason: 'unparseable' }
        }
        return { ...normalizeCheapReply(parsed, declared), _model: CHEAP_MODEL }
    } catch (err) {
        logger.warn(LOG, `[${setup?.id}] cheap read failed (${err.message}) — escalating`)
        return { conditions: [], escalate: true, read: null, _failReason: 'io' }
    }
}

/** The Anthropic call. No `tools` key at all — that is what makes the prefix cache so cheap. */
async function _send({ system, userText }) {
    return _client.messages.create({
        model: CHEAP_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userText }],
    })
}
