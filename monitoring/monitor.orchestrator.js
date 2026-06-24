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
import { evaluateTouch }       from './evaluators/touch.evaluator.js'
import { evaluateIndicator }   from './evaluators/indicator.evaluator.js'
import { evaluateChart }       from './evaluators/chart.evaluator.js'
import { evaluateNews }        from './evaluators/news.evaluator.js'
import { evaluateTime }        from './evaluators/time.evaluator.js'
import { evaluateVolume }      from './evaluators/volume.evaluator.js'
import { logger }              from '../services/logger.service.js'

const LOG = '[monitor.orchestrator]'

// Evaluation cost — determines gate order for AND/OR chains (cheapest first).
// touch/structured/time/volume are cheap local math; indicator/news/chart need model reads.
const COST = { time: -1, touch: 0, structured: 0, volume: 0, indicator: 1, news: 2, chart: 3 }

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
 * @param {number|null}   floorAt        ms timestamp; only events at/after this count (entry: entryFloorAt ?? savedAt)
 * @param {string[]}      priorFindings  structured conditions that passed earlier in the same AND gate
 * @param {object|null}   ctx            cumulative-volume context { sessionStartMs, minuteCandles } (see volume.evaluator)
 * @returns {Promise<{ triggered: boolean, which?: string, finding?: string, triggerAt?: number|null }>}
 */
