import { fetchChartImage } from '../providers/chartImg.provider.js'
import { renderChartImage } from './chartRender/klineRender.provider.js'
import { createTtlCache } from './ttlCache.util.js'
import { withTimeout } from './timeout.util.js'
import { logger } from './logger.service.js'
import { config } from './config.js'

// Short-lived chart-image cache, keyed by symbol + timeframe + studies. Chart rendering is the
// same view is often requested more than once in a short window — an agent's internal check then
// again to show it, get_orderblocks + get_false_breaks on the same plain chart, or a Hermes
// assessment's primary chart plus a tool-loop get_chart on the same rung. One cache shared across
// every caller (agents + the monitor).
//
// Lives in its OWN module (not marketData.tools.js) so the monitor's chart.evaluator can use it
// without the marketData.tools ⇄ chart.evaluator import cycle — this module imports only the
// providers, so nothing depends back on it.
const LOG          = '[chartImgCache]'
const CHART_TTL_MS = 60 * 1000   // intraday views go stale fast; 60s is plenty within a chat / assessment
const _chartCache  = createTtlCache({ ttlMs: CHART_TTL_MS, max: 100 })   // key -> base64 png

// ─── Renderer selection (FALLBACK-FIRST rollout) ──────────────────────────────
// The own-chart headless renderer (KLineCharts + our FMP candles) tries first; ANY failure or a
// timeout falls back to the legacy chart-img (TradingView) provider, so a render bug or a cold
// Chromium can never break the agents/monitor. Gated by OWN_CHART_RENDER so it can be turned off
// instantly in prod. NOTE: while a chart is fallback-served it's "degraded" — the FMP↔TradingView
// data-consistency win only holds for own-render-served charts. Retire the fallback once the own
// renderer is proven stable live.
const OWN_RENDER_ON     = config.ownChartRender
// Outer (caller) budget bounds the TOTAL wait incl. pool-queue time. Keep it ABOVE the provider's
// per-render page timeout (OWN_CHART_RENDER_PAGE_TIMEOUT_MS, default 10s) so a render that actually
// runs isn't abandoned mid-flight and needlessly re-fetched from chart-img.
const RENDER_TIMEOUT_MS = config.ownChartRenderTimeoutMs

/** Produce a chart PNG: own renderer first, chart-img as fallback. Returns base64 PNG. */
async function _renderPng(symbol, timeframe, studies) {
    if (!OWN_RENDER_ON) return fetchChartImage(symbol, timeframe, studies)
    try {
        const png = await withTimeout(renderChartImage(symbol, timeframe, studies), RENDER_TIMEOUT_MS, 'own-render')
        logger.info(LOG, `served by own-render: ${symbol}/${timeframe}`)
        return png
    } catch (err) {
        logger.warn(LOG, `own-render failed for ${symbol}/${timeframe} (${err.message}) — falling back to chart-img [DEGRADED]`)
        return fetchChartImage(symbol, timeframe, studies)
    }
}

// A study's identity is its name AND its params — EMA(20) and EMA(50) share the name
// 'Moving Average Exponential', so keying on name alone would collide and serve the wrong chart.
function _studyKey(s) {
    const params = s.input ? Object.values(s.input).join('-') : ''
    return params ? `${s.name}(${params})` : s.name
}

export async function cachedChartImage(symbol, timeframe, studies) {
    const key = `${symbol}|${timeframe}|${studies.map(_studyKey).join(',')}`
    const hit = _chartCache.get(key)
    if (hit) return hit
    const png = await _renderPng(symbol, timeframe, studies)
    return _chartCache.set(key, png)
}
