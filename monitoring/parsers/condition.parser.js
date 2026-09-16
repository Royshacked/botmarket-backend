/**
 * Parses natural-language condition strings into executable schema objects.
 *
 * Parsed schema shape:
 * {
 *   operator:     'gt'|'lt'|'gte'|'lte'|'eq'|'crossAbove'|'crossBelow'|'isBetween'|'unknown'
 *   subject:      'close'|'open'|'high'|'low'|'volume'|'vwap'|'rsi(N)'|'ema(N)'|'sma(N)'|
 *                 'macd_line'|'macd_signal'|'macd_hist'|'atr(N)'  (or null)
 *   value:        number | subject-string (compare two indicators) | null
 *   value2:       number | null   (upper bound for 'isBetween')
 *   confirmation: number          (consecutive candles required, 0 = just current candle)
 * }
 *
 * Results are cached in-memory for the process lifetime.
 */

import { claudeJSON } from '../monitor.claude.js'
import { logger }     from '../../services/logger.service.js'

const LOG       = '[condition.parser]'
const _cache    = new Map()   // conditionText (normalised) → ParsedCondition
const CACHE_MAX = 1_000

const SYSTEM = `You parse trading condition strings into a JSON schema. Return ONLY valid JSON.

Fields (all required):
- "operator": "gt"|"lt"|"gte"|"lte"|"eq"|"crossAbove"|"crossBelow"|"isBetween"|"unknown"
- "subject":  "close"|"open"|"high"|"low"|"volume"|"vwap"|"rsi(N)"|"ema(N)"|"sma(N)"|"macd_line"|"macd_signal"|"macd_hist"|"atr(N)" — or null
              ("vwap" = session-anchored VWAP, no period; intraday only)
- "value":    number or subject-string (for indicator vs indicator); null if unknown
- "value2":   number upper bound for isBetween, else null
- "confirmation": consecutive candles required (0 = current only)

Examples:
"price breaks above 100"              → {"operator":"crossAbove","subject":"close","value":100,"value2":null,"confirmation":1}
"RSI(14) below 30"                    → {"operator":"lt","subject":"rsi(14)","value":30,"value2":null,"confirmation":0}
"EMA(20) crosses above EMA(50)"       → {"operator":"crossAbove","subject":"ema(20)","value":"ema(50)","value2":null,"confirmation":0}
"price reclaims VWAP"                  → {"operator":"crossAbove","subject":"close","value":"vwap","value2":null,"confirmation":0}
"closes below VWAP"                    → {"operator":"lt","subject":"close","value":"vwap","value2":null,"confirmation":0}
"close stays above 100 for 3 candles" → {"operator":"gt","subject":"close","value":100,"value2":null,"confirmation":3}
"price between 100 and 110"           → {"operator":"isBetween","subject":"close","value":100,"value2":110,"confirmation":0}
"volume above 1000000"                → {"operator":"gt","subject":"volume","value":1000000,"value2":null,"confirmation":0}

Unknown conditions: set operator "unknown", subject/value null.`

// THE ONE SHAPE THIS APP WRITES ITSELF. protectionPlan.touchLeaf authors `price touches <level>` for
// every ticket stop, target and ladder rung, and until 2026-09-16 that string went to the model to
// get the number back out — in routeExits, which is the ORDER PATH, and in the monitor on every tick
// until the per-process cache warmed. A parse the app can do by reading its own sentence must not
// cost an LLM call, a network round-trip, or an API key: with the key absent the parse "failed",
// the leaf read as `unknown`, and a stop that should have rested at the broker fell to the monitor
// (or, before the toNum guard in _leafBareLevel, rested at zero). Anything the app did not author
// still goes to the model.
const TOUCH_LITERAL = /^\s*price\s+touches\s+(-?\d+(?:\.\d+)?)\s*$/i

/**
 * The deterministic parse of a self-authored touch leaf → ParsedCondition, or null when the text
 * is not that shape. Pure; exported for tests. `eq` on `close` is what the touch evaluator and
 * the broker router both read: they take the LEVEL from `value` and check the subject is a price.
 */
export function parseTouchLiteral(conditionText) {
    const m = typeof conditionText === 'string' ? conditionText.match(TOUCH_LITERAL) : null
    if (!m) return null
    const level = Number(m[1])
    if (!Number.isFinite(level)) return null
    return { operator: 'eq', subject: 'close', value: level, value2: null, confirmation: 0 }
}

/**
 * Parse a natural-language condition string.
 * Cached — subsequent calls with the same text return immediately.
 *
 * @param {string} conditionText
 * @returns {Promise<ParsedCondition>}
 */
export async function parseCondition(conditionText) {
    if (!conditionText || typeof conditionText !== 'string' || !conditionText.trim()) {
        return { operator: 'unknown', subject: null, value: null, value2: null, confirmation: 0 }
    }
    const literal = parseTouchLiteral(conditionText)
    if (literal) return literal

    const key = conditionText.trim().toLowerCase()
    if (_cache.has(key)) return _cache.get(key)

    try {
        const parsed = await claudeJSON(SYSTEM, conditionText)
        _normalise(parsed)
        if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value)
        _cache.set(key, parsed)
        logger.info(LOG, `Parsed: "${conditionText.slice(0, 70)}"`, parsed)
        return parsed
    } catch (err) {
        // Do not cache — transient API errors should be retried on the next tick
        logger.warn(LOG, `Parse failed: "${conditionText.slice(0, 70)}"`, err.message)
        return { operator: 'unknown', subject: null, value: null, value2: null, confirmation: 0 }
    }
}

const VALID_OPS = new Set(['gt','lt','gte','lte','eq','crossAbove','crossBelow','isBetween','unknown'])

function _normalise(obj) {
    if (!VALID_OPS.has(obj.operator)) obj.operator = 'unknown'
    if (obj.confirmation === undefined || obj.confirmation === null) obj.confirmation = 0
    if (obj.value2 === undefined) obj.value2 = null
    obj.confirmation = Math.max(0, parseInt(obj.confirmation, 10) || 0)
}
