/**
 * KLineCharts headless renderer — draws OUR OWN chart (self-hosted FMP candles) to a
 * base64 PNG on the server, so the model can visually analyse the same data the monitor
 * evaluates against. Same base64-PNG output shape + call signature as chart-img's
 * fetchChartImage(symbol, timeframe, studies), so it drops into the existing agent / Hermes /
 * monitor / chat-bubble pipeline unchanged.
 *
 * Rendering runs in a headless Chromium (Playwright): a minimal page loads the klinecharts UMD
 * build, we register the custom indicators (VWAP/ATR — not klinecharts built-ins), inject the
 * candle array + indicator descriptors + styles, wait for a real canvas paint, then export via
 * chart.getConvertPictureUrl(). Candles are fetched SERVER-SIDE and injected (no self-HTTP) — the
 * browser only draws.
 */

import { chromium } from 'playwright'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.service.js'
import { parseChartInterval, defaultLookbackDays } from '../candleInterval.util.js'
import { fetchMarketCandles } from '../candleFetch.service.js'
import { studiesToIndicators } from './studyTranslate.js'

const LOG       = '[klineRender.provider]'
const __dirname = dirname(fileURLToPath(import.meta.url))
// UMD build exposes `klinecharts` as a page global — the shape addScriptTag wants.
const KLINE_UMD = join(__dirname, '../../node_modules/klinecharts/dist/umd/klinecharts.min.js')

const DEFAULT_W = 800
const DEFAULT_H = 600
const DAY_MS    = 86_400_000
const BG        = '#020810'   // matches the app chart pane (PriceChart --bg-wash)
// Hard ceiling on a single in-page render. The caller (chartImgCache) also races an outer timeout,
// but this one CLOSES the page so a hung render can't wedge the serialised render chain behind it.
const RENDER_MS = Number(process.env.OWN_CHART_RENDER_PAGE_TIMEOUT_MS) || 10_000

// Concrete dark theme for the headless canvas. The React PriceChart resolves these from CSS
// custom properties at runtime; headless Chromium has no app stylesheet, so we hard-code the
// resolved values here (bright green/red candles read clearly for vision).
const UP   = '#4caf50'
const DOWN = '#ef5350'
const GRID = 'rgba(20, 60, 120, 0.12)'
const AXIS = 'rgba(20, 60, 120, 0.35)'
const AXTX = '#7a9bc0'

function baseStyles() {
    return {
        grid: { horizontal: { color: GRID }, vertical: { color: GRID } },
        candle: {
            bar: {
                upColor: UP, downColor: DOWN, noChangeColor: AXTX,
                upBorderColor: UP, downBorderColor: DOWN, noChangeBorderColor: AXTX,
                upWickColor: UP, downWickColor: DOWN, noChangeWickColor: AXTX,
            },
            tooltip: { showRule: 'none' },
        },
        indicator: {
            bars: [{ upColor: 'rgba(76,175,80,0.55)', downColor: 'rgba(239,83,80,0.55)', noChangeColor: AXTX }],
            tooltip: { showRule: 'none' },
        },
        xAxis: { axisLine: { color: AXIS }, tickLine: { color: AXIS }, tickText: { color: AXTX } },
        yAxis: { axisLine: { color: AXIS }, tickLine: { color: AXIS }, tickText: { color: AXTX } },
        separator: { color: AXIS },
    }
}

// Price decimals for the axis, capped by magnitude (FMP returns noisy floats). Mirrors
// PriceChart.precisionOf so the rendered PNG matches the app chart.
function precisionOf(candles) {
    if (!candles.length) return 2
    const ref = Math.abs(Number(candles[candles.length - 1].close)) || 0
    const cap = ref >= 10 ? 2 : ref >= 1 ? 4 : 6
    let dec = 2
    for (const c of candles.slice(-40)) {
        const s = String(c.close)
        const dot = s.indexOf('.')
        if (dot >= 0) dec = Math.max(dec, s.length - dot - 1)
        if (dec >= cap) break
    }
    return Math.min(dec, cap)
}

