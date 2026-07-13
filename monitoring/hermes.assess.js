// Hermes's four-axis LLM assessment (readiness + in-position management). Split out of
// hermes.monitor.service.js: the monitor loop wires these as the default `assess` /
// `assessPosition` IO deps (mocked in unit tests). Both reads share one runner — fetch a
// chart image + recent candles, assemble the user turn, route to the user's Hermes model
// with adaptive thinking, and parse the first JSON object out of the reply.

import Anthropic from '@anthropic-ai/sdk'
import { getQuotes, getCycleAnalysis } from '../providers/yahoofinance.provider.js'
import { getTickerAggregates }         from '../providers/candles.provider.js'
import { buildStudies } from './evaluators/chart.evaluator.js'
import { CANDLE_CFG, aggregateCandles } from '../services/marketData.tools.js'
import { cachedChartImage } from '../services/chartImgCache.service.js'
import { readStructure, STRUCTURE_VISIONS } from '../services/priceStructure.tools.js'
import { newsService } from '../services/news.service.js'
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
// Non-thinking cap bumped 900→2500: the thesis-anchored prompt now fills each axis `read` +
// `patterns_seen` + `proposal`/`memo_update` with real prose, and 900 was truncating the JSON on
// essentially every wake (stop_reason=max_tokens → unclosed-JSON → null assessment). Mirrors the
// browse-confirm pass, which already carries CONFIRM_MAX_TOKENS headroom for the same reason.
const ASSESS_MAX_TOKENS          = 2_500
const ASSESS_MAX_TOKENS_THINKING = 16_000
// The browse-confirm pass narrates its searches before the JSON, so it needs more room than the
// terse first-pass reply to avoid truncating the trailing JSON object.
const CONFIRM_MAX_TOKENS         = 2_000

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

