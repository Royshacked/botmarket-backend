// Analyst valuation tools (P2) — expose the consensus feeds + the deterministic valuation.engine as
// agent tools. get_consensus = the qualitative "what the Street thinks" read (the variant-perception
// anchor). compute_valuation = OUR price target from a justified multiple × a forward metric, with the
// GAP vs the Street. The agent supplies the judgment (which multiple, whose estimate); these tools
// supply the data + the math. Pure formatters are exported for tests.

import { getAnalystEstimates, getPriceTargetConsensus, getGradesConsensus, getGradesHistorical, getHistoricalMultiples } from '../../providers/fmp.provider.js'
import { computeValuation, VALUATION_METHODS } from '../valuation.engine.js'
import { fetchLastPrice } from '../../monitoring/monitorUtils.js'
import { makeToolHandler } from '../agentUtils.js'

const LOG = '[valuationTools]'

// forward-metric field (on an estimates row) per valuation method.
const _FWD_FIELD = { pe: 'eps', ev_sales: 'revenue', ev_ebitda: 'ebitda' }

const _money = v => {
    if (!Number.isFinite(v)) return 'n/a'
    const a = Math.abs(v)
    if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
    if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
    return `$${v.toFixed(0)}`
}
const _sign = n => (n >= 0 ? '+' : '')

// ─── pure formatters ─────────────────────────────────────────────────────────
/** Net rating score of a grades-historical row: (strong_buy+buy) − (sell+strong_sell). */
function _netGrade(r) { return (r.strong_buy + r.buy) - (r.sell + r.strong_sell) }

function _revisionTrend(gradesHist) {
    const h = Array.isArray(gradesHist) ? gradesHist.filter(Boolean) : []
    if (h.length < 2) return 'n/a'
    const newest = _netGrade(h[0]), oldest = _netGrade(h[h.length - 1])   // gradesHist is newest-first
    if (newest > oldest) return 'improving (ratings migrating UP — bullish revision)'
    if (newest < oldest) return 'deteriorating (ratings migrating DOWN)'
    return 'stable'
}

export function formatConsensus(sym, { estimates, pt, grades, gradesHist } = {}) {
    const S = String(sym || '').toUpperCase().trim()
    const lines = [`Street consensus for ${S}:`]
    const next = estimates?.next
    if (next) {
        const bits = [next.eps != null ? `EPS ${next.eps}` : null, next.revenue != null ? `Revenue ${_money(next.revenue)}` : null, next.ebitda != null ? `EBITDA ${_money(next.ebitda)}` : null].filter(Boolean)
        lines.push(`- Estimates (FY${next.fy}): ${bits.join(', ') || 'n/a'}${next.num_analysts ? ` [${next.num_analysts} analysts]` : ''}`)
    } else lines.push('- Estimates: none available')
    lines.push(pt && pt.consensus != null ? `- Price target: consensus ${pt.consensus}${pt.low != null && pt.high != null ? ` (range ${pt.low}–${pt.high})` : ''}` : '- Price target: none')
    if (grades?.rating) {
        const c = grades.counts
        lines.push(`- Rating: ${grades.rating} — SB${c.strong_buy}/B${c.buy}/H${c.hold}/S${c.sell}/SS${c.strong_sell}`)
    } else lines.push('- Rating: none')
    lines.push(`- Revision trend: ${_revisionTrend(gradesHist)}`)
    return lines.join('\n')
}

