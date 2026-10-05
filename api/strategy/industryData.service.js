// What the engine measured about each GICS industry — the read side of Pythia's evidence.
//
// aether-engine writes it (docs/design/pythia-industry-questions.md §4-§6):
//   gics_companies   every company in the universe → its GICS sub-industry (and every level above)
//   industry_metrics one document per GICS node per run date: the numbers behind the three questions
//                    — demand (chained revenue growth vs the universe), economics (median return vs
//                    Damodaran's hurdle, margins, concentration), cycle (trailing margin or ROE in its
//                    own 10-year range) — plus early-review triggers, and on every sub-industry the
//                    level it is ANSWERED at
//
// DATA, not judgment: this module reads and formats; the desk decides what the numbers mean. Both
// collections live in the ENGINE's database (services/engineDb.js), which on a laptop is not the one
// Node runs on.

import { getEngineDb } from '../../services/engineDb.js'
import { coverageService } from '../analyst/coverage.service.js'

export const METRICS = 'industry_metrics'
export const COMPANIES = 'gics_companies'
const LEVELS = ['sub_industry', 'industry', 'industry_group', 'sector']

const _io = {
    db: () => getEngineDb(),
    // Our own analysts' book, so an industry read can say which of its companies we cover.
    coveredSymbols: async () => new Set(await coverageService.listSymbols()),
}
/** Test seam. */
export function _setIndustryIO(io) { Object.assign(_io, io) }

/** The latest run date the engine wrote, or null when it has written nothing. */
export async function latestAsof() {
    const db = await _io.db()
    const d = await db.collection(METRICS).find({}, { projection: { asof: 1 } }).sort({ asof: -1 }).limit(1).next()
    return d?.asof ?? null
}

/**
 * One sub-industry, by GICS code or by name (case-insensitive) → `{ sub, answering, parents }` from the
 * latest run, or null. `answering` is the node whose numbers answer it (itself when it holds enough
 * companies); `parents` are the industry and group nodes, for context.
 */