// The browse-confirm reply interleaves server_tool_use / web_search_tool_result blocks with the model's
// own text (search narration, then the JSON). Join ALL text blocks so extractFirstJSON can find the
// trailing object regardless of how many text turns the search produced. Pure.
export function _allText(msg) {
    return (msg?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
}

// Recent candles for the assessment's numeric price-action block. Uses the shared CANDLE_CFG so the
// lookback window + bar count scale with the timeframe (a `day` request pulls ~40 daily bars, not the
// ~7 a fixed 10-day window used to yield) and 2hr/4hr aggregate from native 1hr bars — same math the
// agents' get_candles uses. Unknown tf → daily config.
async function _candlesText(asset, tf) {
    const cfg  = CANDLE_CFG[tf] ?? CANDLE_CFG['day']
    const from = Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000
    const raw  = await getTickerAggregates(String(asset).toUpperCase(), { timeSpan: cfg.timeSpan, multiplier: cfg.multiplier, from })
    const bars = cfg.aggregate ? aggregateCandles(raw, cfg.aggregate) : raw
    return (bars ?? []).slice(-cfg.count).map(c => {
        const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
        return `${d} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`
    }).join('\n')
}

// Format up to 12 newest-first, dated headlines into the block the prompt scores the news axis from.
// Pure: drops articles with no headline, tolerates a NaN/missing datetime, and returns '' for none. Its
// caller stamps the "unsourced" fallback line, so an empty return here just means "no headlines". Pure.
export function _formatHeadlines(articles) {
    return (articles ?? [])
        .filter(a => a?.headline)
        .slice(0, 12)
        .map(a => {
            const d = Number.isFinite(a.datetime) ? new Date(a.datetime * 1000).toISOString().slice(0, 10) : '????-??-??'
            return `[${d}] ${a.headline}`
        })
        .join('\n')
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

// Broad-market barometer symbols pulled live for a market-sensitive call: index breadth + risk gauge.
const BROAD_INDICES = ['SPY', 'QQQ', '^VIX']

// Fetch the LIVE broad-market state for a call — but ONLY when Kairos judged the asset market-sensitive
// (level high/medium). For low/unknown sensitivity the tape is immaterial, so we skip the fetch. Pulls
// the broad indices + the call's stamped drivers (its correlated proxies) in one batched, LLM-ready
// quote. Never throws (getQuotes swallows per-symbol) — a failure returns '' and _marketBlock frames it.
async function _marketText(call) {
    const level = call?.market_sensitivity?.level
    if (level !== 'high' && level !== 'medium') return ''
    const drivers = Array.isArray(call.market_sensitivity.drivers) ? call.market_sensitivity.drivers.slice(0, 4) : []
    return getQuotes([...BROAD_INDICES, ...drivers])
}

// The labeled BROAD MARKET turn-block. Three framings so the model always knows the market's standing:
// low/unknown sensitivity → say the tape is immaterial (don't let a red day veto an idiosyncratic name);
// sensitive + a live read → present it with the level + drivers; sensitive but the read failed → say so.
// Pure given (call, marketText); exported for tests.
export function _marketBlock(call, marketText) {
    const level = call?.market_sensitivity?.level
    if (level !== 'high' && level !== 'medium') {
        return 'BROAD MARKET: this asset is low-sensitivity to the broad market — treat market conditions as not material.'
    }
    const drivers = (call.market_sensitivity.drivers ?? []).join(', ') || 'none'
    return marketText
        ? `BROAD MARKET NOW (asset is ${level}-sensitivity; drivers: ${drivers}):\n${marketText}`
        : 'BROAD MARKET: (live read unavailable — score market conditions cautiously, leaning on the chart)'
}

// The labeled EVENT RISK turn-block: the formatted list, or an explicit "none" so the model doesn't
// treat a missing block as "unknown". Kept next to the formatter so both readiness + position share it.
function _eventRiskBlock(call) {
    const block = _formatEventRisk(call?.event_risk)
    return block
        ? `SCHEDULED EVENT RISK (frozen at build — judge relevance vs trade_type/valid_until):\n${block}`
        : `SCHEDULED EVENT RISK: (none flagged in the next ~10 days)`
}

// Recent company headlines for the call's symbol, so the news/catalyst axis is scored from real news
// rather than the model's training memory. Reuses newsService's shared 1h file cache (a real GNews hit
// is ≤1×/hour/symbol and deduped with the idea monitor + market feed — no extra quota pressure). Never
// throws: a failed or empty fetch returns '' and the assessment proceeds on chart + candles alone.
async function _newsText(asset) {
    const symbol = String(asset).toUpperCase()
    const { articles } = await newsService.getOrFetch({ category: 'companies', subject: symbol, query: symbol })
    const block = _formatHeadlines(articles)
    if (!block) logger.info(LOG, `no news for ${symbol} — news axis unsourced`)
    return block
}

// ─── Adaptive timeframe: on-demand chart + structure tools ────────────────────
// The read is shown its primary (finest-rung) chart up front, but — like a trader flipping charts —
// it may pull additional views mid-assessment (get_chart) or structured price-action reads
// (get_orderblocks / get_false_breaks), restricted to THIS call's ladder rungs. Bounded so the tool
// loop can't run away (each structure read costs an extra vision call, so keep the ceiling tight).
const MAX_ASSESS_TOOL_CALLS = 3

// Build the get_chart tool for a call, with the timeframe enum LOCKED to the call's ladder rungs so the
// model can only request timeframes Kairos actually laddered. Pure.
export function _chartTool(ladder) {
    const rungs = Array.isArray(ladder) && ladder.length ? ladder : ['15min']
    return [{
        name: 'get_chart',
        description: "Render a TradingView candlestick chart IMAGE (vwap + ema50 + volume) at one of this call's ladder timeframes and look at it. Use it to check a higher timeframe for structure, or a lower one for the trigger, before you decide — a mapped pattern may live on a different timeframe than the primary view. Optional: skip it when the primary chart is enough.",
        input_schema: {
            type: 'object',
            properties: { timeframe: { type: 'string', enum: rungs, description: "One of the call's timeframe_ladder rungs." } },
            required: ['timeframe'],
        },
    }]
}

// The price-action structure tools (get_orderblocks / get_false_breaks), timeframe LOCKED to the
// call's ladder rungs. Each renders a PLAIN chart at the chosen rung and returns a structured read —
// the same tools the build agents use, so Hermes confirms the price-action trigger with the same
// lens the plan was built on. Optional (the model calls them only when the chart alone is ambiguous).
export function _structureTools(ladder) {
    const rungs = Array.isArray(ladder) && ladder.length ? ladder : ['15min']
    const timeframe = { type: 'string', enum: rungs, description: "One of the call's timeframe_ladder rungs." }
    return [
        {
            name: 'get_orderblocks',
            description: "Render a PLAIN chart at one of this call's ladder timeframes and get a structured read of the ORDER BLOCKS near current price (last opposing candle/cluster before an impulsive structure break) — fresh/untested vs mitigated, zone vs price. Use it to check whether a price-action orderblock actually backs entering here. Optional.",
            input_schema: { type: 'object', properties: { timeframe }, required: ['timeframe'] },
        },
        {
            name: 'get_false_breaks',
            description: "Render a PLAIN chart at one of this call's ladder timeframes and get a structured read of recent FALSE BREAKS / liquidity sweeps (price pushed beyond a prior high/low, failed, and closed back inside). Use it to confirm a sweep-and-reclaim trigger at the zone. Optional.",
            input_schema: { type: 'object', properties: { timeframe }, required: ['timeframe'] },
        },
        {
            name: 'get_cycle_analysis',
            description: "Read the dominant recurring PRICE cycle (trough-to-trough / peak-to-peak) at one of this call's ladder timeframes — where price sits in the cycle now and the estimated next turn — to time the entry against it (is a turn due?). A sub-hourly-to-hourly rung reads the intraday cycle; a daily rung the multi-day swing. Optional.",
            input_schema: { type: 'object', properties: { timeframe }, required: ['timeframe'] },
        },
    ]
}

// A requested chart timeframe is honored only if it's one of the call's ladder rungs. Pure.
export function _validChartTf(requested, ladder) {
    return (Array.isArray(ladder) ? ladder : []).includes(requested) ? requested : null
}

// Execute the assessment tool_use blocks from an assistant turn — get_chart (indicator-overlaid
// chart image) and the plain-chart structure reads get_orderblocks / get_false_breaks — and return
// the matching tool_result blocks. Every rung is validated against the call's ladder; an invalid rung
// or a failed render/read returns an error tool_result so the model can proceed rather than stall.
// Order/count mirror the requested uses. Deps injectable for tests (no network / no model call).
export async function _handleAssessToolUses(call, assistantContent, ladder, deps = {}) {
    const {
        renderChart:      _renderChart      = cachedChartImage,
        readStructure:    _readStructure    = readStructure,
        getCycleAnalysis: _getCycleAnalysis = getCycleAnalysis,
    } = deps
    const symbol = String(call.asset).toUpperCase()
    const uses = (assistantContent ?? []).filter(b => b?.type === 'tool_use')
    const results = []
    for (const use of uses) {
        const tf = _validChartTf(use.input?.timeframe, ladder)
        if (!tf) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true,
                content: `timeframe must be one of the call's ladder rungs: ${ladder.join(', ')}` })
            continue
        }
        try {
            if (use.name === 'get_orderblocks' || use.name === 'get_false_breaks') {
                const kind = use.name === 'get_orderblocks' ? 'orderblocks' : 'false_breaks'
                const { text } = await _readStructure({ symbol, timeframe: tf, kind, vision: STRUCTURE_VISIONS[kind] })
                results.push({ type: 'tool_result', tool_use_id: use.id, content: text })
            } else if (use.name === 'get_cycle_analysis') {
                const text = await _getCycleAnalysis(symbol, 'price', null, 4, tf)
                results.push({ type: 'tool_result', tool_use_id: use.id, content: String(text) })
            } else {
                // get_chart (default): the indicator-overlaid chart image
                const png = await _renderChart(symbol, tf, buildStudies('vwap, ema(50), volume', { fillDefaults: false }))
                results.push({ type: 'tool_result', tool_use_id: use.id, content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
                    { type: 'text', text: `${symbol} ${tf} chart.` },
                ] })
            }
        } catch (err) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true,
                content: `could not run ${use.name} on the ${tf} chart: ${err.message}` })
        }
    }
    return results
}

