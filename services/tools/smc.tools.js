// Numeric SMC tools — expose the deterministic smc.engine primitives as agent tools that fetch
// OHLCV, compute EXACT levels, and hand them back as text.
//
// The compute+format is a PURE function (smcReadText) shared by the BUILD side and the MONITOR side,
// which is the point: a monitor reads an SMC setup through the same exact-level lens it was built
// on. Today that means Mentor (via trading.tools) and Argus on the build side, and Talos (via
// monitoring/assessTools) on the monitor side.
//
// This header used to name Kairos and Hermes as the two consumers. Both were archived on 2026-08-18
// and the arrangement outlived them unchanged — which is the trap: a reader chasing "who shares
// this" was sent to dead code for the reason live code is shaped this way. smcReadText's only
// remaining archive caller is hermes.assess, which is why check:archive covers it.

import { makeToolHandler } from '../agentUtils.js'
import { _fetchCandleRows } from './marketData.tools.js'
import { detectFVG, detectStructure, detectLiquidity, premiumDiscount, detectOrderBlocks, priorLevels } from '../smc.engine.js'

const LOG = '[smcTools]'
const TF_DESC = 'timeframe rung, e.g. 5min, 15min, 1hr, 4hr, day'
const fmt = n => (n == null ? '?' : Number(n).toFixed(2))

export const SMC_TOOL_NAMES = ['get_fvg', 'get_structure', 'get_liquidity', 'get_key_levels']

// Fetch the recent bars for a ticker/timeframe (reuses the one candle-fetch path).
export async function smcBars(ticker, timeframe) {
    const { bars, cfg } = await _fetchCandleRows(ticker, timeframe)
    return bars.slice(-cfg.count)
}

/**
 * PURE compute + format for one SMC tool from bars. Shared by the build handlers and the monitor
 * side, so both read a setup's structure through the same lens — see the header.
 * @returns {string} the text the model reads.
 */
export function smcReadText(name, ticker, timeframe, bars) {
    const T = String(ticker).toUpperCase()
    if (name === 'get_fvg') {
        const gaps = detectFVG(bars)
        if (!gaps.length) return `${T} ${timeframe}: no fair-value gaps found.`
        const open = gaps.filter(g => !g.mitigated).slice(0, 8)
        const line = g => `${g.type} FVG ${fmt(g.bottom)}–${fmt(g.top)}${g.mitigated ? ' (mitigated)' : ''}`
        return `${T} ${timeframe} — ${open.length} unfilled FVG(s), newest first:\n`
            + (open.length ? open.map(line).join('\n') : gaps.slice(0, 6).map(line).join('\n'))
    }
    if (name === 'get_structure') {
        const s   = detectStructure(bars)
        const pd  = premiumDiscount(bars)
        const obs = detectOrderBlocks(bars).filter(o => !o.mitigated).slice(0, 5)
        const ev  = s.event ? `${s.event.type} ${s.event.direction} @ ${fmt(s.event.level)}` : 'no fresh break'
        const pdTxt = pd ? `range ${fmt(pd.low)}–${fmt(pd.high)}, eq ${fmt(pd.equilibrium)} → ${pd.zone}` : 'no clean range'
        const obTxt = obs.length ? obs.map(o => `${o.type} OB ${fmt(o.bottom)}–${fmt(o.top)}`).join(', ') : 'none fresh'
        return `${T} ${timeframe} — structure:\n`
            + `trend: ${s.trend}\nlast event: ${ev}\n`
            + `last swing high: ${fmt(s.lastSwingHigh)} · last swing low: ${fmt(s.lastSwingLow)}\n`
            + `premium/discount: ${pdTxt}\norder blocks (fresh): ${obTxt}`
    }
    if (name === 'get_liquidity') {
        const liq  = detectLiquidity(bars)
        const pool = p => `${fmt(p.price)} (${p.count}×)`
        const bs = liq.buyside.length  ? liq.buyside.map(pool).join(', ')  : 'none'
        const ss = liq.sellside.length ? liq.sellside.map(pool).join(', ') : 'none'
        return `${T} ${timeframe} — liquidity pools:\nbuy-side (equal highs, above): ${bs}\nsell-side (equal lows, below): ${ss}`
    }
    if (name === 'get_key_levels') {
        const lv = priorLevels(bars)
        return `${T} ${timeframe} — key levels:\n`
            + `prior-day: H ${fmt(lv.priorDayHigh)} · L ${fmt(lv.priorDayLow)}\n`
            + `current-day: H ${fmt(lv.currentDayHigh)} · L ${fmt(lv.currentDayLow)}`
    }
    return `unknown SMC tool: ${name}`
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

// Thin build-agent handlers: fetch bars → the shared pure formatter.
const _handler = (name) => makeToolHandler(
    name,
    async ({ ticker, timeframe }) => smcReadText(name, ticker, timeframe, await smcBars(ticker, timeframe)),
    (err, { ticker }) => `Could not compute ${name} for ${ticker}: ${err.message}`,
    LOG,
)
export const SMC_TOOL_HANDLERS = Object.fromEntries(SMC_TOOL_NAMES.map(n => [n, _handler(n)]))
