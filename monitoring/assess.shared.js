import { getTickerAggregates } from '../providers/candles.provider.js'
import { CANDLE_CFG, aggregateCandles, _formatIndicator } from '../services/tools/marketData.tools.js'
import { sessionStartMs } from '../services/market.service.js'
import { isIntradayTimeframe } from '../services/timeframe.service.js'
import { userService } from '../api/user/user.service.js'
import { recordUsage } from '../services/tokenUsage.service.js'
import { getHouseModels } from '../services/houseModels.service.js'

// The mechanical parts every monitor assessment shares — model routing, token budgets, and the
// numeric candle block. Extracted because Hermes and Talos had byte-identical copies of both the
// routing helper and the candles formatter (docs/desks/mentor-talos.md: share the pipe).
//
// What is deliberately NOT here: the system prompts, the gather strategy, and the verdict menus.
// Those ARE the judgment, and they differ by design — Hermes always scores four fixed axes, while
// Talos fetches only the base and reaches for the rest with tools.

export const ASSESS_MODEL    = 'claude-sonnet-4-6'

/**
 * The models a MONITOR read may run on — its own registry, deliberately apart from the chat desks'
 * `MODELS` (services/llmModels.js): that one feeds the chat menu, and nothing here should be
 * offered to a desk. Keyed by the id stored in `hermesModel`.
 *
 *   provider   'anthropic' → the read loop in talos.assess.js; 'openai-compat' → the one
 *              OpenAI-format loop in providers/openaiCompat.provider.js, for every non-Anthropic
 *              candidate.
 *   endpoint   which account that loop talks to (ENDPOINTS in the provider): 'openrouter' fronts
 *              most vendors behind one key; 'mistral' is Mistral's own API.
 *   wire       the id the endpoint is sent. Same as the key for Anthropic; the endpoint's slug
 *              otherwise.
 *   adminOnly  a CANDIDATE under evaluation (docs/design/talos-replay-harness.md), selectable from
 *              the admin's profile so real reads on the admin's own setups can be compared. A
 *              non-admin document carrying one of these is routed to the default — the preference
 *              is a client-owned snapshot anyone can PUT.
 *
 * The slugs were checked live on 2026-09-20 (OpenRouter's /models, Mistral's model list); a renamed
 * slug fails the read with a provider error (a journal row, never a wrong model — the loop asserts
 * `response.model`).
 */
export const TALOS_MODELS = Object.freeze({
    'claude-sonnet-4-6':         { label: 'Claude Sonnet 4.6', provider: 'anthropic',  wire: 'claude-sonnet-4-6' },
    'claude-sonnet-5':           { label: 'Claude Sonnet 5',   provider: 'anthropic',  wire: 'claude-sonnet-5',           adminOnly: true },
    'claude-opus-4-8':           { label: 'Claude Opus 4.8',   provider: 'anthropic',  wire: 'claude-opus-4-8' },
    // Kept for the one document that stored it — Haiku is not offered for a real read (rejected
    // 2026-09-20), which is why the menu does not list it.
    'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5',  provider: 'anthropic',  wire: 'claude-haiku-4-5-20251001' },
    'gpt-6-luna':                { label: 'GPT-6 Luna',        provider: 'openai-compat', endpoint: 'openrouter', wire: 'openai/gpt-6-luna', adminOnly: true },
    // Mistral Large 3 was the plan; on 2026-09-20 Mistral's own API listed no Large at all (Medium 3.5
    // is their flagship there) and OpenRouter had it batch-only. Medium 3.5 took the slot: dearer
    // ($1.5/$7.5 — about half of Sonnet with their cache), so a fit data point more than a cost case.
    // On OpenRouter since 2026-09-20 (was Mistral's own API — no web plugin there, and the desks
    // share this slug); same price, vision confirmed on the OpenRouter card.
    'mistral-medium-3.5':        { label: 'Mistral Medium 3.5', provider: 'openai-compat', endpoint: 'openrouter', wire: 'mistralai/mistral-medium-3-5', adminOnly: true },
    'qwen3.7-plus':              { label: 'Qwen3.7-Plus',      provider: 'openai-compat', endpoint: 'openrouter', wire: 'qwen/qwen3.7-plus',   adminOnly: true },
    // 2026-09-21, the same three added to the chat registry (llmModels — the reasons are there).
    // For a read the open question is the clock as much as the verdict: Qwen3.7-Plus blew
    // CHECK_TIMEOUT_MS on thinking rounds, and these are the faster tiers.
    'qwen3.7-flash':             { label: 'Qwen3.7 Flash',     provider: 'openai-compat', endpoint: 'openrouter', wire: 'qwen/qwen3.7-flash',  adminOnly: true },
    'deepseek-v4.1-flash':       { label: 'DeepSeek V4.1 Flash', provider: 'openai-compat', endpoint: 'openrouter', wire: 'deepseek/deepseek-v4.1-flash', adminOnly: true },
    'gemini-3.8-flash':          { label: 'Gemini 3.8 Flash',  provider: 'openai-compat', endpoint: 'openrouter', wire: 'google/gemini-3.8-flash', adminOnly: true },
})
export const ALLOWED_MODELS  = new Set(Object.keys(TALOS_MODELS))