export async function readSubIndustry(codeOrName, asof = null) {
    const key = String(codeOrName ?? '').trim()
    if (!key) return null
    const db = await _io.db()
    const when = asof ?? await latestAsof()
    if (!when) return null
    const coll = db.collection(METRICS)
    const byCode = /^\d{8}$/.test(key)
    const sub = await coll.findOne(byCode
        ? { asof: when, level: 'sub_industry', code: key }
        : { asof: when, level: 'sub_industry', name: { $regex: `^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } })
    if (!sub) return null
    const at = sub.answered_at ?? { level: 'sub_industry', code: sub.code }
    const answering = at.level === 'sub_industry' ? sub : await coll.findOne({ asof: when, level: at.level, code: at.code })
    const parents = await coll.find({ asof: when, level: { $in: ['industry', 'industry_group'] }, name: { $in: [sub.industry, sub.industry_group] } }).toArray()
    return { sub, answering, parents }
}

/** Every sub-industry row of the latest run, light: code, name, sector, answered_at, the three grades. */
export async function listSubIndustries(asof = null) {
    const db = await _io.db()
    const when = asof ?? await latestAsof()
    if (!when) return []
    const subs = await db.collection(METRICS).find({ asof: when, level: 'sub_industry' }).toArray()
    const nodes = new Map((await db.collection(METRICS).find({ asof: when, level: { $in: LEVELS } }).toArray())
        .map(n => [`${n.level}|${n.code}`, n]))
    return subs.map(s => {
        const a = s.answered_at ?? { level: 'sub_industry', code: s.code }
        const n = nodes.get(`${a.level}|${a.code}`) ?? s
        return {
            code: s.code, name: s.name, sector: s.sector, industry_group: s.industry_group, industry: s.industry,
            answered_at: a, n_companies: s.n_companies ?? 0, asof: when,
            grades: { demand: n.q1?.grade ?? null, economics: n.q2?.grade ?? null, cycle: n.q3?.grade ?? null },
            cyclical: Boolean(n.q3?.cyclical), triggers: n.triggers ?? [],
        }
    }).sort((x, y) => (x.sector + x.name).localeCompare(y.sector + y.name))
}

/** The companies classified into a node, largest first. `level` is one of the four GICS levels. */
export async function readCompanies(level, code, { limit = 25 } = {}) {
    const field = { sub_industry: 'sub_code', industry: 'industry_code', industry_group: 'group_code', sector: 'sector_code' }[level]
    if (!field) return []
    const db = await _io.db()
    return db.collection(COMPANIES).find({ [field]: code }, { projection: { _id: 0, symbol: 1, name: 1, market_cap: 1, sub_industry: 1, source: 1, confidence: 1 } })
        .sort({ market_cap: -1 }).limit(limit).toArray()
}

// ─── LLM-ready formatting (pure) ──────────────────────────────────────────────

const pct = (v, d = 1) => (typeof v === 'number' ? `${(v * 100).toFixed(d)}%` : 'n/a')
const pp  = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp` : 'n/a')

/** One node's three-question numbers as text. Pure. */
export function formatNode(n) {
    if (!n) return 'No measurements.'
    const q1 = n.q1 ?? {}, q2 = n.q2 ?? {}, q3 = n.q3 ?? {}
    const lines = [
        `${n.name} (${n.level.replace('_', ' ')}, GICS ${n.code}) — ${n.n_companies} companies with enough history; fiscal year ${n.last_fiscal_year}, as of ${n.asof}`,
        `  DEMAND     code grade: ${q1.grade ?? 'none'} — revenue ${pct(q1.cagr)}/yr over ${q1.years ?? '?'}y (universe ${pct(q1.universe_cagr)}, relative ${pp(q1.relative)}), last 3y ${pct(q1.cagr_recent_3y)}/yr, ${pct(q1.share_positive_years, 0)} of years up, growth volatility ${pct(q1.growth_volatility)}`,
        `  ECONOMICS  code grade: ${q2.grade ?? 'none'} — median ${q2.return_measure ?? 'return'} ${pct(q2.median_return)} vs hurdle ${pct(q2.hurdle)} (${(q2.hurdle_sources ?? []).join(', ') || 'no hurdle'}; spread ${pp(q2.spread)}), ${pct(q2.share_above_hurdle, 0)} of ${q2.companies_with_returns ?? 0} companies clear it; operating margin ${pct(q2.op_margin_mean)} ± ${pct(q2.op_margin_stdev)}; top-5 revenue share ${pct(q2.top5_share, 0)} (5y ago ${pct(q2.top5_share_5y_ago, 0)})`,
        `  CYCLE      code grade: ${q3.grade ?? 'none'} — ${q3.measure === 'roe' ? 'ROE' : 'operating margin'} trailing 12m ${pct(q3.ttm_value)} vs its 10y range ${pct(q3.range_low)}–${pct(q3.range_high)} (percentile ${pct(q3.percentile, 0)}), normalised ${pct(q3.normalised_value)}, ${q3.cyclical ? 'CYCLICAL' : 'not cyclical'} (cv ${typeof q3.cv === 'number' ? q3.cv.toFixed(2) : 'n/a'})`,
    ]
    if (n.triggers?.length) lines.push(`  TRIGGERS   ${n.triggers.join(', ')}`)
    return lines.join('\n')
}

/** A sub-industry bundle (readSubIndustry) as text: what answers it, then its parents for context. Pure. */
export function formatSubIndustry(bundle) {
    if (!bundle) return 'Unknown sub-industry — call list_industries for the codes and names.'
    const { sub, answering, parents } = bundle
    const at = sub.answered_at ?? { level: 'sub_industry' }
    const head = at.level === 'sub_industry'
        ? `${sub.name} (GICS ${sub.code}) is answered on its own numbers.`
        : `${sub.name} (GICS ${sub.code}) has too few companies (${sub.n_companies ?? 0}) to answer on its own — it is answered at its ${at.level.replace('_', ' ')}, ${at.name}. Say so in the view.`
    const ctx = (parents ?? []).filter(p => p.code !== answering?.code).map(formatNode)
    return [head, '', formatNode(answering), ...(ctx.length ? ['', 'CONTEXT — the levels above:', ...ctx] : [])].join('\n')
}

/** The companies in a node, marked where our analysts cover them. Pure. */
export function formatCompanies(rows, covered = new Set()) {
    if (!rows?.length) return 'No companies classified here.'
    return rows.map(r => `  ${r.symbol.padEnd(6)} ${String(r.name ?? '').slice(0, 40).padEnd(40)} ${typeof r.market_cap === 'number' ? `$${(r.market_cap / 1e9).toFixed(1)}B` : ''}${covered.has(r.symbol) ? '  [OUR COVERAGE]' : ''}`).join('\n')
}

export async function coveredSymbols() {
    return _io.coveredSymbols()
}

/** The GICS assignment of each symbol → `{ SYMBOL: { sub_code, sub_industry, industry, sector } }`. */
export async function readCompaniesBySymbol(symbols) {
    const syms = [...new Set((symbols ?? []).map(s => String(s ?? '').toUpperCase().trim()).filter(Boolean))]
    if (!syms.length) return {}
    const db = await _io.db()
    const rows = await db.collection(COMPANIES).find({ symbol: { $in: syms } },
        { projection: { _id: 0, symbol: 1, sub_code: 1, sub_industry: 1, industry: 1, industry_group: 1, sector: 1 } }).toArray()
    return Object.fromEntries(rows.map(r => [r.symbol, r]))
}