// Shared assessment runner: render chart + candles + recent headlines + (for market-sensitive calls)
// the live broad-market read for the ladder's finest timeframe, let the caller assemble its user turn
// (`buildUserText(tf, candlesText, newsText, marketText)`), call the routed model, and parse JSON. Never
// throws — a failed read returns null so the caller retries on the min cadence. Each input degrades
// independently: a failed chart/candles/news/market read is just omitted.
async function _runAssessment(call, systemPrompt, buildUserText, label) {
    try {
        const ladder = Array.isArray(call.timeframe_ladder) && call.timeframe_ladder.length ? call.timeframe_ladder : ['15min']
        const tf = ladder[ladder.length - 1]   // primary view + candle timeframe = the ladder's finest rung
        const [png, candlesText, newsText, marketText] = await Promise.all([
            cachedChartImage(String(call.asset).toUpperCase(), tf, buildStudies('vwap, ema(50), volume', { fillDefaults: false })).catch(() => null),
            _candlesText(call.asset, tf).catch(() => ''),
            _newsText(call.asset).catch(() => ''),
            _marketText(call).catch(() => ''),
        ])

        const userText = buildUserText(tf, candlesText, newsText, marketText)
        const primary = png
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: userText }]
            : userText

        const { model, reasoningEffort } = await _hermesRouting(call.user_id)
        const thinking  = _thinkingConfig(reasoningEffort)
        const maxTokens = thinking ? ASSESS_MAX_TOKENS_THINKING : ASSESS_MAX_TOKENS
        const system    = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
        const tools     = [..._chartTool(ladder), ..._structureTools(ladder)]
        const messages  = [{ role: 'user', content: primary }]

        // Adaptive-timeframe loop: the read may pull extra ladder-rung charts (get_chart) or structured
        // price-action reads (get_orderblocks / get_false_breaks), bounded. Most reads call no tool → a
        // single round-trip, exactly as before. On the final allowed round the tools are dropped so the
        // model is forced to return the JSON rather than request another read.
        let msg
        for (let round = 0; round <= MAX_ASSESS_TOOL_CALLS; round++) {
            msg = await _client.messages.create({
                model, max_tokens: maxTokens, system, messages,
                ...(round < MAX_ASSESS_TOOL_CALLS ? { tools } : {}),
                ...(thinking ?? {}),
            })
            if (msg.stop_reason !== 'tool_use') break
            messages.push({ role: 'assistant', content: msg.content })
            messages.push({ role: 'user', content: await _handleAssessToolUses(call, msg.content, ladder) })
        }
        // The model replied, but the JSON may be truncated (stop_reason=max_tokens) or malformed.
        // Return a typed failure marker so the caller's journal note can be honest about WHY it
        // failed (a bad reply, not a failed data/vision fetch). Never let the parse error escape as io.
        try {
            return extractFirstJSON(_allText(msg))
        } catch (parseErr) {
            const truncated = msg?.stop_reason === 'max_tokens'
            logger.warn(LOG, `${label} reply unparseable for ${call.id} (stop_reason=${msg?.stop_reason}):`, parseErr.message)
            return { _failReason: truncated ? 'truncated' : 'malformed' }
        }
    } catch (err) {
        logger.warn(LOG, `${label} failed for ${call.id}:`, err.message)
        return { _failReason: 'io' }
    }
}