/** The registry entry for a resolved model id — always defined for what `assessRouting` returns. */
export function talosModel(id) {
    return TALOS_MODELS[id] ?? TALOS_MODELS[ASSESS_MODEL]
}
// Cheapest first — the order `capEffort` clamps along.
const EFFORT_ORDER = ['off', 'low', 'high']
export const ALLOWED_EFFORTS = new Set(EFFORT_ORDER)

/**
 * The most a monitor may think, whatever the preference says.
 *
 * Output was 46% of what Talos cost in September 2026 and `high` was the difference between the
 * two heavy users' reads ($0.047 vs $0.035 each) — for a verdict that is a small JSON object. The
 * preference is kept as written, so lifting the cap (a premium tier, say) is one constant and the
 * user's own choice comes back; nothing is rewritten in their document.
 */
export const ASSESS_MAX_EFFORT = 'low'

/** Clamp a stored effort to ASSESS_MAX_EFFORT. Unknown → 'off'. Pure; exported for tests. */
export function capEffort(effort, max = ASSESS_MAX_EFFORT) {
    const i = EFFORT_ORDER.indexOf(effort)
    if (i === -1) return 'off'
    return EFFORT_ORDER[Math.min(i, EFFORT_ORDER.indexOf(max))]
}

/**
 * The cache marker for an assessment's system block — the 1-HOUR write, deliberately.
 *
 * The prefix (tools + system) is byte-identical for every setup and every user, and the wakes it
 * serves are paced by candle closes: 15 minutes and up, ahead of the 5-minute TTL. So the default
 * marker expired between wakes and nearly every read re-wrote ~5k tokens at 1.25x — cache WRITES
 * were 43% of Talos in September 2026, with reads of the same prefix at a tenth of that. A 1-hour
 * entry costs 2x to write and is refreshed free by every read within the hour: one write an hour
 * across the whole book instead of one per wake, and cheaper still as the book grows.
 *
 * ORDER RULE (the API's): entries with the longer TTL must come before shorter ones in the prefix.
 * The system block precedes `messages`, whose tool-loop breakpoint stays at the 5-minute default —
 * do not put a 1-hour marker on a message.
 */
export const ASSESS_PREFIX_CACHE = Object.freeze({ type: 'ephemeral', ttl: '1h' })

/** The `system` array for an assessment request — one text block carrying the marker. Pure. */
export function assessSystem(text) {
    return [{ type: 'text', text, cache_control: ASSESS_PREFIX_CACHE }]
}

