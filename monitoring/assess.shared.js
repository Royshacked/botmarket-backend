import { getTickerAggregates } from '../providers/candles.provider.js'
import { CANDLE_CFG, aggregateCandles } from '../services/tools/marketData.tools.js'
import { userService } from '../api/user/user.service.js'
import { recordUsage } from '../services/tokenUsage.service.js'

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
/**
 * Book one monitor model call against the user who owns the entity.
 *
 * Monitor spend was invisible to the ledger: only resolveAgentStream recorded anything, and the
 * assessments call the provider directly. So the per-user total counted CHAT only — and the monitors
 * are the half that scales linearly with users, the half in-position management just added a call
 * per open position to.
 *
 * COUNTED, NEVER BLOCKED. The spend ceiling lives in resolveAgentStream, which nothing here goes
 * through, so recording cannot gate a monitor — a cost control that stops a live position being
 * managed is the one failure this must not have. The consequence of a monitor-heavy month therefore
 * lands on the user's CHAT (degraded to the cheap model) and never on their protection. That is the
 * asymmetry working as intended, not a side effect.
 *
 * Called PER ROUND. Both assessments loop over tool calls, so booking only the final reply would
 * under-report a tool-heavy wake exactly the way `turns` once under-reported a tool-heavy turn.
 *
 * Its own agent tag, so the byAgent rollup separates monitor spend from the desk's chat rather than
 * blending the two into one row. Fire-and-forget: accounting must never fail a wake.
 */
/**
 * How the monitor should VERIFY, given the lens the setup was built through.
 *
 * The lens changes the monitor's voice and where it looks first — never its tool set. Everything is
 * mounted regardless (assessTools) because conditions are free text and gating a tool by a declared
 * kind never served the model: it read the factors back as prose either way. So this is a sentence,
 * not a filter.
 *
 * Pure, and shared so the readiness read and the in-position read cannot drift into two different
 * descriptions of the same three lenses — which is exactly what happened to the condition-mode
 * sentence before it was deduplicated.
 */
export function lensLine(tradeMode) {
    switch (tradeMode) {
        case 'smc':
            return 'this setup was built on Smart-Money structure — verify the structural trigger with get_structure / get_fvg / get_liquidity rather than trusting the build-time map.'
        case 'institutional':
            return 'this setup was built on an institutional read — flows, relative strength and positioning lead here, so verify with get_correlations against the peers the plan names, get_short_interest / get_options_context for crowding, and fundamentals where the thesis rests on the business. Price structure CONFIRMS; it does not decide.'
        default:
            return 'this setup was built on classical price action — verify with the chart, order blocks and false breaks.'
    }
}

export function bookAssessUsage(userId, model, usage, agent, _record = recordUsage) {
    if (!userId || !usage) return
    _record(userId, model, usage, agent).catch(() => {})
}

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