// ─── Browser lifecycle + render concurrency ───────────────────────────────────
// One long-lived headless browser, launched on first use and reused across renders (launch is the
// expensive part). Renders run through a bounded concurrency pool (a counting semaphore) so a
// monitor burst can render several charts at once WITHOUT spawning unbounded Chromium pages — the
// cap bounds memory while still overlapping renders (unlike a single serialised chain).
const POOL_SIZE = Math.max(1, Number(process.env.OWN_CHART_RENDER_CONCURRENCY) || 3)
let _browserPromise = null
let _active         = 0
const _waiters      = []

function _acquire() {
    if (_active < POOL_SIZE) { _active++; return Promise.resolve() }
    return new Promise(resolve => _waiters.push(resolve))
}
function _release() {
    const next = _waiters.shift()
    if (next) next()          // hand the slot straight to the next waiter (count stays the same)
    else _active--
}

async function getBrowser() {
    if (!_browserPromise) {
        logger.info(LOG, 'Launching headless Chromium…')
        _browserPromise = chromium.launch({ headless: true }).then(browser => {
            // If Chromium ever dies (crash / OOM), drop the handle so the next render relaunches
            // instead of throwing forever against a dead browser.
            browser.on('disconnected', () => {
                if (_browserPromise) { _browserPromise = null; logger.warn(LOG, 'headless Chromium disconnected — will relaunch on next render') }
            })
            return browser
        }).catch(err => {
            _browserPromise = null   // let the next call retry a fresh launch
            throw err
        })
    }
    return _browserPromise
}

/** Close the shared browser (call on server shutdown). Safe to call when never launched. Bounded by
 *  a short timeout so a wedged Playwright close can't hang graceful shutdown. */
export async function closeRenderer() {
    const p = _browserPromise
    _browserPromise = null
    if (!p) return
    try {
        const browser = await p
        await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))])
    } catch { /* already gone */ }
}

// The in-page render routine, shipped into the browser by Playwright. Returns a data: URL. Custom
// VWAP/ATR are registered here (they travel with the serialised function) so klinecharts can draw
// them; built-ins (EMA/MA/BOLL/RSI/MACD/VOL) just need createIndicator. klinecharts v10 is
// DataLoader-driven — we satisfy getBars with the injected candles once, then wait two animation
// frames so the canvas actually paints before exporting (exporting too early yields a blank PNG).
/* c8 ignore start — runs in the browser, not under node coverage */
async function _inPageRender({ candles, precision, period, styles, bg, overlays, panes }) {
    // ── Custom indicator templates (idempotent across renders on a reused page) ──
    if (!window.__kcCustomsRegistered) {
        // VWAP — session-anchored (reset each UTC day), drawn on the candle pane's price axis.
        klinecharts.registerIndicator({
            name: 'VWAP', shortName: 'VWAP', series: 'price',
            figures: [{ key: 'vwap', title: 'VWAP: ', type: 'line' }],
            calc: (dataList) => {
                let cumPV = 0, cumV = 0, dayKey = null
                return dataList.map((k) => {
                    const d = new Date(k.timestamp)
                    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
                    if (key !== dayKey) { dayKey = key; cumPV = 0; cumV = 0 }
                    const tp = (k.high + k.low + k.close) / 3
                    const v  = k.volume || 0
                    cumPV += tp * v; cumV += v
                    return { vwap: cumV > 0 ? cumPV / cumV : k.close }
                })
            },
        })
        // ATR — Wilder-ish (simple mean of True Range over N), own pane.
        klinecharts.registerIndicator({
            name: 'ATR', shortName: 'ATR', calcParams: [14],
            figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
            calc: (dataList, { calcParams }) => {
                const n = calcParams[0] || 14
                const trs = []
                return dataList.map((k, i) => {
                    const prev = dataList[i - 1]
                    const tr = i === 0
                        ? k.high - k.low
                        : Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close))
                    trs.push(tr)
                    if (trs.length < n) return {}
                    const slice = trs.slice(-n)
                    return { atr: slice.reduce((a, b) => a + b, 0) / n }
                })
            },
        })
        window.__kcCustomsRegistered = true
    }

    const el = document.getElementById('chart')
    const chart = klinecharts.init(el, { locale: 'en-US', styles })

    // Overlays share the candle pane (paneId lives INSIDE the IndicatorCreate object in v10 —
    // there is no 3rd paneOptions arg); each pane indicator stacks in its own sub-pane below.
    for (const d of overlays) chart.createIndicator({ name: d.name, calcParams: d.calcParams, paneId: 'candle_pane' }, true)
    for (const d of panes)    chart.createIndicator({ name: d.name, calcParams: d.calcParams }, false)

    await new Promise((resolve) => {
        let delivered = false
        chart.setDataLoader({
            getBars: ({ type, callback }) => {
                callback(type === 'init' ? candles : [], false)
                if (type === 'init' && !delivered) { delivered = true; resolve() }
            },
            subscribeBar:   () => {},
            unsubscribeBar: () => {},
        })
        chart.setSymbol({ ticker: 'RENDER', pricePrecision: precision, volumePrecision: 0 })
        chart.setPeriod(period)
    })

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return chart.getConvertPictureUrl(true, 'png', bg)
}
/* c8 ignore stop */