const _ASSESS_SYSTEM = `You are Kairos, a discretionary day/swing trader running a readiness check on a pre-built trade "call".
You are given the call (the THESIS, zones, reference levels, the specific mapped patterns, and the author's conviction), a rendered chart image, recent candles, the current price, and why you were woken.
You're shown the primary chart at the ladder's finest rung; you MAY call get_chart(timeframe) to pull any other rung of the call's timeframe_ladder — a higher timeframe for structure, a lower one for the trigger, or the timeframe a specific pattern was mapped on — before deciding. You may also call get_orderblocks(timeframe) or get_false_breaks(timeframe) on any ladder rung for a structured price-action read (fresh orderblocks near price / recent liquidity sweeps) when the chart alone leaves the trigger ambiguous, and get_cycle_analysis(timeframe) to time the entry against the dominant recurring price cycle (is a turn due on this rung?) — all the same lenses the call was built on. These tools are OPTIONAL — use them only when they'd change your decision; skip them when the primary chart is enough. Check whatever views you'd want as a trader. Set "timeframe_used" to the timeframe your decision leans on.
Decide if NOW is a good moment to enter around the armed zone. Weight price action over indicators. Be strict — most checks should NOT be "enter".
Assess four axes: market conditions, news/catalyst, price action (from the chart), and whether the mapped patterns are actually happening. Judge them HOLISTICALLY against the THESIS — the call's reason for being.
Weight technicals vs fundamentals by horizon, the way the call was built: an intraday/day call is price-action-led (fundamentals a light backdrop); a swing call gives the fundamental/catalyst picture real weight alongside the technicals. The patterns you check are the SPECIFIC ones the plan mapped — evaluate each by its own look_for cue and its own timeframe, and respect its evidence flag (observed vs inferred); confirm or reject THOSE, don't grade generic ones.
The plan is your primary lens, not a rigid checklist. You are a discretionary trader: if MATERIAL new information the plan didn't anticipate appears — a strong surprise catalyst, the broad market AND this name both ripping your way — you may act on that genuine new edge even if the exact mapped trigger didn't fire as scripted; conversely, a setup that technically triggers into a broken backdrop is not an entry. Reason from the whole picture, and note in your read when you're deviating from the mapped setup and why.
Score the market-conditions axis from the BROAD MARKET block (a LIVE read of SPY/QQQ/VIX + this asset's correlated drivers) — not from memory. Weight it by the stated sensitivity: a high-sensitivity asset into a risk-off tape (indices down, VIX spiking) scores "adverse"; if the block says the asset is low-sensitivity/not material, treat market conditions as neutral and do NOT let the broad tape veto the trade.
Score the news/catalyst axis from the RECENT HEADLINES provided (recent-first, dated) AND the SCHEDULED EVENT RISK block — do not invent news from memory. If no headlines are provided, the realized-news read is unsourced: lean "neutral" and say so. A fresh, material catalyst that cuts against the trade is "blocking".
SCHEDULED EVENT RISK lists known upcoming catalysts (earnings, FOMC, CPI) with timing, frozen at build. Weigh them like a discretionary trader: if a high-impact event lands BEFORE this trade's expected exit (judge from trade_type + valid_until) and the thesis is NOT explicitly an event play, strongly prefer verdict "wait" or "stand_aside" — do NOT enter into an unresolved binary just because price tagged the zone. An imminent, unresolved high-impact event scores the news axis "adverse" or "blocking".
On an expiry_review, choose enter (it finally looks good), edit (re-map/roll — provide edit_proposal), or let_expire.
Always include "read": ONE short, plain first-person sentence — what you see right now and what you're doing about it (e.g. "Price is coiling just under the zone, no trigger yet — I'll keep waiting."). This is your live monologue, so keep it human and specific.
Output ONLY a JSON object, no prose:
{"timeframe_used":"15min","read":"<one first-person sentence>","market":{"read":"...","score":"supportive|neutral|adverse"},"news":{"read":"...","score":"supportive|neutral|adverse|blocking"},"price_action":{"read":"...","strength":"strong|weak|mixed"},"patterns_seen":[{"id":"p1","present":true,"note":"..."}],"verdict":"enter|wait|stand_aside|let_expire|edit","proposal":{"entry":0,"stop":0,"take_profit":[{"price":0}],"rationale":"..."},"next_check_min":15,"memo_update":"..."}
Include "proposal" only when verdict is "enter"; include "edit_proposal":{"why":"...","changes":{}} only when verdict is "edit".`

