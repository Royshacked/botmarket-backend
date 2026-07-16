/**
 * Translate chart-img TradingView study objects (the output of `_buildStudies` in
 * chart.evaluator.js) into klinecharts v10 indicator descriptors, so the headless renderer draws
 * the SAME overlays the old TradingView PNG did. `_buildStudies` stays the single source of truth
 * for WHAT to draw; this is only the name/param translation layer — do not re-parse conditions here.
 *
 * klinecharts built-ins cover MA / EMA / SMA / BOLL / RSI / MACD / VOL. ATR and VWAP are NOT
 * built-in (verified against klinecharts@10.0.0 getSupportedIndicators), so they're flagged
 * `custom: true` and registered in-page by the renderer.
 *
 * A descriptor is: { name, calcParams, overlay, custom }
 *   overlay=true  → draw on the candle pane (moving averages, bands, vwap)
 *   overlay=false → own stacked sub-pane (rsi, macd, atr, volume)
 */

function _num(v, fallback) {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
}

/** One chart-img study → one klinecharts descriptor, or null if unmapped. */
function translateStudy(study) {
    if (!study || typeof study.name !== 'string') return null
    const inp = study.input || {}
    switch (study.name) {
        case 'Moving Average Exponential':
            return { name: 'EMA', calcParams: [_num(inp.in_0, 20)], overlay: true, custom: false }
        case 'Moving Average':
            return { name: 'MA', calcParams: [_num(inp.in_0, 20)], overlay: true, custom: false }
        case 'Bollinger Bands':
            return { name: 'BOLL', calcParams: [_num(inp.in_0, 20), _num(inp.in_1, 2)], overlay: true, custom: false }
        case 'VWAP':
            return { name: 'VWAP', calcParams: [], overlay: true, custom: true }
        case 'Relative Strength Index':
            return { name: 'RSI', calcParams: [_num(inp.in_0, 14)], overlay: false, custom: false }
        case 'MACD':
            return { name: 'MACD', calcParams: [_num(inp.in_0, 12), _num(inp.in_1, 26), _num(inp.in_2, 9)], overlay: false, custom: false }
        case 'Average True Range':
            return { name: 'ATR', calcParams: [_num(inp.in_0, 14)], overlay: false, custom: true }
        case 'Volume':
            return { name: 'VOL', calcParams: [], overlay: false, custom: false }
        default:
            return null
    }
}

/**
 * Translate a studies array → { overlays, panes } (each a descriptor list). Unmapped studies are
 * dropped silently (same tolerance as chart-img ignoring an unknown study). The custom templates
 * (VWAP/ATR) are registered unconditionally by the renderer, so no "needs" flags are returned.
 *
 * @param {Array<{name:string,input?:object}>} studies
 */
export function studiesToIndicators(studies = []) {
    const overlays = []
    const panes    = []

    for (const s of Array.isArray(studies) ? studies : []) {
        const d = translateStudy(s)
        if (!d) continue
        ;(d.overlay ? overlays : panes).push(d)
    }
    return { overlays, panes }
}

export { translateStudy }