// The visible reply is a small JSON object, but with thinking on the hidden reasoning tokens ALSO
// count toward max_tokens — hence the much larger thinking cap. Too small a cap truncates the JSON
// (stop_reason=max_tokens → unparseable verdict → a wasted wake), which is why the non-thinking cap
// was raised from 900: the thesis-anchored prompts fill each axis with real prose.
export const ASSESS_MAX_TOKENS          = 2_500
export const ASSESS_MAX_TOKENS_THINKING = 16_000

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
export function bookAssessUsage(userId, model, usage, agent, _record = recordUsage) {
    if (!userId || !usage) return
    // `monitor: true` keeps this OUT of the chat spend ceiling — see tokenUsage.chatSpend. It is
    // still counted in the month's totals and in this agent's own row.
    _record(userId, model, usage, agent, { monitor: true }).catch(() => {})
}

/**
 * Resolve the model + reasoning effort for an assessment from the user's synced AI preferences.
 * Falls back to Sonnet / no-thinking when unset, invalid, or unreadable. Every allowed model is
 * vision-capable, so the chart read is always safe.
 *
 * ONE KNOB FOR EVERY MONITOR — "how hard should my monitors think", not one setting per monitor.
 *
 * THE KEY IS STILL CALLED `hermesModel`, and that is a decision rather than an oversight. It is a
 * PERSISTED user-preference field: every existing user document carries it, and the client writes
 * it. Renaming would mean a migration of live preferences for a cosmetic gain — the same trade the
 * setup schema refuses over `lower`/`upper`, and the same category as the Kairos names CLAUDE.md
 * keeps on purpose (a wire field is not a desk). Talos is the only monitor reading it today; Hermes
 * was archived on 2026-08-18.
 *
 * WHOSE KNOB (2026-09-21, houseModels.service): EVERY setup reads on the HOUSE Talos model — the
 * admin's own included; the one selector is the admin's and it chooses for the house. The stored
 * `hermesModel` is not consulted for anyone (the field is a client-owned snapshot anyone can PUT).
 * The effort cap is still the user's own, capped as before. No house document → ASSESS_MODEL.
 */
export async function assessRouting(userId, _getUser = userService.getUserById, _house = getHouseModels) {
    const fallback = { model: ASSESS_MODEL, reasoningEffort: 'off', ...talosModel(ASSESS_MODEL) }
    if (!userId) return fallback
    try {
        const prefs = (await _getUser(userId))?.preferences
        // `true` for the house id: the admin chose it, so a candidate is honoured for anyone.
        const model = resolveTalosModel((await _house().catch(() => null))?.talosModel, true)
        return {
            model,
            ...talosModel(model),
            // Capped, not rejected: a stored `high` reads as `low` — the user asked for thinking and
            // gets the affordable kind. See ASSESS_MAX_EFFORT.
            reasoningEffort: capEffort(prefs?.hermesReasoning),
        }
    } catch {
        return fallback
    }
}

/**
 * The stored choice → the model the read runs on. Unknown → default; an `adminOnly` candidate on a
 * non-admin document → default (silently: the document is what a client sent, not what the user
 * was offered). Pure; exported for tests.
 */
export function resolveTalosModel(stored, isAdmin) {
    if (!ALLOWED_MODELS.has(stored)) return ASSESS_MODEL
    if (TALOS_MODELS[stored].adminOnly && !isAdmin) return ASSESS_MODEL
    return stored
}

/**
 * The bars behind a read's opening block. Uses the shared CANDLE_CFG so the lookback window + bar
 * count scale with the timeframe (a `day` request pulls ~40 daily bars, not the ~7 a fixed 10-day
 * window used to yield) and 2hr/4hr aggregate from native 1hr bars — the same math the agents'
 * get_candles uses. Unknown timeframe → the daily config.
 *
 * SPLIT FROM `candlesText` on 2026-09-23 so ONE fetch can serve both the candle block and the
 * indicator block. The indicators used to be a tool call that re-fetched these same bars for the
 * same ticker and rung, seconds later, to do arithmetic on them.
 */