/** Render a computeValuation() result as an LLM-ready read. `meta` carries {fy, consensusMetric}. */
export function valuationReadText(sym, method, result, meta = {}) {
    const S = String(sym || '').toUpperCase().trim()
    if (!result || result.ok !== true) {
        const why = {
            forward_metric_required: 'no positive forward metric (a loss can’t be multipled — try another method or estimate)',
            no_multiple: 'no justified multiple given and no usable history — provide a `multiple`',
            ev_needs_shares: 'EV method needs shares_out (+ net_debt) for the equity bridge — pass them or use pe',
        }[result?.reason] || result?.reason || 'unknown'
        return `Could not value ${S} on ${method}: ${why}.`
    }
    const m = result.multiple, pt = result.pt
    const ctx = [
        result.historical_median_multiple != null ? `own hist median ${result.historical_median_multiple}x` : null,
        result.peer_median_multiple != null ? `peers ${result.peer_median_multiple}x` : null,
    ].filter(Boolean)
    const fwdSrc = meta.consensusMetric ? 'consensus' : 'our estimate'
    const gapLine = result.gap
        ? `${_sign(result.gap.value)}${result.gap.value} (${_sign(result.gap.pct)}${result.gap.pct}%) vs Street`
        : 'n/a (no consensus PT)'
    // Deliberately says "vs the Street", never "bullish"/"bearish" unqualified. Being under the
    // consensus is a variant view about the CONSENSUS — it is not a view on the stock, and reading it
    // as one is what produced a `sell` rating on a name trading 10% BELOW its own price target.
    const edge = result.gap
        ? (result.gap.pct > 3 ? 'ABOVE the Street — a variant view vs consensus (relative; not yet a rating)' : result.gap.pct < -3 ? 'BELOW the Street — a variant view vs consensus (relative; not yet a rating)' : 'in line with the Street — thin edge, may not be worth covering')
        : 'no consensus to compare'
    // THE RATING LEG. The gap above is measured against the Street; a rating is measured against the
    // PRICE, and only this line carries it. Stated as what the target can and cannot support, because
    // the failure mode is silent: nothing downstream re-checks the direction of a rating.
    const marketLine = (result.current_price !== null && result.upside_pct !== null)
        ? `- vs the MARKET: price ${result.current_price} → our target implies ${_sign(result.upside_pct)}${result.upside_pct}%. `
          + (result.upside_pct > 0
              ? 'The target is ABOVE spot — this can only support a BUY-side rating (or hold). It cannot support a sell.'
              : result.upside_pct < 0
                  ? 'The target is BELOW spot — this can only support a SELL-side rating (or hold). It cannot support a buy.'
                  : 'The target IS spot — no implied return; this supports a hold.')
        : '- vs the MARKET: no price available — the implied return is unknown, so do not pitch a rating off this run.'
    // Spell out what the band IS. A sensitivity band read as a downside case is the failure this
    // whole field exists to prevent, so the agent is told plainly and nudged to model a real one.
    const legs = result.legs
    const bandLine = result.band_basis === 'scenario'
        ? `- Band basis: SCENARIO — bear ${legs.bear.multiple}x on ${legs.bear.forward_metric}, bull ${legs.bull.multiple}x on ${legs.bull.forward_metric}`
        : `- Band basis: MULTIPLE SENSITIVITY (±15% re-rate on UNCHANGED ${result.forward_metric}) — this is NOT a downside case. For a real bear/bull, pass \`scenarios\` with a trough/peak multiple AND the earnings that go with it.`

    return [
        `Our ${result.method.toUpperCase()} valuation of ${S}:`,
        `- Multiple: ${m.used}x (${m.basis}; range ${m.low}–${m.high}x)${ctx.length ? ` — ${ctx.join(', ')}` : ''}`,
        `- Forward metric: ${result.forward_metric} (${fwdSrc}${meta.fy ? `, FY${meta.fy}` : ''})`,
        `- OUR price target: ${result.our_pt} (bear ${pt.bear} / base ${pt.base} / bull ${pt.bull})`,
        bandLine,
        `- Street consensus PT: ${result.consensus_pt ?? 'n/a'}`,
        `- THE GAP: ${gapLine}`,
        `- Edge: ${edge}`,
        marketLine,
    ].join('\n')
}

// ─── handlers ────────────────────────────────────────────────────────────────
async function _getConsensus({ ticker }) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'Provide a ticker.'
    const [estimates, pt, grades, gradesHist] = await Promise.all([
        getAnalystEstimates(sym), getPriceTargetConsensus(sym), getGradesConsensus(sym), getGradesHistorical(sym),
    ])
    return formatConsensus(sym, { estimates, pt, grades, gradesHist })
}

