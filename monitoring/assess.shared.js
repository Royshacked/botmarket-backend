import { getTickerAggregates } from '../providers/candles.provider.js'
import { CANDLE_CFG, aggregateCandles } from '../services/tools/marketData.tools.js'
import { userService } from '../api/user/user.service.js'

// The mechanical parts every monitor assessment shares — model routing, token budgets, and the
// numeric candle block. Extracted because Hermes and Talos had byte-identical copies of both the
// routing helper and the candles formatter (docs/desks/mentor-talos.md: share the pipe).
//
// What is deliberately NOT here: the system prompts, the gather strategy, and the verdict menus.
// Those ARE the judgment, and they differ by design — Hermes always scores four fixed axes, while
// Talos fetches only the base and reaches for the rest with tools.

export const ASSESS_MODEL    = 'claude-sonnet-4-6'
export const ALLOWED_MODELS  = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'])
export const ALLOWED_EFFORTS = new Set(['off', 'low', 'high'])

// The visible reply is a small JSON object, but with thinking on the hidden reasoning tokens ALSO
// count toward max_tokens — hence the much larger thinking cap. Too small a cap truncates the JSON
// (stop_reason=max_tokens → unparseable verdict → a wasted wake), which is why the non-thinking cap
// was raised from 900: the thesis-anchored prompts fill each axis with real prose.
export const ASSESS_MAX_TOKENS          = 2_500
export const ASSESS_MAX_TOKENS_THINKING = 16_000

// Broad-market barometer: index breadth + the risk gauge.
export const BROAD_INDICES = ['SPY', 'QQQ', '^VIX']

/**
 * Resolve the model + reasoning effort for an assessment from the user's synced AI preferences.
 * Falls back to Sonnet / no-thinking when unset, invalid, or unreadable. Every allowed model is
 * vision-capable, so the chart read is always safe.
 *
 * Both monitors read the same `hermesModel` / `hermesReasoning` preference keys — one knob for
 * "how hard should my monitors think", not one per monitor.
 */
export async function assessRouting(userId) {
    if (!userId) return { model: ASSESS_MODEL, reasoningEffort: 'off' }
    try {
        const prefs = await userService.getPreferences(userId)
        return {
            model:           ALLOWED_MODELS.has(prefs?.hermesModel)      ? prefs.hermesModel     : ASSESS_MODEL,
            reasoningEffort: ALLOWED_EFFORTS.has(prefs?.hermesReasoning) ? prefs.hermesReasoning : 'off',
        }
    } catch {
        return { model: ASSESS_MODEL, reasoningEffort: 'off' }
    }
}

/**
 * Recent candles as the assessment's numeric price block. Uses the shared CANDLE_CFG so the
 * lookback window + bar count scale with the timeframe (a `day` request pulls ~40 daily bars, not
 * the ~7 a fixed 10-day window used to yield) and 2hr/4hr aggregate from native 1hr bars — the same
 * math the agents' get_candles uses. Unknown timeframe → the daily config.
 */
export async function candlesText(asset, tf) {
    const cfg  = CANDLE_CFG[tf] ?? CANDLE_CFG['day']
    const from = Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000
    const raw  = await getTickerAggregates(String(asset).toUpperCase(), { timeSpan: cfg.timeSpan, multiplier: cfg.multiplier, from })
    const bars = cfg.aggregate ? aggregateCandles(raw, cfg.aggregate) : raw
    return (bars ?? []).slice(-cfg.count).map(c => {
        const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
        return `${d} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
    }).join('\n')
}
