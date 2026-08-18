// The arm-time pre-flight check: is the entry level ALREADY held at the moment the user arms it?
//
// Lifted out of minos.monitor.service.js when Minos was deleted (2026-08-18). It was one of two
// functions still wired into the live CRUD path from an otherwise archived monitor — the other,
// `resetIdea`, only cleared Minos's private `_lastChecked` Map and became a genuine no-op the
// moment that Map went, so its six call sites were simply dropped. This one is real behaviour and
// had to survive. Same move, same reason, as `services/entryTimeGate.util.js` before it.
//
// Lives in monitoring/ rather than services/ because it reaches into the evaluator stack
// (`evaluateTree`) and the candle plumbing; `entryTimeGate` could go to services/ because it is
// pure. The direction of the dependency is unchanged — monitoring/ may import from services/,
// never the reverse.
//
// THE CASE IT CATCHES. The monitor fires on a RISING EDGE: it wants the condition to become true
// after the floor. So if the breakout already happened before the idea was armed and price never
// dipped back, the edge never occurs and the idea sits at `looking` forever, silently. Detecting
// it needs two evaluations of the same tree — a state read ("is the level held right now?") and an
// edge read ("would the monitor fire?"). True-and-false together is exactly that stuck case, and
// the user is offered Buy now / Edit / Reset instead of waiting on something that cannot happen.

import { evaluateTree } from './monitor.orchestrator.js'
import { collectSymbols } from '../services/conditionTree.service.js'
import { logger } from '../services/logger.service.js'
import {
    fetchCandles, buildSymbolMap, buildVolumeCtx, brokerCandleCtx, resolveEntryTimeframe,
} from './monitorUtils.js'

const LOG = '[preflightEntry]'

/**
 * @param {object} idea  the entity being armed — any kind; only a structured entry tree is acted on
 * @returns {Promise<{alreadySatisfied: boolean, close?: number|null}>}
 *
 * BEST-EFFORT AND NEVER THROWS. It runs inside a status change the user requested, so a provider
 * hiccup must not fail the arm — every failure path returns not-satisfied and the status change
 * proceeds exactly as if the check had found nothing.
 */
export async function preflightEntry(idea) {
    try {
        const { id, asset } = idea

        // Scope: entries that are purely structured price leaves. A mixed tree would drag the
        // chart/news/indicator LLM evaluators into a synchronous request, and "already true" is a
        // fuzzier question for them than for a price level.
        const tree = idea.entry_condition_tree
        if (!tree || !_isStructuredOnly(tree)) return { alreadySatisfied: false }

        const entryTf = resolveEntryTimeframe(idea)
        const cctx    = brokerCandleCtx(idea)
        const candles = await fetchCandles(id, asset, entryTf, undefined, cctx)
        if (!candles) return { alreadySatisfied: false }

        const crossSyms = collectSymbols(tree, idea.entry_conditions)
        const symbolMap = await buildSymbolMap(id, asset, candles, entryTf, crossSyms)
        const volCtx    = await buildVolumeCtx(id, asset, idea.asset_class, tree, idea.entry_conditions, cctx)

        // The monitor's own floor, so the edge read predicts real monitor behaviour rather than
        // some other definition of "recently".
        const floorAt = idea.entryFloorAt ?? idea.savedAt ?? null

        const edge  = await evaluateTree(tree, symbolMap, asset, floorAt, [], [], volCtx, { requireHeld: true })
        const state = await evaluateTree(tree, symbolMap, asset, null,   [], [], volCtx, { stateLevel: true })

        const alreadySatisfied = !!(state.triggered && !edge.triggered)
        const close = candles.at(-1)?.c ?? null

        if (alreadySatisfied) {
            logger.info(LOG, `[${id}] entry level already held but not a fresh rising edge (close=${close}) — prompting user`)
        }
        return { alreadySatisfied, close }
    } catch (err) {
        logger.warn(LOG, `check failed for ${idea?.id}:`, err.message)
        return { alreadySatisfied: false }
    }
}

/**
 * Every leaf is a structured (price / indicator-math) leaf — no chart, news, touch, time or volume
 * leaves anywhere in the tree. An empty or malformed node is false, so the caller skips rather than
 * guesses. Pure.
 */
export function _isStructuredOnly(node) {
    if (!node || typeof node !== 'object') return false
    if (typeof node.condition === 'string') {
        const type = node.type ?? 'structured'
        return type === 'structured'
    }
    if (!Array.isArray(node.children) || node.children.length === 0) return false
    return node.children.every(_isStructuredOnly)
}
