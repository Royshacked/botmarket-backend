// Hermes's four-axis LLM assessment (readiness + in-position management). Split out of
// hermes.monitor.service.js: the monitor loop wires these as the default `assess` /
// `assessPosition` IO deps (mocked in unit tests). Both reads share one runner — fetch a
// chart image + recent candles, assemble the user turn, route to the user's Hermes model
// with adaptive thinking, and parse the first JSON object out of the reply.

import Anthropic from '@anthropic-ai/sdk'
import { getTickerAggregates } from '../providers/yahoofinance.provider.js'
import { fetchChartImage } from '../providers/chartImg.provider.js'
import { buildStudies } from './evaluators/chart.evaluator.js'
import { userService } from '../api/user/user.service.js'
import { logger } from '../services/logger.service.js'
import { extractFirstJSON } from './monitorUtils.js'

const LOG = '[hermes.assess]'

const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const ASSESS_MODEL    = 'claude-sonnet-4-6'
const ALLOWED_MODELS  = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'])
const ALLOWED_EFFORTS = new Set(['off', 'low', 'high'])
// The visible reply is a small JSON object, but when thinking is on the hidden reasoning tokens
// ALSO count toward max_tokens — so give generous headroom to avoid truncating the JSON.
const ASSESS_MAX_TOKENS          = 900
const ASSESS_MAX_TOKENS_THINKING = 16_000

// Map the reasoning-effort knob onto Anthropic adaptive extended thinking — mirrors
// anthropic.provider.js. 'off'/invalid → null (no thinking block, zero reasoning cost). Adaptive
// (NOT budget_tokens, which 400s on Opus 4.8) + effort is supported across all allowed models. Pure.
export function _thinkingConfig(effort) {
    return (effort === 'low' || effort === 'high')
        ? { thinking: { type: 'adaptive' }, output_config: { effort } }
        : null
}