// Is this call market-sensitive enough to warrant the live browse-confirm on a tentative entry? Pure.
export function _isMarketSensitive(call) {
    const lvl = call?.market_sensitivity?.level
    return lvl === 'high' || lvl === 'medium'
}

// Apply the browse-confirm verdict to the first-pass read. FAIL-OPEN: a missing or unparseable
// confirmation keeps the first-pass ENTER (the cheap pass already weighed the live market quote, so a
// flaky web_search must not silently block every entry). ONLY an explicit confirm:false downgrades
// enter → wait, carrying the reason into the read + memo so the timeline shows why it stood aside. Pure.
export function _applyEntryConfirmation(raw, confirm) {
    if (!confirm || confirm.confirm !== false) return raw
    const reason = confirm.reason || confirm.backdrop || 'live broad-market backdrop is adverse'
    return {
        ...raw,
        verdict:     'wait',
        read:        `Stood aside on the entry — ${reason}`,
        proposal:    undefined,
        memo_update: `Entry held by broad-market veto — ${reason}`,
    }
}

const _CONFIRM_SYSTEM = `You are Kairos, sanity-checking a tentative ENTER against the LIVE market backdrop — like a discretionary trader who won't buy a market-sensitive name into a falling tape (or short one into a ripping one).
Use web_search to read the CURRENT broad market RIGHT NOW: index trend on the day, risk-on vs risk-off tone, the VIX regime, and any market-moving macro/Fed/geopolitical headline in the last few hours.
Be strict but not paranoid: veto ONLY when the live tape is genuinely adverse to THIS trade's direction in a way that endangers the entry — a mild, normal pullback is not a veto.
Output ONLY a JSON object, no prose:
{"confirm": true, "backdrop": "one line on what the tape is doing right now", "reason": "if confirm is false, why this entry should stand aside for now"}
confirm=true → the entry still stands; confirm=false → stand aside for now.`

