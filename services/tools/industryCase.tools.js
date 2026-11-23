/**
 * PYTHIA'S CASE ON A NAME'S INDUSTRY, for Prometheus (Roy, 2026-11-22: "pythia analyse the industries — is prometheus
 * looking at its analysis and data it brings?"). Until then he saw her only as one paragraph in the opening of a house-
 * chain build, and never on a re-model, a user's build or an answer. This reads her whole standing assessment of the
 * symbol's GICS sub-industry — the verdicts, the thesis and its evidence, the risks, what would change her view, and the
 * facts the code froze beside it (the basket's moves, its companies' money, insiders) — and her stance on the book the
 * caller's horizon is graded on (pythiaStance).
 *
 * UNBOUND — no userId: her assessments are the house's broadcast. READ-ONLY: changing one is her desk.
 */

import { makeToolHandler } from '../agentUtils.js'
import { readCompaniesBySymbol } from '../../api/strategy/industryData.service.js'
import { industryAssessmentService, VERDICTS } from '../../api/strategy/industryAssessment.service.js'
import { industryViewService } from '../../api/strategy/industryView.service.js'
import { verdictAt, stanceFor, bookOf } from '../pythiaStance.js'

const LOG = '[industryCase]'

export const INDUSTRY_CASE_TOOL_SPEC = {
    get_industry_case: `The INDUSTRY STRATEGIST's standing case on the GICS sub-industry a name is in — her near-term verdict (for swing / watch / avoid / no case) and her long-term call, her thesis and the evidence behind it, the risks she named, what would change her view, and the facts the house froze beside it: the industry basket's moves against SPY, its companies' capex and buybacks, insider buying. Pass \`symbol\`, and \`horizon\` (your target's: 3m … 24m) for her stance on the book that horizon is graded on — FOR, AGAINST or NEUTRAL. She judges INDUSTRIES, never a stock: whether this company is already priced for her case is yours to judge. Where your rating goes against her stance, say why in the thesis.`,
}

