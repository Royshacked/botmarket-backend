/**
 * Condition orchestrator — recursive condition tree evaluator.
 *
 * Tree nodes:
 *   Leaf:  { condition, type, timeframe }
 *   Group: { operator: "AND"|"OR", children: [node, ...] }
 *
 * AND logic:
 *   Children sorted cheapest first (structured → indicator → news → chart).
 *   Short-circuits on first failure.
 *
 * OR logic:
 *   Children sorted cheapest first — short-circuits on first success.
 *
 * Also exports flat-array evaluateConditions() for backward compatibility
 * with legacy ideas that pre-date the tree format.
 */

import { parseCondition }      from './parsers/condition.parser.js'
import { evaluate }            from './evaluators/structured.evaluator.js'
import { evaluateIndicator }   from './evaluators/indicator.evaluator.js'
import { evaluateChart }       from './evaluators/chart.evaluator.js'
import { evaluateNews }        from './evaluators/news.evaluator.js'
import { logger }              from '../services/logger.service.js'

const LOG = '[monitor.orchestrator]'

// Evaluation cost — determines gate order for AND/OR chains (cheapest first)
// 'visual' kept as legacy alias for 'indicator'
const COST = { structured: 0, indicator: 1, visual: 1, news: 2, chart: 3 }

/**
 * Evaluate a condition tree recursively.
 *
 * Each node is either:
 *   Leaf:  { condition: string, type: string, timeframe?: string }
 *   Group: { operator: "AND"|"OR", children: node[] }
 *
 * @param {object}   node     Root node of the condition tree
 * @param {Candle[]} candles  OHLCV array, newest-last
 * @param {string}   symbol   Asset symbol (for news evaluator)
 * @returns {Promise<{ triggered: boolean, which?: string }>}
 */
export async function evaluateTree(node, candles, symbol) {
    if (!node || typeof node !== 'object') return { triggered: false }

    // ── Leaf node ────────────────────────────────────────────────────────────
    if (typeof node.condition === 'string') {
        const result = await _evalOne(node, candles, symbol)
        logger.info(LOG, `  ${result.pass ? '✓' : '✗'} [${node.type ?? 'structured'}] "${node.condition?.slice(0, 60)}"`)
        return { triggered: result.pass, which: node.condition }
    }

    // ── Group node ────────────────────────────────────────────────────────────
    const { operator, children } = node
    if (!Array.isArray(children) || children.length === 0) return { triggered: false }

    if (operator === 'OR') {
        // Sort cheapest first so structured/indicator run before chart/news
        const sortedOR = [...children].sort((a, b) => _nodeCost(a) - _nodeCost(b))
        for (const child of sortedOR) {
            const result = await evaluateTree(child, candles, symbol)
            if (result.triggered) {
                logger.info(LOG, `  ✅ OR group triggered: "${(result.which ?? '').slice(0, 60)}"`)
                return result
            }
        }
        logger.info(LOG, `  💤 OR group: no child triggered (${children.length} checked)`)
        return { triggered: false }
    }

    // AND — sequential, sort children cheapest first
    const sorted = [...children].sort((a, b) => _nodeCost(a) - _nodeCost(b))
    for (let i = 0; i < sorted.length; i++) {
        const result = await evaluateTree(sorted[i], candles, symbol)
        if (!result.triggered) {
            logger.info(LOG, `  ✗ AND group failed at child ${i + 1}/${sorted.length}`)
            return { triggered: false }
        }
    }
    logger.info(LOG, `  ✅ AND group: all ${sorted.length} child(ren) passed`)
    return { triggered: true }
}