// Second pass (Slice 2 of the hybrid market read): a tentative ENTER on a market-sensitive call gets a
// live web_search confirmation. web_search is an Anthropic server-side tool, so this is a single
// messages.create — the model searches and answers in one round-trip. Never throws — on any failure it
// returns the first-pass raw unchanged (fail-open, see _applyEntryConfirmation).
async function _confirmEntryWithBrowse(call, zone, raw) {
    try {
        const { model, reasoningEffort } = await _hermesRouting(call.user_id)
        const thinking = _thinkingConfig(reasoningEffort)
        const drivers  = (call.market_sensitivity?.drivers ?? []).join(', ') || 'the broad indices'
        const userText = [
            `You tentatively decided ENTER on ${String(call.asset).toUpperCase()} (${call.bias} ${call.trade_type}).`,
            `This asset is ${call.market_sensitivity?.level}-sensitivity to the broad market; its drivers are ${drivers}.`,
            `Read the CURRENT broad-market backdrop and decide whether a ${call.bias} entry in a market-sensitive name should stand aside right now.`,
        ].join('\n')
        const msg = await _client.messages.create({
            model,
            max_tokens: thinking ? ASSESS_MAX_TOKENS_THINKING : CONFIRM_MAX_TOKENS,
            system: [{ type: 'text', text: _CONFIRM_SYSTEM }],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
            messages: [{ role: 'user', content: userText }],
            ...(thinking ?? {}),
        })
        const confirm = extractFirstJSON(_allText(msg))
        if (confirm?.confirm === false) logger.info(LOG, `entry vetoed by live market for ${call.id}: ${confirm.reason || confirm.backdrop || ''}`)
        return _applyEntryConfirmation(raw, confirm)
    } catch (err) {
        logger.warn(LOG, `entry browse-confirm failed for ${call.id} — keeping first-pass enter:`, err.message)
        return raw
    }
}