/**
 * Render a symbol/timeframe chart to a base64 PNG — the drop-in equivalent of chart-img's
 * fetchChartImage(symbol, timeframe, studies).
 *
 * @param {string}   symbol
 * @param {string}   timeframe  internal spelling ('5min','4hr','day'…) — parseChartInterval
 * @param {object[]} studies    _buildStudies output (chart-img TradingView study objects)
 * @returns {Promise<string>}   base64 PNG (no data: prefix)
 */
export async function renderChartImage(symbol, timeframe, studies = []) {
    const spec = parseChartInterval(timeframe) ?? { timeSpan: 'day', multiplier: 1 }
    const { timeSpan, multiplier } = spec
    const to   = Date.now()
    const from = to - defaultLookbackDays(timeSpan, multiplier) * DAY_MS

    const candles = await fetchMarketCandles(symbol, { timeSpan, multiplier, from, to })
    if (candles.length === 0) throw new Error(`renderChartImage: no candles for ${symbol} ${timeframe}`)

    const { overlays, panes } = studiesToIndicators(studies)
    const period = { type: timeSpan, span: multiplier }

    // Bound concurrency via the pool, then render on a fresh page.
    await _acquire()
    try {
        return await _doRender({ candles, period, precision: precisionOf(candles), overlays, panes })
    } finally {
        _release()
    }
}

async function _doRender({ candles, period, precision, overlays, panes, width = DEFAULT_W, height = DEFAULT_H }) {
    const browser = await getBrowser()
    const page = await browser.newPage({ viewport: { width, height } })
    page.setDefaultTimeout(RENDER_MS)   // bound setContent / addScriptTag
    try {
        await page.setContent(
            `<!doctype html><html><head><meta charset="utf-8"><style>` +
            `html,body{margin:0;padding:0;background:${BG}}` +
            `#chart{width:${width}px;height:${height}px}</style></head>` +
            `<body><div id="chart"></div></body></html>`,
            { waitUntil: 'load' },
        )
        await page.addScriptTag({ path: KLINE_UMD })

        // page.evaluate has no built-in timeout — bound it ourselves so a hung render can't wedge
        // the render chain. The finally-close below frees the browser slot either way.
        let timer
        const evalTimeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`in-page render timed out after ${RENDER_MS}ms`)), RENDER_MS) })
        const dataUrl = await Promise.race([
            page.evaluate(_inPageRender, { candles, precision, period, styles: baseStyles(), bg: BG, overlays, panes }),
            evalTimeout,
        ]).finally(() => clearTimeout(timer))
        const b64 = String(dataUrl || '').replace(/^data:image\/png;base64,/, '')
        if (!b64) throw new Error('render produced an empty image')
        logger.info(LOG, `Rendered ${candles.length} candles (${overlays.length} overlay, ${panes.length} pane) → PNG (${b64.length} b64)`)
        return b64
    } finally {
        await page.close().catch(() => {})
    }
}
