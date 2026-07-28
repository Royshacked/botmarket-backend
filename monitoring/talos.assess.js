import Anthropic from '@anthropic-ai/sdk'
import { getQuotes, getShortInterest, getOptionsContext } from '../providers/yahoofinance.provider.js'
import { getDerivativesContext } from '../providers/binance.provider.js'
import { getFundamentals }       from '../providers/fmp.provider.js'
import { buildStudies }          from './evaluators/chart.evaluator.js'
import { sessionPhase }          from '../services/market.service.js'
import { cachedChartImage }      from '../services/chartImgCache.service.js'
import { newsService }           from '../services/news.service.js'
import { logger }                from '../services/logger.service.js'
import { extractFirstJSON }      from './monitorUtils.js'
import { assessRouting, candlesText as _candlesText, BROAD_INDICES,
    ASSESS_MAX_TOKENS as MAX_TOKENS, ASSESS_MAX_TOKENS_THINKING as MAX_TOKENS_THINKING } from './assess.shared.js'
import {
    _thinkingConfig, _allText, _formatHeadlines, _formatEventRisk,
    _chartTool, _structureTools, _smcTools, _institutionalTools, _handleAssessToolUses,
} from './hermes.assess.js'

// Talos's assessment — the setup-driven counterpart to Hermes's four-axis read.
//
// SHARED with Hermes (docs/setup-entity.md §8): every tool builder (_chartTool / _structureTools /
// _smcTools / _institutionalTools), the ladder-locked tool-use handler, the thinking config and the
// text extraction. Those are the pipe.
//
// NOT shared — deliberately, and this is the whole point of the kind: the GATHER step. Hermes
// fetches chart + candles + headlines + market on every wake because a call always scores four
// fixed axes. A setup declares what matters in `watch[]`, so Talos fetches only what was declared.
// A purely structural setup costs one chart + candles; it never pays for headlines or index quotes.

const LOG = '[talos.assess]'

const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MAX_TOOL_ROUNDS = 3

// Verdicts Talos may return pre-entry. Anything off-menu is coerced to 'wait' by the monitor.
export const READINESS_VERDICTS = new Set(['enter', 'wait', 'stand_aside', 'edit', 'let_expire'])

/** The distinct kinds declared on a setup. */
export function declaredKinds(setup) {
    return new Set((setup?.watch ?? []).map(w => w.kind))
}

/**
 * The tool set for a setup: the chart is always available (the read is visual at heart), plus
 * exactly the toolkits its declared factors need.
 *
 * `structure` mounts the numeric SMC engine — the SAME computations the setup was built on, so
 * an SMC setup is verified against its own levels rather than a re-eyeballed chart. `price_action`
 * mounts the classical vision reads. A setup declaring neither still gets the chart.
 */
export function buildToolsFor(setup) {
    const ladder = setup?.ladder?.length ? setup.ladder : ['15min']
    const kinds  = declaredKinds(setup)
    return [
        ..._chartTool(ladder),
        ...(kinds.has('price_action') ? _structureTools(ladder) : []),
        ...(kinds.has('structure')    ? _smcTools(ladder)       : []),
        ...(kinds.has('positioning')  ? _institutionalTools()   : []),
    ]
}

// ─── Gather (only what was declared) ──────────────────────────────────────────

async function _positioningText(asset, assetClass) {
    const isCrypto = String(assetClass || '').toLowerCase() === 'crypto'
    const reads = isCrypto
        ? [['derivatives', getDerivativesContext(asset)]]
        : [['short interest', getShortInterest(asset)], ['options', getOptionsContext(asset)]]
    const out = await Promise.all(reads.map(async ([label, p]) => {
        try { return `${label}: ${await p}` } catch { return '' }
    }))
    return out.filter(Boolean).join('\n')
}

/**
 * Fetch exactly the blocks this setup's `watch[]` asks for, in parallel. Every read is
 * independently guarded — one failed provider degrades its own block to empty rather than
 * killing the assessment, because a partial read is still worth judging.
 *
 * Deps injectable so the monitor's tests exercise the gating without network IO.
 */
