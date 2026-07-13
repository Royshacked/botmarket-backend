import { fetchChartImage } from '../providers/chartImg.provider.js'

// Short-lived chart-image cache, keyed by symbol + timeframe + studies. chart-img is paid /
// rate-limited and the same view is often requested more than once in a short window — an agent's
// internal check then again to show it, get_orderblocks + get_false_breaks on the same plain chart,
// or a Hermes assessment's primary chart plus a tool-loop get_chart on the same rung. One cache
// shared across every caller (agents + the monitor).
//
// Lives in its OWN module (not marketData.tools.js) so the monitor's chart.evaluator can use it
// without the marketData.tools ⇄ chart.evaluator import cycle — this module imports only the
// provider, so nothing depends back on it.
const _chartCache  = new Map()   // key -> { at, png }
const CHART_TTL_MS = 60 * 1000   // intraday views go stale fast; 60s is plenty within a chat / assessment

export async function cachedChartImage(symbol, timeframe, studies) {
    const key = `${symbol}|${timeframe}|${studies.map(s => s.name).join(',')}`
    const hit = _chartCache.get(key)
    if (hit && Date.now() - hit.at < CHART_TTL_MS) return hit.png
    const png = await fetchChartImage(symbol, timeframe, studies)
    if (_chartCache.size > 100) _chartCache.clear()
    _chartCache.set(key, { at: Date.now(), png })
    return png
}