export async function _defaultAssess(call, zone, ctx) {
    const raw = await _runAssessment(call, _ASSESS_SYSTEM, (tf, candlesText, newsText, marketText) => [
        `CALL: ${JSON.stringify({ asset: call.asset, trade_type: call.trade_type, bias: call.bias, thesis: call.thesis, conviction: call.conviction, entry_zones: call.entry_zones, reference_levels: call.reference_levels, patterns: call.patterns, timeframe_ladder: call.timeframe_ladder, valid_until: call.valid_until })}`,
        `ARMED ZONE: ${zone ? JSON.stringify(zone) : 'none (expiry review)'}`,
        `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
        `REASON WOKEN: ${ctx.reason}`,
        `PRIOR MEMO: ${call.monitor_state?.memo || '(none)'}`,
        candlesText ? `RECENT CANDLES (${tf}):\n${candlesText}` : '',
        newsText ? `RECENT HEADLINES (newest first):\n${newsText}` : 'RECENT HEADLINES: (none available — news axis unsourced)',
        _marketBlock(call, marketText),
        _eventRiskBlock(call),
    ].filter(Boolean).join('\n\n'), 'assessment')

    // Hybrid market read, Slice 2: a tentative ENTER on a market-sensitive call is confirmed against a
    // LIVE browse of the tape before it fires. Only the enter path pays the extra call (rare, decisive).
    if (raw?.verdict === 'enter' && _isMarketSensitive(call)) return _confirmEntryWithBrowse(call, zone, raw)
    return raw
}

const _POSITION_SYSTEM = `You are Kairos, a discretionary day/swing trader MANAGING a live position you already entered (not looking for a new one).
You are given the original call (thesis, patterns, reference levels), the live position (entry fill, working stop, targets, what's been taken, running R-multiple/memo), the current price, a rendered chart, recent candles, and why you were woken.
You're shown the primary chart at the ladder's finest rung; you MAY call get_chart(timeframe) to pull any other ladder rung (e.g. a higher timeframe for structure) before deciding, or skip it when the primary chart is enough.
Manage it like a pro: LET WINNERS RUN, cut when the THESIS breaks, and do NOT micro-manage. Most checks should be "hold". Re-check the ORIGINAL thesis and mapped patterns against what price is doing NOW; weight price action over indicators.
Score the market-conditions axis from the BROAD MARKET block (a LIVE read of SPY/QQQ/VIX + this position's correlated drivers) — not from memory, weighted by the stated sensitivity. For a high-sensitivity position, a sharp risk-off turn in the tape is a reason to protect (move_stop / take_partial); if the block says low-sensitivity/not material, don't let the broad tape drive management.
Score the news/catalyst axis from the RECENT HEADLINES provided (recent-first, dated) AND the SCHEDULED EVENT RISK block — do not invent news from memory. If no headlines are provided, lean "neutral" and say so. A fresh, material catalyst that breaks the original thesis is "blocking" and argues for exit_now.
SCHEDULED EVENT RISK lists known upcoming catalysts (earnings, FOMC, CPI), frozen at build. A looming high-impact event you'd be holding THROUGH is real risk: prefer take_partial or move_stop (tighten) ahead of it rather than carrying full size into an unresolved binary — unless carrying the event is the explicit thesis.
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
    return _runAssessment(call, _POSITION_SYSTEM, (tf, candlesText, newsText, marketText) => [
        `CALL: ${JSON.stringify({ asset: call.asset, trade_type: call.trade_type, bias: call.bias, thesis: call.thesis, patterns: call.patterns, reference_levels: call.reference_levels })}`,
        `POSITION: ${JSON.stringify({ entry: ps.entry, stop: ps.stop, targets: ps.targets, taken: ps.taken, phase: ps.phase })}`,
        `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
        `R-MULTIPLE NOW: ${ctx.metrics?.r_multiple_now ?? 'unknown'}`,
        `REASON WOKEN: ${ctx.reason}`,
        `PENDING CARD: ${ps.pending_action ? JSON.stringify(ps.pending_action) : '(none)'}`,
        `PRIOR MEMO: ${ps.memo || '(none)'}`,
        candlesText ? `RECENT CANDLES (${tf}):\n${candlesText}` : '',
        newsText ? `RECENT HEADLINES (newest first):\n${newsText}` : 'RECENT HEADLINES: (none available — news axis unsourced)',
        _marketBlock(call, marketText),
        _eventRiskBlock(call),
    ].filter(Boolean).join('\n\n'), 'position assessment')
}