async function _computeValuation({ ticker, method = 'pe', multiple, forward_metric, current_price, shares_out, net_debt, scenarios }) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) return 'Provide a ticker.'
    const m = VALUATION_METHODS.includes(method) ? method : 'pe'

    // Spot is FETCHED, not asked for. It used to be an optional agent-supplied param, so an agent that
    // simply didn't pass it got a valuation measured only against the Street — no implied return, no
    // way to see that its target sat on the wrong side of the market. That is not an optional field:
    // the rating depends on it. The agent's own number still wins when it passes one.
    const [est, ptc, hist, spot] = await Promise.all([
        getAnalystEstimates(sym), getPriceTargetConsensus(sym), getHistoricalMultiples(sym, m),
        Number.isFinite(Number(current_price)) ? Number(current_price) : fetchLastPrice(sym).catch(() => null),
    ])
    const consensusFwd = est?.next ? est.next[_FWD_FIELD[m]] : null
    const usingConsensus = !Number.isFinite(Number(forward_metric))
    const fwd = usingConsensus ? consensusFwd : Number(forward_metric)

    const result = computeValuation({
        method: m,
        forward_metric: fwd,
        multiple,
        historical_multiples: hist,
        consensus_pt: ptc?.consensus ?? null,
        current_price: spot,
        shares_out,
        net_debt,
        scenarios,
    })
    return valuationReadText(sym, m, result, { fy: est?.next?.fy, consensusMetric: usingConsensus })
}

export const VALUATION_TOOLS = [
    {
        name: 'get_consensus',
        description: 'What the Street thinks about a stock — forward consensus estimates (EPS/revenue/EBITDA, next fiscal year), the consensus price target + range, the rating distribution, and the RATING REVISION TREND (are ratings migrating up or down). This is the variant-perception anchor: form your own view, then compare it here. US equities.',
        input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA' } }, required: ['ticker'] },
    },
    {
        name: 'compute_valuation',
        description: 'Compute OUR price target for a stock, deterministically: a justified multiple × a forward metric, with the GAP vs the Street consensus. Supply `multiple` to express your justified re-rating (the edge lives here) — omit it to anchor on the stock’s own historical range. `forward_metric` overrides the consensus estimate with your own number (the other place an edge can live). Supply `scenarios` to get a REAL bear/bull — each leg priced off its own multiple AND its own earnings; without it the band is only a ±15% re-rate on unchanged earnings, which is NOT a downside case and must never be read as one (the reply states which you got). method: pe (× forward EPS), ev_sales / ev_ebitda (× forward revenue/EBITDA, needs shares_out + net_debt for the equity bridge).',
        input_schema: {
            type: 'object',
            properties: {
                ticker:         { type: 'string', description: 'e.g. AAPL, NVDA' },
                method:         { type: 'string', enum: VALUATION_METHODS, description: 'pe (default) | ev_sales | ev_ebitda' },
                multiple:       { type: 'number', description: 'Your justified multiple (e.g. 28 for 28x). Omit to derive from the stock’s own historical range.' },
                forward_metric: { type: 'number', description: 'Your own forward metric (EPS / revenue / EBITDA per method). Omit to use the consensus estimate.' },
                current_price:  { type: 'number', description: 'Optional OVERRIDE — spot is fetched for you and the reply always reports the implied return vs the market. Pass this only to value off a different price.' },
                shares_out:     { type: 'number', description: 'Shares outstanding — required for ev_* (the EV→equity bridge).' },
                net_debt:       { type: 'number', description: 'Net debt — for ev_* (defaults 0).' },
                scenarios:      {
                    type: 'object',
                    description: 'Your bear/bull CASES. In a real downturn the multiple compresses AND earnings fall — model both. Each leg takes its own `multiple` and/or `forward_metric`; whichever you omit inherits the base. Omit a leg to leave that side as plain ±15% sensitivity.',
                    properties: {
                        bear: { type: 'object', properties: { multiple: { type: 'number', description: 'Trough multiple in your downside case' }, forward_metric: { type: 'number', description: 'Downside EPS / revenue / EBITDA' } } },
                        bull: { type: 'object', properties: { multiple: { type: 'number', description: 'Peak multiple in your upside case' }, forward_metric: { type: 'number', description: 'Upside EPS / revenue / EBITDA' } } },
                    },
                },
            },
            required: ['ticker'],
        },
    },
]

export const VALUATION_TOOL_HANDLERS = {
    get_consensus:     makeToolHandler('get_consensus',     _getConsensus,     (e, { ticker }) => `Could not fetch consensus for ${ticker}: ${e.message}`, LOG),
    compute_valuation: makeToolHandler('compute_valuation', _computeValuation, (e, { ticker }) => `Could not value ${ticker}: ${e.message}`, LOG),
}
