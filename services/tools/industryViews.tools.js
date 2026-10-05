/**
 * The house's INDUSTRY VIEWS, as a read tool — Pythia's answers to the three structural questions per
 * GICS sub-industry (docs/design/pythia-industry-questions.md). Replaced get_sector_view (the tilt's
 * reader) on 2026-10-05.
 *
 * UNBOUND — no userId. The views are a broadcast written for everyone; the tool joins them to the
 * symbols the CALLER passes, so a desk asks about its own book without the tool ever knowing whose.
 *
 * READ-ONLY at every desk: reporting an answer is reading; changing one is Pythia's (a `<route>`).
 */

import { makeToolHandler } from '../agentUtils.js'
import { industryViewService } from '../../api/strategy/industryView.service.js'
import { listSubIndustries } from '../../api/strategy/industryData.service.js'

const LOG = '[industryViews]'
const MAX_SYMBOLS = 60

export const INDUSTRY_VIEWS_TOOL_SPEC = {
    get_industry_views: `The house's INDUSTRY VIEWS from Pythia: for each GICS sub-industry, three structural answers — DEMAND (growing / in_line / shrinking against the economy), ECONOMICS (good / average / poor: do its companies earn above their cost of capital), CYCLE (peak / mid / trough, or stable: where current margins sit in the industry's own 10-year range). Pass \`symbols\` to get the industry each name is in and the house's answer for it; or \`sector\` (a GICS sector, e.g. Information Technology) for every sub-industry in it. These are DESCRIPTIONS of an industry, never a forecast of a price or a return — report them as such, and never present one as a reason a stock will rise. An industry still \`pending\` has no house answer yet: say so, do not supply one. Changing an answer is Pythia's desk, not this tool.`,
}

const _grades = (v) => (v.status === 'answered'
    ? `demand ${v.demand} · economics ${v.economics} · cycle ${v.cycle}`
    : 'no house answer yet (pending)')

/** Per-symbol answers → LLM-ready text. Pure — exported for testing. */
export function formatSymbolViews(bySymbol, asked) {
    const lines = (asked ?? []).map(s => {
        const v = bySymbol[s]
        return v ? `  ${s.padEnd(6)} ${v.name} [${v.sector}] — ${_grades(v)}${v.summary ? `\n         ${v.summary}` : ''}`
                 : `  ${s.padEnd(6)} not classified (outside the measured universe)`
    })
    return ['HOUSE INDUSTRY VIEWS for the names asked:', ...lines, '',
        'Descriptions of each industry, not forecasts — a good industry at the top of its cycle is not a buy signal.'].join('\n')
}

/** A sector's sub-industries → text. Pure — exported for testing. `rows` are listIndustries-shaped. */
export function formatSectorIndustries(sector, rows, views) {
    const byCode = new Map((views ?? []).map(v => [v.code, v]))
    const lines = rows.map(r => {
        const v = byCode.get(r.code)
        const answer = v?.status === 'answered'
            ? { status: 'answered', demand: v.demand?.grade, economics: v.economics?.grade, cycle: v.cycle?.grade }
            : { status: 'pending' }
        return `  ${r.name.padEnd(48)} ${_grades(answer)}`
    })
    return [`HOUSE INDUSTRY VIEWS — ${sector}:`, ...lines].join('\n')
}

export function makeIndustryViewsHandlers(deps = {}) {
    const {
        forSymbols = (syms) => industryViewService.viewsForSymbols(syms),
        measured   = () => listSubIndustries(),
        views      = () => industryViewService.listViews(),
    } = deps

    return {
        get_industry_views: makeToolHandler('get_industry_views', async (input) => {
            const symbols = (Array.isArray(input?.symbols) ? input.symbols : [])
                .map(s => String(s ?? '').toUpperCase().trim()).filter(Boolean).slice(0, MAX_SYMBOLS)
            if (symbols.length) return formatSymbolViews(await forSymbols(symbols), symbols)
            const sector = typeof input?.sector === 'string' ? input.sector.trim() : ''
            if (!sector) return 'Pass `symbols` (the names you are asking about) or `sector` (a GICS sector) — there are 163 sub-industries, too many to list unasked.'
            const rows = (await measured()).filter(r => r.sector.toLowerCase() === sector.toLowerCase())
            if (!rows.length) return `No GICS sector named "${sector}". The eleven: Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Health Care, Financials, Information Technology, Communication Services, Utilities, Real Estate.`
            return formatSectorIndustries(rows[0].sector, rows, await views())
        }, (err) => `Could not read the house industry views: ${err.message}`, LOG),
    }
}