export async function gatherFor(setup, tf, deps = {}) {
    const {
        renderChart = cachedChartImage,
        candlesText = _candlesText,
        quotes      = getQuotes,
        news        = (sym) => newsService.getOrFetch({ category: 'companies', subject: sym, query: sym }),
        positioning = _positioningText,
        fundamentals = getFundamentals,
    } = deps

    const asset = String(setup.asset).toUpperCase()
    const kinds = declaredKinds(setup)
    const want  = (k) => kinds.has(k)

    // Correlation names only the symbols the setup actually leans on — never a blanket sweep.
    const corrSymbols = [...new Set((setup.watch ?? [])
        .filter(w => w.kind === 'correlation')
        .flatMap(w => w.symbols ?? []))].slice(0, 6)

    const [png, candles, marketQ, corrQ, headlines, posText, fundText] = await Promise.all([
        renderChart(asset, tf, buildStudies('vwap, ema(50), volume', { fillDefaults: false })).catch(() => null),
        candlesText(asset, tf).catch(() => ''),
        want('market')      ? quotes(BROAD_INDICES).catch(() => '') : Promise.resolve(''),
        corrSymbols.length  ? quotes(corrSymbols).catch(() => '')   : Promise.resolve(''),
        want('news')        ? news(asset).then(r => _formatHeadlines(r?.articles)).catch(() => '') : Promise.resolve(''),
        want('positioning') ? positioning(asset, setup.asset_class).catch(() => '') : Promise.resolve(''),
        want('fundamental') ? fundamentals(asset).then(String).catch(() => '')      : Promise.resolve(''),
    ])

    return { png, candles, marketQ, corrQ, headlines, posText, fundText }
}

// ─── Prompt assembly ──────────────────────────────────────────────────────────

const _SYSTEM = `You are Talos, the guardian watching a trade SETUP the user built with Mentor. Price has reached one of the setup's zones (or the setup is near expiry) and you were woken to judge the moment.

You are given the setup — its THESIS, its zones, and its WATCH LIST — plus a chart, recent candles, the current price, and only the market data the watch list asked for.

THE WATCH LIST IS YOUR MANDATE. Judge each declared factor against what price is doing NOW, by its own look_for cue and its own timeframe. A factor marked "primary" is the trigger itself: if it is not happening, this is not the moment. A "confirming" factor that fails weakens the read but does not by itself veto it.

Do NOT grade dimensions the setup did not declare. If it says nothing about news or the broad market, their absence is deliberate — the user judged them immaterial. Say nothing about them and do not go looking.

The one exception is SCHEDULED EVENT RISK, which is always checked. A high-impact event landing before this trade's expected exit, when the thesis is not itself an event play, is a real reason to prefer "wait" — do not walk into an unresolved binary just because price tagged the zone.

Weight price action over indicators. Be strict: most checks should NOT be "enter". Judge the whole picture, not a checklist — if material new information appears that the setup never mapped, say so and factor it in.

Weigh the author's CONVICTION as their own honest read at build time: a high-conviction setup earns the benefit of the doubt on a marginal call; a low-conviction one needs everything lining up. Never recompute their conviction — it is not yours to revise.

Always include "read": ONE short, plain first-person sentence — what you see and what you're doing about it. This is your live monologue; keep it human and specific.

Verdicts: "enter" (this is the moment), "wait" (not yet, keep watching), "stand_aside" (the premise is damaged — don't take it now), "edit" (the map is stale and needs re-drawing; provide edit_proposal), "let_expire" (expiry review only).

Output ONLY a JSON object, no prose:
{"timeframe_used":"15min","read":"<one first-person sentence>","factors":[{"kind":"structure","present":true,"note":"..."}],"verdict":"enter|wait|stand_aside|edit|let_expire","warning":"<one line, ONLY when the verdict is not enter: what is missing or wrong, for the setup's record — the user is NOT asked to enter on a non-enter verdict, so this is not pre-confirmation copy>","next_check_min":15,"memo_update":"..."}
Include "edit_proposal":{"why":"...","changes":{}} only when the verdict is "edit".`

function _watchBlock(setup) {
    const watch = setup?.watch ?? []
    if (!watch.length) {
        return 'WATCH LIST: (empty — the setup declares no factors, so judge on price structure at the zone alone)'
    }
    const lines = watch.map(w => {
        const where = w.timeframe ? ` @${w.timeframe}` : (w.symbols?.length ? ` [${w.symbols.join(', ')}]` : '')
        return `- ${w.kind}${where} (${w.weight}): ${w.look_for}`
    })
    return `WATCH LIST — judge exactly these, nothing else:\n${lines.join('\n')}`
}

