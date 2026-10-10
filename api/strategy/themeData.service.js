// What the engine measured about a THEME's value chain — the read side of a theme assessment
// (docs/design/pythia-assessment.md §3, step 3). A theme is a list of GICS sub-industries in order; its facts
// are each link's price moves (industry_timing) and money (industry_metrics), read here once and shared by
// Pythia's `get_theme` tool and the headless assessment, so the two can never disagree. DATA, not judgment.

import { readSubIndustry, readCompanies, moneyFacts, listSubIndustries } from './industryData.service.js'
import { readTimingRow } from './screenerData.service.js'
import { themeFacts, ordinal } from './industryAssessment.service.js'
import { ORDER_LABEL } from './theme.service.js'

const _io = {
    sub: (code) => readSubIndustry(code),
    row: (code) => readTimingRow(code),
    companies: (level, code, opts) => readCompanies(level, code, opts),
    subs: () => listSubIndustries(),
}
/** Test seam. */
export function _setThemeDataIO(io) { Object.assign(_io, io) }

/** Each link's screen row and money facts → `{ rows, money, facts, regime }`. */
export async function readThemeFacts(theme) {
    const rows = new Map(), money = new Map()
    let regime = null
    await Promise.all((theme?.links ?? []).map(async (l) => {
        const [{ row, regime: reg }, bundle] = await Promise.all([_io.row(l.code), _io.sub(l.code)])
        if (row) rows.set(l.code, row)
        if (reg && !regime) regime = reg
        const m = moneyFacts(bundle?.answering)
        if (m) money.set(l.code, m)
    }))
    return { rows, money, regime, facts: themeFacts(theme, rows, money) }
}

/** A BASKET_PER_LINK-largest-companies basket over the direct and supplier links, when the theme names none. */
export const BASKET_PER_LINK = 5

/** The symbols a theme's call is graded on: its own named basket, else its order-1 and 2 links' largest. */
export async function themeBasket(theme) {
    const own = (theme?.basket ?? []).map(b => b.symbol).filter(Boolean)
    if (own.length >= 3) return own
    const lists = await Promise.all((theme?.links ?? []).filter(l => l.order <= 2)
        .map(l => _io.companies('sub_industry', l.code, { limit: BASKET_PER_LINK })))
    return [...new Set(lists.flat().map(c => c.symbol).filter(Boolean))]
}

/** The measured sub-industries as `{ code → { name, sector } }`, for checking a proposal's links. */
export async function measuredSubs() {
    return new Map((await _io.subs()).map(s => [s.code, { name: s.name, sector: s.sector }]))
}

const _pct = (v, d = 0) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : 'n/a')

/** A theme with its links' facts, as the agent reads it (`get_theme`). Pure. */
export function formatTheme(theme, facts, regime = null) {
    if (!theme) return 'Unknown theme — call list_themes for the ids.'
    const money = new Map((facts?.money?.links ?? []).map(l => [l.code, l]))
    const lines = [
        `THEME ${theme.name} (${theme.id}) — ${theme.status}`,
        `  thesis: ${theme.thesis}`,
        `  words its filings and news use: ${(theme.terms ?? []).join(', ')}`,
        `  HYPE FLAG (a direct link up 100%+ in two years and 100%+ over the market): ${facts?.moved?.hype == null ? 'n/a' : facts.moved.hype ? 'YES' : 'no'}`,
        'THE VALUE CHAIN, link by link (moves vs SPY; money = last 4 quarters vs the 4 before):',
    ]
    for (const l of facts?.moved?.links ?? []) {
        const m = money.get(l.code) ?? {}
        const why = (theme.links ?? []).find(x => x.code === l.code)?.why ?? ''
        lines.push(`  [${l.order} ${ORDER_LABEL[l.order]}] ${l.name} (${l.code}) — ${why}`)
        lines.push(`      moved: 12m ${_pct(l.excess_12m)} and 24m ${_pct(l.excess_24m)} over SPY${l.ext_percentile != null ? `, stretched ${ordinal(Math.round(l.ext_percentile * 100))} percentile` : ''}${l.hype ? ', HYPE' : ''}`)
        lines.push(`      money: capex ${_pct(m.capex_change)} (a year earlier ${_pct(m.capex_prev_change)}${typeof m.capex_share_up === 'number' ? `, ${Math.round(m.capex_share_up * 100)}% of companies up` : ''}), buybacks ${_pct(m.buybacks_change)}`)
    }
    if ((theme.basket ?? []).length) lines.push(`  named companies: ${theme.basket.map(b => b.symbol).join(', ')}`)
    lines.push(`MARKET REGIME (S&P trend and volatility): ${String(regime?.regime ?? 'n/a').toUpperCase()}`)
    return lines.join('\n')
}