/** Estimate evaluation cost for a tree node (used for AND gate ordering). */
function _nodeCost(node) {
    if (!node) return 0
    if (typeof node.condition === 'string') return COST[node.type] ?? 0
    if (Array.isArray(node.children)) return Math.max(0, ...node.children.map(_nodeCost))
    return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy flat-array API (backward compat — used by ideas without a tree)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate a group of conditions with AND or OR logic.
 *
 * @param {Array<{condition: string, type: string}>} conditions
 * @param {'AND'|'OR'}  logic
 * @param {Candle[]}    candles   newest-last
 * @param {string}      symbol    asset symbol (for news evaluator)
 * @returns {Promise<{ triggered: boolean, which?: string }>}
 */
export async function evaluateConditions(conditions, logic, candles, symbol) {
    if (!Array.isArray(conditions) || conditions.length === 0) {
        return { triggered: false }
    }

    return logic === 'OR'
        ? _evalOR(conditions, candles, symbol)
        : _evalAND(conditions, candles, symbol)
}

// ─── AND: sequential gate-then-verify ─────────────────────────────────────────

async function _evalAND(conditions, candles, symbol) {
    // Sort cheapest first so expensive evaluators are only reached when needed
    const sorted = [...conditions].sort(
        (a, b) => (COST[a.type] ?? 0) - (COST[b.type] ?? 0)
    )

    let passed = 0
    for (const cond of sorted) {
        const result = await _evalOne(cond, candles, symbol)
        const label  = result.condition?.slice(0, 60) ?? '(malformed)'
        const type   = typeof cond === 'string' ? 'structured' : (cond?.type ?? 'unknown')

        if (result.pass) {
            passed++
            logger.info(LOG, `  ✓ [${type}] "${label}"`)
        } else {
            logger.info(LOG, `  ✗ [${type}] "${label}" — AND gate failed (${passed}/${sorted.length} passed)`)
            return { triggered: false }
        }
    }

    logger.info(LOG, `  ✅ AND gate passed — all ${sorted.length} condition(s) met`)
    return { triggered: true }
}

// ─── OR: parallel, short-circuit on first true ────────────────────────────────

async function _evalOR(conditions, candles, symbol) {
    // Sequential — stop as soon as the first condition passes (avoids wasteful Claude calls)
    for (const cond of conditions) {
        const result = await _evalOne(cond, candles, symbol)
        const type   = typeof cond === 'string' ? 'structured' : (cond?.type ?? 'unknown')
        const icon   = result.pass ? '✓' : '✗'
        logger.info(LOG, `  ${icon} [${type}] "${result.condition?.slice(0, 60) ?? '(malformed)'}"`)
        if (result.pass) {
            logger.info(LOG, `  ✅ OR gate triggered: "${result.condition?.slice(0, 60)}"`)
            return { triggered: true, which: result.condition }
        }
    }
    logger.info(LOG, `  💤 OR gate: none of ${conditions.length} condition(s) triggered`)
    return { triggered: false }
}

// ─── Single condition evaluation ──────────────────────────────────────────────

async function _evalOne(cond, candles, symbol) {
    // Normalise: handle both legacy plain strings and { condition, type } objects
    const conditionText = typeof cond === 'string' ? cond : cond?.condition
    const type          = typeof cond === 'string' ? 'structured' : (cond?.type ?? 'structured')

    if (!conditionText || typeof conditionText !== 'string' || !conditionText.trim()) {
        logger.warn(LOG, 'Skipping malformed condition (empty or missing text):', JSON.stringify(cond))
        return { pass: false, condition: conditionText }
    }

    try {
        // 'visual' kept as legacy alias for 'indicator'
        if (type === 'indicator' || type === 'visual') {
            const pass = await evaluateIndicator(conditionText, candles)
            return { pass, condition: conditionText }
        }

        if (type === 'chart') {
            const pass = await evaluateChart(conditionText, symbol, cond?.timeframe ?? null)
            return { pass, condition: conditionText }
        }

        if (type === 'news') {
            const pass = await evaluateNews(conditionText, symbol)
            return { pass, condition: conditionText }
        }

        // structured (default)
        const parsed   = await parseCondition(conditionText)
        const { pass } = evaluate(parsed, candles)
        return { pass, condition: conditionText }

    } catch (err) {
        logger.error(LOG, `Error evaluating condition "${conditionText?.slice(0, 60)}":`, err.message)
        return { pass: false, condition: conditionText }
    }
}
