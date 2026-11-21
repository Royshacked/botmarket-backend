/**
 * The analyst's COVERAGE, as a read tool for Axl (Roy, 2026-11-20: "I ask what he thinks about NVDA for the long term and
 * instead of giving his opinion from coverage he asks to update"). A VIEW on a covered name is a read — the thesis the
 * analyst already wrote — not a new piece of research; updating it stays the analyst's (a `<route>research`).
 *
 * UNBOUND — coverage is the house's, shared across every user and workspace (CLAUDE.md: research binds to no account).
 */

import { makeToolHandler } from '../agentUtils.js'
import { coverageService } from '../../api/analyst/coverage.service.js'

const LOG = '[coverageTool]'

export const COVERAGE_TOOL_SPEC = {
    get_coverage_view: `The analyst's standing COVERAGE thesis on ONE stock, if the house covers it: the rating, our price target and its date, the thesis, conviction, the bear / base / bull case, the next catalysts, the kill criteria, and when it was last revised. Use it whenever the user asks what the analyst — or the house, or "you" — THINKS of a name ("how is NVDA for the long term?", "is AMD still a buy?", "what's our view on TSLA?"): answer from it, attributed and dated. Not covered → say so, and offer the analyst's research (a route) only if they want it. Updating a thesis is the analyst's desk, not this tool.`,
}

const fmtPct = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${Math.round(x * 10) / 10}%` : null)
const fmtPrice = (x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(2) : null)
const day = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null)
const caseLine = (c) => (c && typeof c === 'object' ? [fmtPrice(c.price ?? c.value ?? c.target), c.note ?? c.why ?? c.thesis ?? null].filter(Boolean).join(' — ') : (c ?? null))

/** A coverage doc → the text Axl reads. Pure — exported for testing. */
export function formatCoverage(symbol, c) {
    if (!c || c.status === 'retired') return `${symbol}: NOT COVERED — the analyst has no standing thesis on it. Say so; offer his research only if the user wants it.`
    const pt = c.price_target ?? {}
    const rr = c.risk_reward ?? {}
    const lines = [
        `ANALYST COVERAGE — ${c.symbol}${c.industry ? ` (${c.industry})` : ''}, last revised ${day(c.updated_at) ?? 'unknown'}:`,
        `  rating: ${String(c.rating ?? 'none').replace('_', ' ')}`,
        Number.isFinite(Number(pt.value)) ? `  our price target: ${fmtPrice(pt.value)}${pt.target_date ? ` by ${day(pt.target_date)}` : ''}${pt.horizon ? ` (${pt.horizon})` : ''}${pt.basis ? ` — ${String(pt.basis).slice(0, 200)}` : ''}` : '  our price target: none standing',
        c.gap && Number.isFinite(c.gap.pct) ? `  against the Street: ${fmtPct(c.gap.pct)} vs consensus ${fmtPrice(c.gap.consensus_pt) ?? '?'}` : null,
        c.conviction?.level ? `  conviction: ${c.conviction.level}${c.conviction.rationale ? ` — ${String(c.conviction.rationale).slice(0, 240)}` : ''}` : null,
        c.thesis ? `  thesis: ${String(c.thesis).slice(0, 900)}` : null,
        ...['bear', 'base', 'bull'].map(k => (rr[k] ? `  ${k} case: ${String(caseLine(rr[k])).slice(0, 240)}` : null)),
        ...(Array.isArray(c.catalysts) && c.catalysts.length ? ['  catalysts:', ...c.catalysts.slice(0, 4).map(k => `    ${k.date ?? ''} ${String(k.note ?? '').slice(0, 200)}`)] : []),
        ...(Array.isArray(c.kill_criteria) && c.kill_criteria.length ? ['  kill criteria:', ...c.kill_criteria.slice(0, 5).map(k => `    - ${String(k).slice(0, 200)}`)] : []),
        Array.isArray(c.revisions) && c.revisions.length ? `  latest revision (${day(c.revisions[0].at)}): ${String(c.revisions[0].note ?? '').slice(0, 300)}` : null,
        '',
        "The analyst's view, as he wrote it — say it as his, with the date; it is a thesis, not a promise of a price.",
    ]
    return lines.filter(l => l !== null).join('\n')
}

/** @returns {{ get_coverage_view: Function }} */
export function makeCoverageHandlers({ coverage = coverageService } = {}) {
    return {
        get_coverage_view: makeToolHandler('get_coverage_view', async ({ symbol } = {}) => {
            const sym = String(symbol ?? '').toUpperCase().trim()
            if (!/^[A-Z0-9.-]{1,12}$/.test(sym)) return 'symbol is required — one ticker, e.g. NVDA'
            return formatCoverage(sym, await coverage.getCoverageBySymbol(sym))
        }, (err) => `Could not read the coverage: ${err.message}`, LOG),
    }
}