export async function evaluateTree(node, symbolMap, defaultSymbol, floorAt = null, priorFindings = [], out = null, ctx = null) {
    if (!node || typeof node !== 'object') return { triggered: false }

    // ── Leaf node ────────────────────────────────────────────────────────────
    if (typeof node.condition === 'string') {
        const result = await _evalOne(node, symbolMap, defaultSymbol, floorAt, priorFindings, ctx)
        logger.info(LOG, `  ${result.pass ? '✓' : '✗'} [${node.type ?? 'structured'}] "${node.condition?.slice(0, 60)}"${node.symbol ? ` (${node.symbol})` : ''}`)
        // Record this leaf's evaluated state so the UI can mark met conditions. Only
        // leaves actually reached are recorded (short-circuited siblings are not).
        if (out) out.push({ key: leafStateKey(node), pass: !!result.pass, at: result.pass ? (result.triggerAt ?? Date.now()) : null })
        // Price findings (structured comparisons + touches) feed an AND group's chart
        // node as context for what already happened before it.
        const isPriceLeaf = !node.type || node.type === 'structured' || node.type === 'touch'
        return {
            triggered: result.pass,
            which:     node.condition,
            finding:   isPriceLeaf && result.pass ? node.condition : null,
            triggerAt: result.triggerAt ?? null,
        }
    }

    // ── Group node ────────────────────────────────────────────────────────────
    const { operator, children } = node
    if (!Array.isArray(children) || children.length === 0) return { triggered: false }

    if (operator === 'OR') {
        // Sort cheapest first so structured/indicator run before chart/news.
        // In OR branches the chart gets the floorAt constraint but no prior findings
        // (OR branches are independent — no structured condition "caused" the chart).
        const sortedOR = [...children].sort((a, b) => _nodeCost(a) - _nodeCost(b))
        for (const child of sortedOR) {
            const result = await evaluateTree(child, symbolMap, defaultSymbol, floorAt, [], out, ctx)
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
    // so chart nodes see what triggered before them. The gate's triggerAt is the
    // *latest* child trigger — the moment the whole AND became true.
    const sorted = [...children].sort((a, b) => _nodeCost(a) - _nodeCost(b))
    const accumulated = [...priorFindings]
    let triggerAt = null
    for (let i = 0; i < sorted.length; i++) {
        const result = await evaluateTree(sorted[i], symbolMap, defaultSymbol, floorAt, accumulated, out, ctx)
        if (!result.triggered) {
            logger.info(LOG, `  ✗ AND group failed at child ${i + 1}/${sorted.length}`)
            return { triggered: false }
        }
        if (result.finding) accumulated.push(result.finding)
        if (result.triggerAt != null) triggerAt = triggerAt == null ? result.triggerAt : Math.max(triggerAt, result.triggerAt)
    }
    logger.info(LOG, `  ✅ AND group: all ${sorted.length} child(ren) passed`)
    return { triggered: true, triggerAt }
}

/**
 * True when a phase's time leaves make it impossible to trigger *right now*,
 * regardless of price/indicator/news data — so the caller can skip fetching
 * candles this tick. Evaluates the tree optimistically: every non-time leaf is
 * assumed to pass, time leaves use their real wall-clock value. If the tree is
 * still false under that best case, only the clock is to blame → blocked.
 *
 * Cheap and side-effect free. A tree with no time leaves can never be blocked
 * (every leaf is optimistically true), so this is a no-op for those ideas.
 *
 * @param {object|null} node  A normalized condition tree (group or leaf node),
 *                            e.g. from resolveConditionTree().
 */
export function isTimeBlocked(node) {
    if (!node || typeof node !== 'object') return false
    return !_canPassOnTime(node)
}

function _canPassOnTime(node) {
    if (!node || typeof node !== 'object') return true
    if (typeof node.condition === 'string') {
        return node.type === 'time' ? evaluateTime(node) : true
    }
    const children = Array.isArray(node.children) ? node.children
        : Array.isArray(node.conditions) ? node.conditions
        : []
    if (children.length === 0) return true
    const op = node.operator ?? node.logic ?? 'AND'
    return op === 'OR' ? children.some(_canPassOnTime) : children.every(_canPassOnTime)
}

/**
 * Stable identity for a condition leaf, shared with the frontend (ConditionTree.jsx
 * mirrors this) so a persisted met-state keys back to the right chip. Keyed by
 * type + timeframe + condition text — enough to disambiguate sibling leaves.
 */
export function leafStateKey(leaf) {
    return `${leaf?.type ?? 'structured'}|${leaf?.timeframe ?? ''}|${leaf?.condition ?? ''}`
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
 * @param {number|null} floorAt       ms timestamp; only events at/after this count
 * @returns {Promise<{ triggered: boolean, which?: string, triggerAt?: number|null }>}
 */
export async function evaluateConditions(conditions, logic, symbolMap, defaultSymbol, floorAt = null) {
    if (!Array.isArray(conditions) || conditions.length === 0) {
        return { triggered: false }
    }

    return logic === 'OR'
        ? _evalOR(conditions, symbolMap, defaultSymbol, floorAt)
        : _evalAND(conditions, symbolMap, defaultSymbol, floorAt)
}

// ─── AND: sequential gate-then-verify ─────────────────────────────────────────

async function _evalAND(conditions, symbolMap, defaultSymbol, floorAt) {
    const sorted = [...conditions].sort(
        (a, b) => (COST[a.type] ?? 0) - (COST[b.type] ?? 0)
    )

    let passed = 0
    let triggerAt = null
    const priorFindings = []
    for (const cond of sorted) {
        const result = await _evalOne(cond, symbolMap, defaultSymbol, floorAt, priorFindings)
        const label  = result.condition?.slice(0, 60) ?? '(malformed)'
        const type   = typeof cond === 'string' ? 'structured' : (cond?.type ?? 'unknown')

        if (result.pass) {
            passed++
            logger.info(LOG, `  ✓ [${type}] "${label}"`)
            if (type === 'structured' && result.condition) priorFindings.push(result.condition)
            if (result.triggerAt != null) triggerAt = triggerAt == null ? result.triggerAt : Math.max(triggerAt, result.triggerAt)
        } else {
            logger.info(LOG, `  ✗ [${type}] "${label}" — AND gate failed (${passed}/${sorted.length} passed)`)
            return { triggered: false }
        }
    }

    logger.info(LOG, `  ✅ AND gate passed — all ${sorted.length} condition(s) met`)
    return { triggered: true, triggerAt }
}

// ─── OR: sequential, short-circuit on first true ─────────────────────────────

async function _evalOR(conditions, symbolMap, defaultSymbol, floorAt) {
    const sorted = [...conditions].sort(
        (a, b) => (COST[a?.type] ?? 0) - (COST[b?.type] ?? 0)
    )
    for (const cond of sorted) {
        // OR branches are independent — chart gets floorAt but no prior findings
        const result = await _evalOne(cond, symbolMap, defaultSymbol, floorAt, [])
        const type   = typeof cond === 'string' ? 'structured' : (cond?.type ?? 'unknown')
        const icon   = result.pass ? '✓' : '✗'
        logger.info(LOG, `  ${icon} [${type}] "${result.condition?.slice(0, 60) ?? '(malformed)'}"`)
        if (result.pass) {
            logger.info(LOG, `  ✅ OR gate triggered: "${result.condition?.slice(0, 60)}"`)
            return { triggered: true, which: result.condition, triggerAt: result.triggerAt ?? null }
        }
    }
    logger.info(LOG, `  💤 OR gate: none of ${conditions.length} condition(s) triggered`)
    return { triggered: false }
}

// ─── Single condition evaluation ──────────────────────────────────────────────

async function _evalOne(cond, symbolMap, defaultSymbol, floorAt = null, priorFindings = [], ctx = null) {
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

    // LLM snapshot evaluators read the current state — they can't pin the exact
    // candle an event formed on, so a pass is timestamped "now" (always ≥ floor).
    // Only structured conditions report a precise trigger candle.
    try {
        if (type === 'time') {
            // Wall-clock gate — empty bounds pass (ignored). No candles needed.
            const pass = evaluateTime(cond)
            return { pass, condition: conditionText, triggerAt: pass ? Date.now() : null }
        }

        if (type === 'touch') {
            // Intra-candle price level — precise trigger candle, like structured.
            const parsed = await parseCondition(conditionText)
            const { pass, triggerAt } = evaluateTouch(parsed, candles, floorAt)
            return { pass, condition: conditionText, triggerAt: triggerAt ?? null }
        }

        if (type === 'indicator') {
            const pass = await evaluateIndicator(conditionText, candles)
            return { pass, condition: conditionText, triggerAt: pass ? Date.now() : null }
        }

        if (type === 'chart') {
            const pass = await evaluateChart(conditionText, leafSymbol, cond?.timeframe ?? null, floorAt, priorFindings)
            return { pass, condition: conditionText, triggerAt: pass ? Date.now() : null }
        }

        if (type === 'news') {
            const pass = await evaluateNews(conditionText, leafSymbol)
            return { pass, condition: conditionText, triggerAt: pass ? Date.now() : null }
        }

        if (type === 'volume') {
            // bar mode uses the phase candles; cumulative mode needs 1-min bars +
            // a session start, both carried on ctx (supplied by the monitor).
            const cumulative = cond?.mode === 'cumulative'
            const volCandles = cumulative
                ? (ctx?.minuteCandles?.[leafSymbol] ?? ctx?.minuteCandles?.[defaultSymbol] ?? candles)
                : candles
            const { pass, triggerAt } = await evaluateVolume(cond, volCandles, ctx ?? {}, floorAt)
            return { pass, condition: conditionText, triggerAt: triggerAt ?? null }
        }

        // structured (default) — precise rising-edge timestamp since the floor
        const parsed = await parseCondition(conditionText)
        const { pass, triggerAt } = evaluate(parsed, candles, floorAt)
        return { pass, condition: conditionText, triggerAt: triggerAt ?? null }

    } catch (err) {
        logger.error(LOG, `Error evaluating condition "${conditionText?.slice(0, 60)}":`, err.message)
        return { pass: false, condition: conditionText }
    }
}