const _pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%` : null)
const _clip = (t, n) => { const s = String(t ?? '').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s }
const STANCE_WORDS = { for: 'FOR', against: 'AGAINST', neutral: 'NEUTRAL (a view, neither way)' }

/** Her assessment document (+ the industry's structural answers) → LLM-ready text. Pure — exported for testing. */
export function formatIndustryCase({ symbol, company, doc, view = null, horizon = null, now = new Date().toISOString() }) {
    if (!company?.sub_code) return `${symbol}: not classified in the measured universe — the industry strategist has no case on its industry.`
    const head = `${symbol} — ${company.sub_industry} [${company.sector ?? doc?.subject?.sector ?? '?'}]`
    const structure = view?.status === 'answered' ? `Structure: demand ${view.demand?.grade} · economics ${view.economics?.grade} · cycle ${view.cycle?.grade}` : null
    if (!doc) return [head, structure, 'The industry strategist has not assessed this industry yet — no case to weigh.'].filter(Boolean).join('\n')
    const said = verdictAt(doc, now)
    const near = said?.verdict ? VERDICTS[said.verdict] ?? said.verdict : doc.verdict ? `${VERDICTS[doc.verdict] ?? doc.verdict} — EXPIRED ${String(doc.expires_at).slice(0, 10)}, due for reassessment` : 'none'
    const lines = [head, structure,
        `Near-term verdict: ${near}${doc.horizon ? ` (${doc.horizon})` : ''}${doc.confidence ? ` · confidence ${doc.confidence}${doc.confidence_reason ? ` — ${_clip(doc.confidence_reason, 240)}` : ''}` : ''} · assessed ${String(doc.assessed_at ?? '').slice(0, 10)}`]
    if (doc.verdict === 'watch' && doc.decides_by) lines.push(`Watch — decides by ${doc.decides_by}${doc.question ? `: ${doc.question}` : ''}`)
    if (horizon) {
        const st = stanceFor(said, horizon)
        lines.push(`Her stance on the ${bookOf(horizon) === 'swing' ? 'SWING' : 'LONG-TERM'} book (a ${horizon} target): ${st ? STANCE_WORDS[st] : 'none — nothing standing'}`)
    }
    if (doc.thesis) lines.push(`Thesis: ${_clip(doc.thesis, 700)}`)
    if (doc.cause?.text) lines.push(`What moved it (${doc.cause.kind}): ${_clip(doc.cause.text, 400)}`)
    const ev = doc.evidence ?? {}
    for (const k of ['news', 'price', 'money', 'regime', 'geopolitics']) if (ev[k]) lines.push(`Evidence, ${k}: ${_clip(ev[k], 450)}`)
    if (doc.risks?.length) lines.push(`Risks: ${doc.risks.map(r => _clip(r, 220)).join(' | ')}`)
    if (doc.change_view_if?.length) lines.push(`She changes her view if: ${doc.change_view_if.map(r => _clip(r, 220)).join(' | ')}`)
    if (doc.second_order) lines.push(`Second order: ${_clip(doc.second_order, 300)}`)
    if (doc.names?.length) lines.push(`Names she named: ${doc.names.map(n => `${n.symbol}${n.why ? ` (${_clip(n.why, 120)})` : ''}`).join('; ')}`)
    const lt = doc.long_term
    if (lt?.call) lines.push(`Long-term call: ${String(lt.call).toUpperCase()}${said?.long_term == null && lt.call === 'yes' ? ' — STALE, past its review' : ''}${lt.hype ? ' (stretched — a timing flag)' : ''}${lt.thesis ? ` — ${_clip(lt.thesis, 400)}` : ''}`)
    const mv = doc.moved
    if (mv) {
        const parts = [['12m vs SPY', _pct(mv.excess_12m)], ['24m vs SPY', _pct(mv.excess_24m)], ['1m relative', _pct(mv.rel_1m)], ['3m relative', _pct(mv.rel_3m)], ['vs its 50-day', _pct(mv.ext_50)]]
            .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`)
        if (parts.length) lines.push(`The basket (equal weight, as of ${mv.asof ?? '?'}): ${parts.join(' · ')}${mv.hype ? ' · HYPE (up 100%+ in two years and over the market — a crash-risk flag)' : ''}`)
    }
    const mo = doc.money
    if (mo) {
        const parts = [['capex', _pct(mo.capex_change)], ['buybacks', _pct(mo.buybacks_change)], ['dividends', _pct(mo.dividends_change)], ['acquisitions', _pct(mo.acquisitions_change)]]
            .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`)
        if (parts.length) lines.push(`Its companies' money, last four quarters vs the four before: ${parts.join(' · ')}${Number.isFinite(mo.capex_share_up) ? ` · ${Math.round(mo.capex_share_up * 100)}% raised capex` : ''}`)
    }
    const ins = doc.flows?.insiders
    if (ins && Number.isFinite(ins.share_buying)) lines.push(`Insiders: ${ins.companies_buying ?? '?'} of ${ins.n_companies ?? '?'} companies buying${ins.cluster ? ' — a cluster' : ''} (as of ${ins.asof ?? '?'})`)
    if (doc.gaps?.length) lines.push(`Not based on: ${doc.gaps.join(', ')}`)
    lines.push('', 'Her case is about the industry, not this stock — whether the stock is already priced for it is your judgment.')
    return lines.filter(l => l != null).join('\n')
}

export function makeIndustryCaseHandlers(deps = {}) {
    const {
        companies = (syms) => readCompaniesBySymbol(syms),
        assessment = (code) => industryAssessmentService.getAssessment(code),
        view = (code) => industryViewService.getView(code),
        now = () => new Date().toISOString(),
    } = deps
    return {
        get_industry_case: makeToolHandler('get_industry_case', async (input) => {
            const symbol = String(input?.symbol ?? '').toUpperCase().trim()
            if (!symbol) return 'Pass `symbol` — the name whose industry you want the strategist\'s case on.'
            const company = (await companies([symbol]))[symbol] ?? null
            const [doc, v] = company?.sub_code ? await Promise.all([assessment(company.sub_code), view(company.sub_code).catch(() => null)]) : [null, null]
            const horizon = typeof input?.horizon === 'string' && input.horizon.trim() ? input.horizon.trim() : null
            return formatIndustryCase({ symbol, company, doc, view: v, horizon, now: now() })
        }, (err) => `Could not read the industry strategist's case: ${err.message}`, LOG),
    }
}
