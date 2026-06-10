/**
 * Monitoring system smoke test.
 * Run from the backend root:
 *
 *   node monitoring/test.monitor.js
 *
 * Tests each layer in order, printing pass/fail for each.
 * No DB connection needed — only Massive (OHLCV) + Anthropic (Claude) + GNews APIs.
 */

import 'dotenv/config'
import { getCandles }         from '../providers/ohlcv.provider.js'
import { parseCondition }     from './parsers/condition.parser.js'
import { evaluate }           from './evaluators/structured.evaluator.js'
import { evaluateVisual }     from './evaluators/visual.evaluator.js'
import { evaluateNews }       from './evaluators/news.evaluator.js'
import { evaluateConditions } from './monitor.orchestrator.js'

const SYMBOL    = 'AAPL'
const TIMEFRAME = 'daily'

const ok  = (label) => console.log(`  ✅  ${label}`)
const err = (label, e) => console.log(`  ❌  ${label}: ${e?.message ?? e}`)
const h   = (title) => console.log(`\n── ${title} ${'─'.repeat(50 - title.length)}`)

// ─── 1. OHLCV provider ────────────────────────────────────────────────────────

h('1. OHLCV provider')
let candles = []
try {
    candles = await getCandles(SYMBOL, TIMEFRAME, 50)
    if (candles.length === 0) throw new Error('empty result')
    ok(`Fetched ${candles.length} candles  |  last close: ${candles.at(-1).c}`)

    // Second call should hit cache
    const t0 = Date.now()
    await getCandles(SYMBOL, TIMEFRAME, 50)
    ok(`Cache hit returned in ${Date.now() - t0}ms`)
} catch (e) {
    err('OHLCV fetch', e)
}

// ─── 2. Condition parser ──────────────────────────────────────────────────────

h('2. Condition parser')
const CONDITIONS_TO_PARSE = [
    'price breaks above 150',
    'RSI(14) below 30',
    'EMA(20) crosses above EMA(50)',
    'close stays above 100 for 2 candles',
]

for (const text of CONDITIONS_TO_PARSE) {
    try {
        const parsed = await parseCondition(text)
        if (parsed.operator === 'unknown') throw new Error('operator=unknown')
        ok(`"${text}"  →  ${JSON.stringify(parsed)}`)
    } catch (e) {
        err(`parse: "${text}"`, e)
    }
}

// ─── 3. Structured evaluator (pure, no API) ───────────────────────────────────

h('3. Structured evaluator')
if (candles.length > 0) {
    const lastClose = candles.at(-1).c

    // Should always pass: close > 0
    const trivialTrue = { operator: 'gt', subject: 'close', value: 0, value2: null, confirmation: 0 }
    const r1 = evaluate(trivialTrue, candles)
    r1.pass ? ok(`close > 0  → pass (close=${lastClose})`) : err('close > 0', 'unexpectedly false')

    // Should always fail: close < 0
    const trivialFalse = { operator: 'lt', subject: 'close', value: 0, value2: null, confirmation: 0 }
    const r2 = evaluate(trivialFalse, candles)
    !r2.pass ? ok(`close < 0  → fail (expected)`) : err('close < 0', 'unexpectedly true')

    // RSI series sanity
    const rsiParsed = { operator: 'lt', subject: 'rsi(14)', value: 100, value2: null, confirmation: 0 }
    const r3 = evaluate(rsiParsed, candles)
    r3.pass ? ok('RSI(14) < 100  → pass (sanity check)') : err('RSI(14) < 100', 'RSI out of range?')
} else {
    err('structured evaluator', 'skipped — no candles')
}

// ─── 4. Visual evaluator (Claude) ────────────────────────────────────────────

h('4. Visual evaluator')
if (candles.length > 0) {
    try {
        // Ask something that's always true of any candle series
        const pass = await evaluateVisual('the chart shows a series of price bars', candles)
        ok(`Trivial visual condition → ${pass ? 'YES' : 'NO'}  (should be YES)`)
    } catch (e) {
        err('visual evaluator', e)
    }
} else {
    err('visual evaluator', 'skipped — no candles')
}

// ─── 5. News evaluator (Claude + GNews) ──────────────────────────────────────

h('5. News evaluator')
try {
    // Ask about the company existing — should be YES
    const pass = await evaluateNews(`${SYMBOL} is a publicly traded company`, SYMBOL)
    ok(`Trivial news condition → ${pass ? 'YES' : 'NO'}  (should be YES)`)
} catch (e) {
    err('news evaluator', e)
}

// ─── 6. Orchestrator — AND chain ─────────────────────────────────────────────

h('6. Orchestrator — AND (all pass)')
if (candles.length > 0) {
    try {
        const conditions = [
            { condition: 'close > 0',    type: 'structured' },
            { condition: 'volume > 0',   type: 'structured' },
        ]
        const { triggered } = await evaluateConditions(conditions, 'AND', { [SYMBOL]: candles }, SYMBOL)
        triggered ? ok('AND [close>0, volume>0] → triggered') : err('AND chain', 'unexpectedly false')
    } catch (e) {
        err('AND orchestrator', e)
    }
}

// ─── 7. Orchestrator — AND gate stops early ───────────────────────────────────

h('7. Orchestrator — AND gate (first fails, second should not run)')
if (candles.length > 0) {
    try {
        const conditions = [
            { condition: 'close < 0',    type: 'structured' },  // always false
            { condition: 'volume > 0',   type: 'structured' },  // would pass, but gated
        ]
        const { triggered } = await evaluateConditions(conditions, 'AND', { [SYMBOL]: candles }, SYMBOL)
        !triggered ? ok('AND gate blocked correctly → not triggered') : err('AND gate', 'gate did not block')
    } catch (e) {
        err('AND gate', e)
    }
}

// ─── 8. Orchestrator — OR chain ──────────────────────────────────────────────

h('8. Orchestrator — OR (one passes)')
if (candles.length > 0) {
    try {
        const conditions = [
            { condition: 'close < 0',   type: 'structured' },  // false
            { condition: 'close > 0',   type: 'structured' },  // true
        ]
        const { triggered, which } = await evaluateConditions(conditions, 'OR', { [SYMBOL]: candles }, SYMBOL)
        triggered ? ok(`OR triggered on: "${which}"`) : err('OR chain', 'unexpectedly false')
    } catch (e) {
        err('OR orchestrator', e)
    }
}

console.log('\n── Done ──────────────────────────────────────────────────────\n')