// Hermes runs under the user's AI preferences: read their synced `hermesModel` + `hermesReasoning`
// from account preferences and use them for the assessment. Falls back to Sonnet / no-thinking when
// unset, invalid, or unreadable. All allowed models are vision-capable, so the chart read is safe.
async function _hermesRouting(userId) {
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

// Pull the first text block from an assessment response. With extended thinking on, content[0] is a
// thinking block, so a bare content[0].text would miss the JSON — find the text block explicitly. Pure.
export function _assessText(msg) {
    const block = (msg?.content ?? []).find(b => b?.type === 'text')
    return block?.text ?? ''
}

async function _candlesText(asset, tf) {
    const spec = tf === 'day' ? { timeSpan: 'day', multiplier: 1 }
        : tf === '1hr' || tf === '4hr' ? { timeSpan: 'hour', multiplier: 1 }
        : { timeSpan: 'minute', multiplier: tf === '5min' ? 5 : tf === '30min' ? 30 : 15 }
    const rows = await getTickerAggregates(String(asset).toUpperCase(), { ...spec, from: Date.now() - 10 * 24 * 60 * 60 * 1000 })
    return (rows ?? []).slice(-30).map(c => {
        const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
        return `${d} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
    }).join('\n')
}

// Shared assessment runner: render chart + candles for the ladder's finest timeframe, let the caller
// assemble its user turn (`buildUserText(tf, candlesText)`), call the routed model, and parse JSON.
// Never throws — a failed read returns null so the caller retries on the min cadence.
async function _runAssessment(call, systemPrompt, buildUserText, label) {
    try {
        const tf = call.timeframe_ladder?.at(-1) ?? '15min'
        const [png, candlesText] = await Promise.all([
            fetchChartImage(String(call.asset).toUpperCase(), tf, buildStudies('vwap, ema(50), volume')).catch(() => null),
            _candlesText(call.asset, tf).catch(() => ''),
        ])

        const userText = buildUserText(tf, candlesText)
        const content = png
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: userText }]
            : userText

        const { model, reasoningEffort } = await _hermesRouting(call.user_id)
        const thinking = _thinkingConfig(reasoningEffort)
        const msg = await _client.messages.create({
            model,
            max_tokens: thinking ? ASSESS_MAX_TOKENS_THINKING : ASSESS_MAX_TOKENS,
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content }],
            ...(thinking ?? {}),
        })
        return extractFirstJSON(_assessText(msg))
    } catch (err) {
        logger.warn(LOG, `${label} failed for ${call.id}:`, err.message)
        return null
    }
}

const _ASSESS_SYSTEM = `You are Kairos, a discretionary day/swing trader running a readiness check on a pre-built trade "call".
You are given the call (zones, reference levels, patterns), a rendered chart image, recent candles, the current price, and why you were woken.
Decide if NOW is a good moment to enter around the armed zone. Weight price action over indicators. Be strict — most checks should NOT be "enter".
Assess four axes: market conditions, news/catalyst, price action (from the chart), and whether the mapped patterns are actually happening.
On an expiry_review, choose enter (it finally looks good), edit (re-map/roll — provide edit_proposal), or let_expire.
Always include "read": ONE short, plain first-person sentence — what you see right now and what you're doing about it (e.g. "Price is coiling just under the zone, no trigger yet — I'll keep waiting."). This is your live monologue, so keep it human and specific.
Output ONLY a JSON object, no prose:
{"timeframe_used":"15min","read":"<one first-person sentence>","market":{"read":"...","score":"supportive|neutral|adverse"},"news":{"read":"...","score":"supportive|neutral|adverse|blocking"},"price_action":{"read":"...","strength":"strong|weak|mixed"},"patterns_seen":[{"id":"p1","present":true,"note":"..."}],"verdict":"enter|wait|stand_aside|let_expire|edit","proposal":{"entry":0,"stop":0,"take_profit":[{"price":0}],"rationale":"..."},"next_check_min":15,"memo_update":"..."}
Include "proposal" only when verdict is "enter"; include "edit_proposal":{"why":"...","changes":{}} only when verdict is "edit".`

export async function _defaultAssess(call, zone, ctx) {
    return _runAssessment(call, _ASSESS_SYSTEM, (tf, candlesText) => [
        `CALL: ${JSON.stringify({ asset: call.asset, trade_type: call.trade_type, bias: call.bias, entry_zones: call.entry_zones, reference_levels: call.reference_levels, patterns: call.patterns, timeframe_ladder: call.timeframe_ladder, valid_until: call.valid_until })}`,
        `ARMED ZONE: ${zone ? JSON.stringify(zone) : 'none (expiry review)'}`,
        `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
        `REASON WOKEN: ${ctx.reason}`,
        `PRIOR MEMO: ${call.monitor_state?.memo || '(none)'}`,
        candlesText ? `RECENT CANDLES (${tf}):\n${candlesText}` : '',
    ].filter(Boolean).join('\n\n'), 'assessment')
}

const _POSITION_SYSTEM = `You are Kairos, a discretionary day/swing trader MANAGING a live position you already entered (not looking for a new one).
You are given the original call (thesis, patterns, reference levels), the live position (entry fill, working stop, targets, what's been taken, running R-multiple/memo), the current price, a rendered chart, recent candles, and why you were woken.
Manage it like a pro: LET WINNERS RUN, cut when the THESIS breaks, and do NOT micro-manage. Most checks should be "hold". Re-check the ORIGINAL thesis and mapped patterns against what price is doing NOW; weight price action over indicators.
Choose ONE verdict:
- hold: nothing to do (the DEFAULT — bias strongly toward this).
- move_stop: trail / move the stop to protect (breakeven only after a clear +1R, or up to fresh structure). proposal.new_stop.
- take_partial: bank part of the position into a target/strength. proposal.size_pct (1-100).
- exit_now: the thesis is broken or invalidated — get flat now, don't wait for the stop. proposal.reason.
- let_run: momentum is strong into/through the final target — extend or cancel the take-profit. proposal.new_tp OR proposal.cancel_tp:true.
Always include "read": ONE short, plain first-person sentence — what you see and what you're doing.
Output ONLY a JSON object, no prose:
{"read":"<one first-person sentence>","market":{"read":"...","score":"supportive|neutral|adverse"},"news":{"read":"...","score":"supportive|neutral|adverse|blocking"},"price_action":{"read":"...","strength":"strong|weak|mixed"},"patterns_seen":[{"id":"p1","present":true,"note":"..."}],"verdict":"hold|move_stop|take_partial|exit_now|let_run","proposal":{"new_stop":0,"size_pct":0,"new_tp":0,"cancel_tp":false,"reason":"..."},"next_check_min":15,"memo_update":"..."}
Include "proposal" only when the verdict is NOT "hold" (only the fields that verdict needs).`

export async function _defaultAssessPosition(call, ps, ctx) {
    return _runAssessment(call, _POSITION_SYSTEM, (tf, candlesText) => [
        `CALL: ${JSON.stringify({ asset: call.asset, trade_type: call.trade_type, bias: call.bias, thesis: call.thesis, patterns: call.patterns, reference_levels: call.reference_levels })}`,
        `POSITION: ${JSON.stringify({ entry: ps.entry, stop: ps.stop, targets: ps.targets, taken: ps.taken, phase: ps.phase })}`,
        `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
        `R-MULTIPLE NOW: ${ctx.metrics?.r_multiple_now ?? 'unknown'}`,
        `REASON WOKEN: ${ctx.reason}`,
        `PENDING CARD: ${ps.pending_action ? JSON.stringify(ps.pending_action) : '(none)'}`,
        `PRIOR MEMO: ${ps.memo || '(none)'}`,
        candlesText ? `RECENT CANDLES (${tf}):\n${candlesText}` : '',
    ].filter(Boolean).join('\n\n'), 'position assessment')
}
