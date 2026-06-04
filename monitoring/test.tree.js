/**
 * Condition tree smoke tests.
 * Run from the backend root:
 *
 *   node monitoring/test.tree.js
 *
 * Tests:
 *   A.  evaluateTree — leaf, AND, OR, nested structures, edge cases
 *   B.  tradeIdeas.service — _resolveConditionTree logic (inline)
 *   C.  trade.agent.service — _normalizeTreeNode logic (inline)
 *
 * Requires: dotenv-compatible env, Massive (OHLCV) API key (or warm cache),
 *           Anthropic key (condition parser — 2 calls, cached within process).
 */

import 'dotenv/config'
import { getCandles }    from '../providers/ohlcv.provider.js'
import { evaluateTree, evaluateConditions } from './monitor.orchestrator.js'

const SYMBOL = 'AAPL'
const TF     = 'day'

let pass = 0
let fail = 0

const ok   = (label)    => { pass++; console.log(`  ✅  ${label}`) }
const err  = (label, e) => { fail++; console.log(`  ❌  ${label}${e ? ': ' + (e?.message ?? e) : ''}`) }
const skip = (label)    => console.log(`  ⏭   ${label}`)
const h    = (title)    => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`)

// ── Always-true / always-false leaf nodes ──────────────────────────────────────
// close > 0 is trivially true for any real stock; close < 0 is trivially false.
const TRUE_LEAF  = { condition: 'close > 0',    type: 'structured', timeframe: TF }
const FALSE_LEAF = { condition: 'close < 0',    type: 'structured', timeframe: TF }

// ─── 0. Fetch candles ─────────────────────────────────────────────────────────

h('0. Fetch candles')
let candles = []
try {
    candles = await getCandles(SYMBOL, TF, 60)
    if (candles.length === 0) throw new Error('empty result')
    ok(`${candles.length} candles for ${SYMBOL}/${TF}  (last close: ${candles.at(-1).c})`)
} catch (e) {
    err('getCandles', e)
    console.log('\n⚠  No candles — tree evaluation tests will be skipped.\n')
}

// ─── A. evaluateTree ──────────────────────────────────────────────────────────

h('A1. Leaf node — trivially TRUE')
if (candles.length) {
    try {
        const { triggered } = await evaluateTree(TRUE_LEAF, candles, SYMBOL)
        triggered ? ok('leaf true → triggered') : err('leaf true → NOT triggered (unexpected)')
    } catch (e) { err('leaf true', e) }
} else skip('no candles')

h('A2. Leaf node — trivially FALSE')
if (candles.length) {
    try {
        const { triggered } = await evaluateTree(FALSE_LEAF, candles, SYMBOL)
        !triggered ? ok('leaf false → not triggered') : err('leaf false → TRIGGERED (unexpected)')
    } catch (e) { err('leaf false', e) }
} else skip('no candles')

h('A3. AND group — both pass (T AND T) → triggered')
if (candles.length) {
    try {
        const node = { operator: 'AND', children: [TRUE_LEAF, TRUE_LEAF] }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        triggered ? ok('AND(T,T) → triggered') : err('AND(T,T) → NOT triggered (unexpected)')
    } catch (e) { err('AND(T,T)', e) }
} else skip('no candles')

h('A4. AND group — second fails (T AND F) → not triggered')
if (candles.length) {
    try {
        const node = { operator: 'AND', children: [TRUE_LEAF, FALSE_LEAF] }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        !triggered ? ok('AND(T,F) → not triggered') : err('AND(T,F) → TRIGGERED (unexpected)')
    } catch (e) { err('AND(T,F)', e) }
} else skip('no candles')

h('A5. AND group — first fails (F AND T) → not triggered (short-circuit)')
if (candles.length) {
    try {
        const node = { operator: 'AND', children: [FALSE_LEAF, TRUE_LEAF] }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        !triggered ? ok('AND(F,T) → not triggered') : err('AND(F,T) → TRIGGERED (unexpected)')
    } catch (e) { err('AND(F,T)', e) }
} else skip('no candles')

h('A6. OR group — both fail (F OR F) → not triggered')
if (candles.length) {
    try {
        const node = { operator: 'OR', children: [FALSE_LEAF, FALSE_LEAF] }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        !triggered ? ok('OR(F,F) → not triggered') : err('OR(F,F) → TRIGGERED (unexpected)')
    } catch (e) { err('OR(F,F)', e) }
} else skip('no candles')

h('A7. OR group — second passes (F OR T) → triggered')
if (candles.length) {
    try {
        const node = { operator: 'OR', children: [FALSE_LEAF, TRUE_LEAF] }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        triggered ? ok('OR(F,T) → triggered') : err('OR(F,T) → NOT triggered (unexpected)')
    } catch (e) { err('OR(F,T)', e) }
} else skip('no candles')

h('A8. OR group — first passes (T OR F) → triggered')
if (candles.length) {
    try {
        const node = { operator: 'OR', children: [TRUE_LEAF, FALSE_LEAF] }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        triggered ? ok('OR(T,F) → triggered') : err('OR(T,F) → NOT triggered (unexpected)')
    } catch (e) { err('OR(T,F)', e) }
} else skip('no candles')

// Nested trees
h('A9. Nested AND( T, OR(F, T) ) → triggered')
if (candles.length) {
    try {
        const node = {
            operator: 'AND', children: [
                TRUE_LEAF,
                { operator: 'OR', children: [FALSE_LEAF, TRUE_LEAF] },
            ],
        }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        triggered ? ok('AND(T, OR(F,T)) → triggered') : err('AND(T, OR(F,T)) → NOT triggered (unexpected)')
    } catch (e) { err('AND(T, OR(F,T))', e) }
} else skip('no candles')

h('A10. Nested AND( T, OR(F, F) ) → not triggered')
if (candles.length) {
    try {
        const node = {
            operator: 'AND', children: [
                TRUE_LEAF,
                { operator: 'OR', children: [FALSE_LEAF, FALSE_LEAF] },
            ],
        }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        !triggered ? ok('AND(T, OR(F,F)) → not triggered') : err('AND(T, OR(F,F)) → TRIGGERED (unexpected)')
    } catch (e) { err('AND(T, OR(F,F))', e) }
} else skip('no candles')

h('A11. Nested OR( AND(T, F), T ) → triggered')
if (candles.length) {
    try {
        const node = {
            operator: 'OR', children: [
                { operator: 'AND', children: [TRUE_LEAF, FALSE_LEAF] },
                TRUE_LEAF,
            ],
        }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        triggered ? ok('OR(AND(T,F), T) → triggered') : err('OR(AND(T,F), T) → NOT triggered (unexpected)')
    } catch (e) { err('OR(AND(T,F), T)', e) }
} else skip('no candles')

h('A12. Nested OR( AND(T, F), F ) → not triggered')
if (candles.length) {
    try {
        const node = {
            operator: 'OR', children: [
                { operator: 'AND', children: [TRUE_LEAF, FALSE_LEAF] },
                FALSE_LEAF,
            ],
        }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        !triggered ? ok('OR(AND(T,F), F) → not triggered') : err('OR(AND(T,F), F) → TRIGGERED (unexpected)')
    } catch (e) { err('OR(AND(T,F), F)', e) }
} else skip('no candles')

h('A13. Deep nesting: AND( OR(T,F), AND(T, OR(F,T)) ) → triggered')
if (candles.length) {
    try {
        const node = {
            operator: 'AND', children: [
                { operator: 'OR',  children: [TRUE_LEAF, FALSE_LEAF] },
                { operator: 'AND', children: [
                    TRUE_LEAF,
                    { operator: 'OR', children: [FALSE_LEAF, TRUE_LEAF] },
                ]},
            ],
        }
        const { triggered } = await evaluateTree(node, candles, SYMBOL)
        triggered ? ok('deep nested → triggered') : err('deep nested → NOT triggered (unexpected)')
    } catch (e) { err('deep nested', e) }
} else skip('no candles')

// Edge cases
h('A14. Edge cases — null / undefined / empty group')
try {
    const r1 = await evaluateTree(null, candles, SYMBOL)
    !r1.triggered ? ok('null → not triggered') : err('null → TRIGGERED (unexpected)')
} catch (e) { err('null input', e) }

try {
    const r2 = await evaluateTree(undefined, candles, SYMBOL)
    !r2.triggered ? ok('undefined → not triggered') : err('undefined → TRIGGERED (unexpected)')
} catch (e) { err('undefined input', e) }

try {
    const r3 = await evaluateTree({ operator: 'AND', children: [] }, candles, SYMBOL)
    !r3.triggered ? ok('empty AND group → not triggered') : err('empty AND group → TRIGGERED (unexpected)')
} catch (e) { err('empty group', e) }

try {
    const r4 = await evaluateTree({ operator: 'OR', children: [] }, candles, SYMBOL)
    !r4.triggered ? ok('empty OR group → not triggered') : err('empty OR group → TRIGGERED (unexpected)')
} catch (e) { err('empty group', e) }

// ─── B. Backward compat: evaluateConditions still works ───────────────────────

h('B. Legacy evaluateConditions still works')
if (candles.length) {
    try {
        const conds = [
            { condition: 'close > 0', type: 'structured' },
            { condition: 'close > 0', type: 'structured' },
        ]
        const { triggered } = await evaluateConditions(conds, 'AND', candles, SYMBOL)
        triggered ? ok('AND [close>0, close>0] → triggered') : err('legacy AND', 'unexpectedly false')
    } catch (e) { err('legacy AND', e) }

    try {
        const conds = [
            { condition: 'close < 0', type: 'structured' },
            { condition: 'close > 0', type: 'structured' },
        ]
        const { triggered } = await evaluateConditions(conds, 'OR', candles, SYMBOL)
        triggered ? ok('OR [false, true] → triggered') : err('legacy OR', 'unexpectedly false')
    } catch (e) { err('legacy OR', e) }
} else skip('no candles')

// ─── C. _resolveConditionTree logic (inline, no DB needed) ────────────────────
//
// Mirrors the logic in tradeIdeas.service.js — test it without importing private fn.

h('C. _resolveConditionTree logic (inline)')

function _resolveConditionTree(treeNode, flatArray, defaultOperator = 'AND') {
    if (treeNode && typeof treeNode === 'object' && !Array.isArray(treeNode)) {
        if (treeNode.operator && Array.isArray(treeNode.children) && treeNode.children.length > 0)
            return treeNode
        if (typeof treeNode.condition === 'string')
            return { operator: defaultOperator, children: [treeNode] }
        if (Array.isArray(treeNode.conditions) && treeNode.conditions.length > 0)
            return { operator: treeNode.logic ?? defaultOperator, children: treeNode.conditions }
    }
    if (Array.isArray(flatArray) && flatArray.length > 0)
        return { operator: defaultOperator, children: flatArray }
    return null
}

function _extractLeaves(node) {
    if (!node) return []
    if (typeof node.condition === 'string') return [node]
    if (Array.isArray(node.children)) return node.children.flatMap(_extractLeaves)
    return []
}

// C1: new tree group → pass through
{
    const input = { operator: 'AND', children: [TRUE_LEAF, FALSE_LEAF] }
    const result = _resolveConditionTree(input, null)
    const ok_ = result?.operator === 'AND' && result.children.length === 2
    ok_ ? ok('tree group passthrough') : err('tree group passthrough', 'wrong result: ' + JSON.stringify(result))
}

// C2: bare leaf → wrapped in group
{
    const input = { condition: 'close > 0', type: 'structured', timeframe: 'day' }
    const result = _resolveConditionTree(input, null, 'OR')
    const ok_ = result?.operator === 'OR' && result.children.length === 1 && result.children[0].condition === 'close > 0'
    ok_ ? ok('bare leaf → wrapped') : err('bare leaf wrap', 'wrong result: ' + JSON.stringify(result))
}

// C3: old { logic, conditions } format → migrated
{
    const input = { logic: 'OR', conditions: [TRUE_LEAF, FALSE_LEAF] }
    const result = _resolveConditionTree(input, null)
    const ok_ = result?.operator === 'OR' && result.children.length === 2
    ok_ ? ok('old {logic,conditions} → migrated to {operator,children}') : err('legacy migration', 'wrong: ' + JSON.stringify(result))
}

// C4: legacy flat array fallback
{
    const result = _resolveConditionTree(null, [TRUE_LEAF, FALSE_LEAF], 'AND')
    const ok_ = result?.operator === 'AND' && result.children.length === 2
    ok_ ? ok('flat array fallback → wrapped in group') : err('flat array fallback', 'wrong: ' + JSON.stringify(result))
}

// C5: null input → returns null
{
    const result = _resolveConditionTree(null, null)
    result === null ? ok('null,null → null (no conditions)') : err('null,null', 'expected null, got: ' + JSON.stringify(result))
}

// C6: _extractLeaves from nested tree
{
    const tree = {
        operator: 'AND', children: [
            TRUE_LEAF,
            { operator: 'OR', children: [FALSE_LEAF, TRUE_LEAF] },
        ]
    }
    const leaves = _extractLeaves(tree)
    leaves.length === 3 ? ok(`_extractLeaves: ${leaves.length} leaves from nested tree`) : err('_extractLeaves', `expected 3, got ${leaves.length}`)
}

// ─── D. _normalizeTreeNode logic (inline) ─────────────────────────────────────

h('D. _normalizeTreeNode logic (inline)')

const _VALID_TF = new Set(['5min','15min','30min','1hr','2hr','4hr','day','week','month'])
const _TF_REMAP = [
    [/^(\d+)\s*m(?:in)?$/i,           (_, n) => `${n}min`],
    [/^(\d+)\s*h(?:r|ours?)?$/i,      (_, n) => `${n}hr`],
    [/^daily$/i,   () => 'day'],
    [/^weekly$/i,  () => 'week'],
    [/^monthly$/i, () => 'month'],
]
function _normalizeTf(tf) {
    if (!tf || typeof tf !== 'string') return null
    const s = tf.trim()
    if (_VALID_TF.has(s)) return s
    for (const [re, fn] of _TF_REMAP) {
        const m = s.match(re)
        if (m) return fn(...m)
    }
    return s
}

function _normalizeTreeNode(node, defaultTf) {
    if (!node || typeof node !== 'object') return node
    if (typeof node.condition === 'string')
        return { ...node, timeframe: _normalizeTf(node.timeframe) || defaultTf || null }
    if (node.operator && Array.isArray(node.children))
        return { operator: node.operator, children: node.children.map(c => _normalizeTreeNode(c, defaultTf)) }
    if (Array.isArray(node.conditions))
        return { operator: node.logic ?? 'AND', children: node.conditions.map(c => _normalizeTreeNode(c, defaultTf)) }
    return node
}

// D1: leaf timeframe normalisation ("4h" → "4hr")
{
    const leaf = { condition: 'close > 100', type: 'structured', timeframe: '4h' }
    const result = _normalizeTreeNode(leaf, 'day')
    result.timeframe === '4hr' ? ok('"4h" → "4hr"') : err('tf norm 4h', `got ${result.timeframe}`)
}

// D2: leaf missing timeframe fills from defaultTf
{
    const leaf = { condition: 'close > 100', type: 'structured', timeframe: null }
    const result = _normalizeTreeNode(leaf, '15min')
    result.timeframe === '15min' ? ok('null tf → filled from default "15min"') : err('tf default fill', `got ${result.timeframe}`)
}

// D3: group normalises all leaves
{
    const tree = {
        operator: 'AND', children: [
            { condition: 'close > 100', type: 'structured', timeframe: '1h' },
            { condition: 'RSI > 50',    type: 'structured', timeframe: '4 hours' },
        ]
    }
    const result = _normalizeTreeNode(tree, 'day')
    const tfs = result.children.map(c => c.timeframe)
    const allOk = tfs[0] === '1hr' && tfs[1] === '4hr'
    allOk ? ok(`group normalised tfs: ${tfs.join(', ')}`) : err('group tf norm', `got ${tfs.join(', ')}`)
}

// D4: old {logic,conditions} format migrated
{
    const node = {
        logic: 'OR',
        conditions: [
            { condition: 'close > 100', type: 'structured', timeframe: 'daily' },
        ]
    }
    const result = _normalizeTreeNode(node, null)
    const ok_ = result.operator === 'OR' && result.children[0].timeframe === 'day'
    ok_ ? ok('old {logic,conditions} migrated + "daily" → "day"') : err('old format migration', JSON.stringify(result))
}

// D5: nested tree — default tf propagates to leaves with no timeframe
{
    const tree = {
        operator: 'AND', children: [
            { condition: 'price above 100', type: 'structured', timeframe: null },
            { operator: 'OR', children: [
                { condition: 'bull flag', type: 'visual',      timeframe: null },
                { condition: 'good news', type: 'news',        timeframe: '15m' },
            ]},
        ]
    }
    const result = _normalizeTreeNode(tree, '4hr')
    const leaf0   = result.children[0].timeframe
    const leaf1   = result.children[1].children[0].timeframe
    const leaf2   = result.children[1].children[1].timeframe
    const allOk   = leaf0 === '4hr' && leaf1 === '4hr' && leaf2 === '15min'
    allOk ? ok(`nested default fill: ${leaf0}, ${leaf1}, ${leaf2}`) : err('nested tf fill', `${leaf0}, ${leaf1}, ${leaf2}`)
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n── Summary ${'─'.repeat(43)}`)
console.log(`   ✅  ${pass} passed    ❌  ${fail} failed\n`)
if (fail > 0) process.exit(1)