function _dataBlocks(setup, g, tf) {
    const kinds = declaredKinds(setup)
    const out = []
    if (g.candles)  out.push(`RECENT CANDLES (${tf}):\n${g.candles}`)
    if (kinds.has('correlation')) {
        out.push(g.corrQ ? `CORRELATED NAMES (live):\n${g.corrQ}` : 'CORRELATED NAMES: (live read unavailable — weigh this factor cautiously)')
    }
    if (kinds.has('market')) {
        out.push(g.marketQ ? `BROAD MARKET (live SPY/QQQ/VIX):\n${g.marketQ}` : 'BROAD MARKET: (live read unavailable)')
    }
    if (kinds.has('news')) {
        out.push(g.headlines ? `RECENT HEADLINES (newest first):\n${g.headlines}` : 'RECENT HEADLINES: (none available — the news factor is unsourced; lean neutral and say so)')
    }
    if (kinds.has('positioning') && g.posText)  out.push(`POSITIONING:\n${g.posText}`)
    if (kinds.has('fundamental') && g.fundText) out.push(`FUNDAMENTALS:\n${g.fundText}`)

    const ev = _formatEventRisk(setup?.event_risk)
    out.push(ev
        ? `SCHEDULED EVENT RISK (frozen at build — always checked):\n${ev}`
        : 'SCHEDULED EVENT RISK: (none flagged in the next ~10 days)')
    return out
}

/**
 * Run one readiness assessment. Never throws — a failed read returns a typed failure marker so
 * the caller's timeline entry can be honest about WHY (bad reply vs failed IO) and reschedule on
 * the normal cadence rather than wedging the loop.
 */
export async function assessSetup(setup, zone, ctx = {}) {
    try {
        const ladder = setup?.ladder?.length ? setup.ladder : ['15min']
        const tf     = ladder[ladder.length - 1]   // primary view = the ladder's finest rung
        const g      = await gatherFor(setup, tf)

        const userText = [
            `SETUP: ${JSON.stringify({
                asset: setup.asset, direction: setup.direction, type: setup.type,
                trade_mode: setup.trade_mode, timeframe: setup.timeframe, thesis: setup.thesis,
                entry_zones: setup.entry_zones, stop_zones: setup.stop_zones, tp_zones: setup.tp_zones,
                conviction: setup.conviction, rr: setup.rr, valid_until: setup.valid_until,
            })}`,
            _watchBlock(setup),
            `ARMED ZONE: ${zone ? JSON.stringify(zone) : '(none — expiry review)'}`,
            `CURRENT PRICE: ${ctx.price ?? 'unknown'}`,
            `SESSION NOW: ${sessionPhase(setup.asset, setup.asset_class)}`,
            `REASON WOKEN: ${ctx.reason ?? 'zone_trip'}`,
            `LENS: ${setup.trade_mode === 'smc'
                ? 'this setup was built on Smart-Money structure — verify the structural trigger with get_structure / get_fvg / get_liquidity rather than trusting the build-time map.'
                : 'this setup was built on classical price action — verify with the chart, order blocks and false breaks.'}`,
            `PRIOR MEMO: ${setup.monitor_state?.memo || '(none)'}`,
            ..._dataBlocks(setup, g, tf),
        ].filter(Boolean).join('\n\n')

        const primary = g.png
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: g.png } }, { type: 'text', text: userText }]
            : userText

        const { model, reasoningEffort } = await assessRouting(setup.userId)
        const thinking  = _thinkingConfig(reasoningEffort)
        const maxTokens = thinking ? MAX_TOKENS_THINKING : MAX_TOKENS
        const system    = [{ type: 'text', text: _SYSTEM, cache_control: { type: 'ephemeral' } }]
        const tools     = buildToolsFor(setup)
        const messages  = [{ role: 'user', content: primary }]

        // Adaptive-timeframe loop: the read may pull extra ladder-rung views before deciding.
        // On the final allowed round the tools are dropped, forcing a JSON answer rather than
        // another request.
        let msg
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            msg = await _client.messages.create({
                model, max_tokens: maxTokens, system, messages,
                ...(round < MAX_TOOL_ROUNDS ? { tools } : {}),
                ...(thinking ?? {}),
            })
            if (msg.stop_reason !== 'tool_use') break
            messages.push({ role: 'assistant', content: msg.content })
            // The handler only reads `.asset` off its first argument, so the setup stands in for a call.
            messages.push({ role: 'user', content: await _handleAssessToolUses(setup, msg.content, ladder) })
        }

        try {
            return extractFirstJSON(_allText(msg))
        } catch (parseErr) {
            logger.warn(LOG, `reply unparseable for ${setup.id} (stop_reason=${msg?.stop_reason}):`, parseErr.message)
            return { _failReason: msg?.stop_reason === 'max_tokens' ? 'truncated' : 'malformed' }
        }
    } catch (err) {
        logger.warn(LOG, `assessment failed for ${setup?.id}:`, err.message)
        return { _failReason: 'io' }
    }
}
