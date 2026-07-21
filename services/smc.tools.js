// Numeric SMC tools (K2) — expose the deterministic smc.engine primitives as agent tools that fetch
// OHLCV, compute EXACT levels, and hand them back as text. SHARED (reusable by Argus/Hermes); wired
// into the Kairos SMC mode. Reuses the one candle-fetch path from marketData.tools (DRY).

import { makeToolHandler } from './agentUtils.js'
import { _fetchCandleRows } from './marketData.tools.js'
import { detectFVG, detectStructure, detectLiquidity, premiumDiscount, detectOrderBlocks, priorLevels } from './smc.engine.js'

const LOG = '[smcTools]'
const TF_DESC = 'timeframe rung, e.g. 5min, 15min, 1hr, 4hr, day'
const fmt = n => (n == null ? '?' : Number(n).toFixed(2))

async function _bars(ticker, timeframe) {
    const { bars, cfg } = await _fetchCandleRows(ticker, timeframe)
    return bars.slice(-cfg.count)
}

const _schema = { type: 'object', properties: {
    ticker:    { type: 'string', description: 'ticker symbol e.g. AAPL, NVDA' },
    timeframe: { type: 'string', description: TF_DESC },
}, required: ['ticker', 'timeframe'] }

export const SMC_TOOLS = [
    { name: 'get_fvg', description: 'Fair-value gaps (3-candle imbalances) computed from OHLCV — exact bullish/bearish gap ranges, newest first, with whether each is still unfilled. Unfilled FVGs are draws + entry zones. SMC mode.', input_schema: _schema },
    { name: 'get_structure', description: 'Market structure from OHLCV: trend (up/down/range), the last BOS (continuation) or CHoCH (reversal) with its exact broken level, the last swing high/low, the premium/discount split of the dealing range, and the fresh order-block zones (origin of the last impulses). SMC mode\'s core structural read.', input_schema: _schema },
    { name: 'get_liquidity', description: 'Liquidity pools from OHLCV: near-equal swing highs (buy-side, above) and lows (sell-side, below) where stops cluster — the exact levels price is drawn to sweep. SMC mode.', input_schema: _schema },
    { name: 'get_key_levels', description: 'Exact prior-day and current-day high/low from OHLCV — the session "draw on liquidity" references (PDH/PDL). Useful in BOTH discretionary (prior-day levels) and SMC (session liquidity). Best on an intraday/day timeframe.', input_schema: _schema },
]

export const SMC_TOOL_HANDLERS = {
    get_fvg: makeToolHandler('get_fvg', async ({ ticker, timeframe }) => {
        const gaps = detectFVG(await _bars(ticker, timeframe))
        const open = gaps.filter(g => !g.mitigated).slice(0, 8)
        if (gaps.length === 0) return `${ticker.toUpperCase()} ${timeframe}: no fair-value gaps found.`
        const line = g => `${g.type} FVG ${fmt(g.bottom)}–${fmt(g.top)}${g.mitigated ? ' (mitigated)' : ''}`
        return `${ticker.toUpperCase()} ${timeframe} — ${open.length} unfilled FVG(s), newest first:\n`
            + (open.length ? open.map(line).join('\n') : gaps.slice(0, 6).map(line).join('\n'))
    }, (err, { ticker }) => `Could not compute FVGs for ${ticker}: ${err.message}`, LOG),

    get_structure: makeToolHandler('get_structure', async ({ ticker, timeframe }) => {
        const bars = await _bars(ticker, timeframe)
        const s  = detectStructure(bars)
        const pd = premiumDiscount(bars)
        const obs = detectOrderBlocks(bars).filter(o => !o.mitigated).slice(0, 5)
        const ev = s.event ? `${s.event.type} ${s.event.direction} @ ${fmt(s.event.level)}` : 'no fresh break'
        const pdTxt = pd ? `range ${fmt(pd.low)}–${fmt(pd.high)}, eq ${fmt(pd.equilibrium)} → ${pd.zone}` : 'no clean range'
        const obTxt = obs.length ? obs.map(o => `${o.type} OB ${fmt(o.bottom)}–${fmt(o.top)}`).join(', ') : 'none fresh'
        return `${ticker.toUpperCase()} ${timeframe} — structure:\n`
            + `trend: ${s.trend}\nlast event: ${ev}\n`
            + `last swing high: ${fmt(s.lastSwingHigh)} · last swing low: ${fmt(s.lastSwingLow)}\n`
            + `premium/discount: ${pdTxt}\norder blocks (fresh): ${obTxt}`
    }, (err, { ticker }) => `Could not compute structure for ${ticker}: ${err.message}`, LOG),

    get_key_levels: makeToolHandler('get_key_levels', async ({ ticker, timeframe }) => {
        const lv = priorLevels(await _bars(ticker, timeframe))
        return `${ticker.toUpperCase()} ${timeframe} — key levels:\n`
            + `prior-day: H ${fmt(lv.priorDayHigh)} · L ${fmt(lv.priorDayLow)}\n`
            + `current-day: H ${fmt(lv.currentDayHigh)} · L ${fmt(lv.currentDayLow)}`
    }, (err, { ticker }) => `Could not compute key levels for ${ticker}: ${err.message}`, LOG),

    get_liquidity: makeToolHandler('get_liquidity', async ({ ticker, timeframe }) => {
        const liq = detectLiquidity(await _bars(ticker, timeframe))
        const pool = p => `${fmt(p.price)} (${p.count}×)`
        const bs = liq.buyside.length  ? liq.buyside.map(pool).join(', ')  : 'none'
        const ss = liq.sellside.length ? liq.sellside.map(pool).join(', ') : 'none'
        return `${ticker.toUpperCase()} ${timeframe} — liquidity pools:\n`
            + `buy-side (equal highs, above): ${bs}\nsell-side (equal lows, below): ${ss}`
    }, (err, { ticker }) => `Could not compute liquidity for ${ticker}: ${err.message}`, LOG),
}
