/**
 * Parses natural-language condition strings into executable schema objects.
 *
 * Parsed schema shape:
 * {
 *   operator:     'gt'|'lt'|'gte'|'lte'|'eq'|'crossAbove'|'crossBelow'|'isBetween'|'unknown'
 *   subject:      'close'|'open'|'high'|'low'|'volume'|'rsi(N)'|'ema(N)'|'sma(N)'|
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

const LOG    = '[condition.parser]'
const _cache = new Map()   // conditionText (normalised) → ParsedCondition

const SYSTEM = `You parse natural-language trading conditions into a JSON schema.

Return ONLY a valid JSON object with exactly these fields:
- "operator":     one of "gt"|"lt"|"gte"|"lte"|"eq"|"crossAbove"|"crossBelow"|"isBetween"|"unknown"
- "subject":      price/indicator string — one of: "close","open","high","low","volume",
                  "rsi(N)","ema(N)","sma(N)","macd_line","macd_signal","macd_hist","atr(N)"
                  (replace N with the actual period number). Use null if unknown.
- "value":        a number, or another subject-string when comparing two indicators. Use null if unknown.
- "value2":       a number (upper bound for "isBetween"), otherwise null.
- "confirmation": integer — how many consecutive candles must satisfy the condition (0 = current candle only).

Examples:
"price breaks above 100"                  → {"operator":"crossAbove","subject":"close","value":100,"value2":null,"confirmation":1}
"RSI(14) below 30"                        → {"operator":"lt","subject":"rsi(14)","value":30,"value2":null,"confirmation":0}
"EMA(20) crosses above EMA(50)"           → {"operator":"crossAbove","subject":"ema(20)","value":"ema(50)","value2":null,"confirmation":0}
"close stays above 100 for 3 candles"     → {"operator":"gt","subject":"close","value":100,"value2":null,"confirmation":3}
"price between 100 and 110"              → {"operator":"isBetween","subject":"close","value":100,"value2":110,"confirmation":0}
"volume above 1000000"                   → {"operator":"gt","subject":"volume","value":1000000,"value2":null,"confirmation":0}

If you cannot determine the condition, set operator to "unknown" and subject/value to null.`

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
    const key = conditionText.trim().toLowerCase()
    if (_cache.has(key)) return _cache.get(key)

    try {
        const parsed = await claudeJSON(SYSTEM, conditionText)
        _normalise(parsed)
        _cache.set(key, parsed)
        logger.info(LOG, `Parsed: "${conditionText.slice(0, 70)}"`, parsed)
        return parsed
    } catch (err) {
        logger.warn(LOG, `Parse failed: "${conditionText.slice(0, 70)}"`, err.message)
        const fallback = { operator: 'unknown', subject: null, value: null, value2: null, confirmation: 0 }
        _cache.set(key, fallback)
        return fallback
    }
}

const VALID_OPS = new Set(['gt','lt','gte','lte','eq','crossAbove','crossBelow','isBetween','unknown'])

function _normalise(obj) {
    if (!VALID_OPS.has(obj.operator)) obj.operator = 'unknown'
    if (obj.confirmation === undefined || obj.confirmation === null) obj.confirmation = 0
    if (obj.value2 === undefined) obj.value2 = null
    obj.confirmation = Math.max(0, parseInt(obj.confirmation, 10) || 0)
}