export async function candleRows(asset, tf) {
    const cfg  = CANDLE_CFG[tf] ?? CANDLE_CFG['day']
    const from = Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000
    const raw  = await getTickerAggregates(String(asset).toUpperCase(), { timeSpan: cfg.timeSpan, multiplier: cfg.multiplier, from })
    const bars = cfg.aggregate ? aggregateCandles(raw, cfg.aggregate) : raw
    return (bars ?? []).slice(-cfg.count)
}

/** Bars → the numeric price block. Pure. */
export function formatCandles(bars) {
    return (bars ?? []).map(c => {
        const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
        return `${d} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
    }).join('\n')
}

/** Recent candles as the assessment's numeric price block. */
export async function candlesText(asset, tf) {
    return formatCandles(await candleRows(asset, tf))
}

// What a read opens with beside the rows. Not a menu the model picks from — the point is that these
// arrive WITHOUT being asked for, because a read handed nothing but OHLCV reaches for a picture.
//
// VWAP is intraday-only in meaning: on a daily+ rung the bars pre-date any session anchor and the
// number is noise wearing a name, so it is simply absent there rather than printed as `n/a`.
const OPENING_INDICATORS = [
    { name: 'ema', period: 20 },
    { name: 'ema', period: 50 },
    { name: 'rsi', period: 14 },
    { name: 'atr', period: 14 },
]

/**
 * The indicator block, computed from bars ALREADY IN HAND — no fetch, no model call, no tool round
 * trip. Uses the same `_formatIndicator` the `get_indicators` tool uses, so the numbers a read
 * opens with and the numbers it would get by asking are the same numbers, formatted the same way.
 * Two VWAPs that disagree is a bug nobody would ever find.
 */
export function indicatorsText(asset, bars, tf) {
    if (!bars?.length) return ''
    const closes = bars.map(b => b.close)
    // Monitor-form candles (t/o/h/l/c/v) for ATR + VWAP.
    const mon    = bars.map(b => ({ t: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }))
    const specs  = isIntradayTimeframe(tf) ? [{ name: 'vwap' }, ...OPENING_INDICATORS] : OPENING_INDICATORS
    const anchor = isIntradayTimeframe(tf) ? sessionStartMs(String(asset).toUpperCase()) : null
    return specs.map(s => _formatIndicator(s.name, s.period, closes, mon, anchor)).join('\n')
}

// ─── Reply / block formatting ─────────────────────────────────────────────────
//
// Moved out of hermes.assess.js on 2026-08-18. Talos already imported both from there, so
// archiving Hermes would have left the live monitor importing an archived file — the same trap
// `kairos.tools.js` had. They were never Hermes-specific: one parses an Anthropic reply, the other
// formats a calendar.

// The browse-confirm reply interleaves server_tool_use / web_search_tool_result blocks with the model's
// own text (search narration, then the JSON). Join ALL text blocks so extractFirstJSON can find the
// trailing object regardless of how many text turns the search produced. Pure.
export function _allText(msg) {
    return (msg?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
}

// Format the call's frozen scheduled catalysts (earnings / FOMC / macro, stamped at build time) into
// the EVENT RISK block Hermes weighs before entering. Pure: '' when there are none, so the caller can
// stamp an explicit "(none)" line. Each row carries the date + when (pre_market/after_hours/timed) so
// the model can judge whether it lands inside this trade's expected hold.
export function _formatEventRisk(events) {
    return (Array.isArray(events) ? events : [])
        .filter(e => e?.date && e?.label)
        .map(e => {
            const when = e.when && e.when !== 'timed' ? e.when : (e.time || 'timed')
            return `${e.date} — ${e.label} (${when}, ${e.impact || 'medium'} impact)`
        })
        .join('\n')
}
