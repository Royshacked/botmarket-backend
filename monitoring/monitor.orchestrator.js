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
 * @param {object}        node           Root node of the condition tree
 * @param {object}        symbolMap      Map of symbol → Candle[] (newest-last)
 * @param {string}        defaultSymbol  The traded asset — used when a leaf has no explicit symbol
 * @param {number|null}   activatedAt    ms timestamp when idea switched to looking
 * @param {string[]}      priorFindings  structured conditions that passed earlier in the same AND gate
 * @returns {Promise<{ triggered: boolean, which?: string, finding?: string }>}
 */
export async function evaluateTree(node, symbolMap, defaultSymbol, activatedAt = null, priorFindings = []) {
    if (!node || typeof node !== 'object') return { triggered: false }

    // ── Leaf node ────────────────────────────────────────────────────────────
    if (typeof node.condition === 'string') {
        const result = await _evalOne(node, symbolMap, defaultSymbol, activatedAt, priorFindings)
        logger.info(LOG, `  ${result.pass ? '✓' : '✗'} [${node.type ?? 'structured'}] "${node.condition?.slice(0, 60)}"${node.symbol ? ` (${node.symbol})` : ''}`)
        const isStructured = !node.type || node.type === 'structured'
        return {
            triggered: result.pass,
            which:     node.condition,
            finding:   isStructured && result.pass ? node.condition : null,
        }
    }

    // ── Group node ────────────────────────────────────────────────────────────
    const { operator, children } = node
    if (!Array.isArray(children) || children.length === 0) return { triggered: false }

    if (operator === 'OR') {
        // Sort cheapest first so structured/indicator run before chart/news.
        // In OR branches the chart gets activatedAt constraint but no prior findings
        // (OR branches are independent — no structured condition "caused" the chart).
        const sortedOR = [...children].sort((a, b) => _nodeCost(a) - _nodeCost(b))
        for (const child of sortedOR) {
            const result = await evaluateTree(child, symbolMap, defaultSymbol, activatedAt, [])
            if (result.triggered) {
                logger.info(LOG, `  ✅ OR group triggered: "${(result.which ?? '').slice(0, 60)}"`)
                return result
            }
        }
        logger.info(LOG, `  💤 OR group: no child triggered (${children.length} checked)`)
        return { triggered: false }
    }

    // AND — sequential, sort children cheapest first.
    // Accumulate findings from passing structured nodes and pass them forward
    // so chart nodes see what triggered before them.
    const sorted = [...children].sort((a, b) => _nodeCost(a) - _nodeCost(b))
    const accumulated = [...priorFindings]
    for (let i = 0; i < sorted.length; i++) {
        const result = await evaluateTree(sorted[i], symbolMap, defaultSymbol, activatedAt, accumulated)
        if (!result.triggered) {
            logger.info(LOG, `  ✗ AND group failed at child ${i + 1}/${sorted.length}`)
            return { triggered: false }
        }
        if (result.finding) accumulated.push(result.finding)
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
 * @param {object}      symbolMap     Map of symbol → Candle[]
 * @param {string}      defaultSymbol The traded asset
 * @param {number|null} activatedAt   ms timestamp when idea switched to looking
 * @returns {Promise<{ triggered: boolean, which?: string }>}
 */
export async function evaluateConditions(conditions, logic, symbolMap, defaultSymbol, activatedAt = null) {
    if (!Array.isArray(conditions) || conditions.length === 0) {
        return { triggered: false }
    }

    return logic === 'OR'
        ? _evalOR(conditions, symbolMap, defaultSymbol, activatedAt)
        : _evalAND(conditions, symbolMap, defaultSymbol, activatedAt)
}

// ─── AND: sequential gate-then-verify ─────────────────────────────────────────

async function _evalAND(conditions, symbolMap, defaultSymbol, activatedAt) {
    const sorted = [...conditions].sort(
        (a, b) => (COST[a.type] ?? 0) - (COST[b.type] ?? 0)
    )

    let passed = 0
    const priorFindings = []
    for (const cond of sorted) {
        const result = await _evalOne(cond, symbolMap, defaultSymbol, activatedAt, priorFindings)
        const label  = result.condition?.slice(0, 60) ?? '(malformed)'
        const type   = typeof cond === 'string' ? 'structured' : (cond?.type ?? 'unknown')

        if (result.pass) {
            passed++
            logger.info(LOG, `  ✓ [${type}] "${label}"`)
            if (type === 'structured' && result.condition) priorFindings.push(result.condition)
        } else {
            logger.info(LOG, `  ✗ [${type}] "${label}" — AND gate failed (${passed}/${sorted.length} passed)`)
            return { triggered: false }
        }
    }

    logger.info(LOG, `  ✅ AND gate passed — all ${sorted.length} condition(s) met`)
    return { triggered: true }
}

// ─── OR: sequential, short-circuit on first true ─────────────────────────────

async function _evalOR(conditions, symbolMap, defaultSymbol, activatedAt) {
    const sorted = [...conditions].sort(
        (a, b) => (COST[a?.type] ?? 0) - (COST[b?.type] ?? 0)
    )
    for (const cond of sorted) {
        // OR branches are independent — chart gets activatedAt but no prior findings
        const result = await _evalOne(cond, symbolMap, defaultSymbol, activatedAt, [])
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

async function _evalOne(cond, symbolMap, defaultSymbol, activatedAt = null, priorFindings = []) {
    const conditionText = typeof cond === 'string' ? cond : cond?.condition
    const type          = typeof cond === 'string' ? 'structured' : (cond?.type ?? 'structured')

    if (!conditionText || typeof conditionText !== 'string' || !conditionText.trim()) {
        logger.warn(LOG, 'Skipping malformed condition (empty or missing text):', JSON.stringify(cond))
        return { pass: false, condition: conditionText }
    }

    // Resolve the symbol and candles for this leaf.
    // A leaf with no .symbol uses the traded asset; a cross-asset leaf names its own symbol.
    const leafSymbol = cond?.symbol ?? defaultSymbol
    const candles    = symbolMap[leafSymbol] ?? symbolMap[defaultSymbol] ?? []

    if (cond?.symbol && cond.symbol !== defaultSymbol && candles.length === 0) {
        logger.warn(LOG, `[cross-asset] No candles for "${leafSymbol}" — treating condition as false: "${conditionText.slice(0, 60)}"`)
        return { pass: false, condition: conditionText }
    }

    try {
        if (type === 'indicator' || type === 'visual') {
            const pass = await evaluateIndicator(conditionText, candles)
            return { pass, condition: conditionText }
        }

        if (type === 'chart') {
            const pass = await evaluateChart(conditionText, leafSymbol, cond?.timeframe ?? null, activatedAt, priorFindings)
            return { pass, condition: conditionText }
        }

        if (type === 'news') {
            const pass = await evaluateNews(conditionText, leafSymbol)
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
