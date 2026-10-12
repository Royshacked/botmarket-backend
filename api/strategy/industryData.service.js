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
export const RUNS = 'industry_metrics_runs'
export const COMPANIES = 'gics_companies'
const LEVELS = ['sub_industry', 'industry', 'industry_group', 'sector']

const _io = {
    db: () => getEngineDb(),
    // Our own analysts' book, so an industry read can say which of its companies we cover.
    coveredSymbols: async () => new Set(await coverageService.listSymbols()),
}
/** Test seam. */
export function _setIndustryIO(io) { Object.assign(_io, io) }

/**
 * The latest COMPLETE run, or null. The engine writes a run one node at a time and marks it complete in
 * industry_metrics_runs only at the end — reading the highest asof in industry_metrics instead served a
 * half-written run during the job, and a crashed one forever.
 */
export async function latestAsof() {
    const db = await _io.db()
    const d = await db.collection(RUNS).find({ complete: true }, { projection: { asof: 1 } }).sort({ asof: -1 }).limit(1).next()
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
    // By CODE — a name can repeat across branches of GICS. Older runs without codes fall back to names.
    const parentQuery = sub.industry_code
        ? { $or: [{ level: 'industry', code: sub.industry_code }, { level: 'industry_group', code: sub.group_code }] }
        : { $or: [{ level: 'industry', name: sub.industry }, { level: 'industry_group', name: sub.industry_group }] }
    const parents = await coll.find({ asof: when, ...parentQuery }).toArray()
    return { sub, answering, parents }
}

/** Every sub-industry row of the latest run, light: code, name, sector, answered_at, the three grades. */
export async function listSubIndustries(asof = null) {
    const db = await _io.db()
    const when = asof ?? await latestAsof()
    if (!when) return []
    const all = await db.collection(METRICS).find({ asof: when, level: { $in: LEVELS } }).toArray()
    const subs = all.filter(n => n.level === 'sub_industry')
    const nodes = new Map(all.map(n => [`${n.level}|${n.code}`, n]))
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

/**
 * The companies classified into a node, largest first. `level` is one of the four GICS levels. The same
 * companies the engine measured: not stale, and one listing per filer — a preferred or note carrying its
 * parent's statements is marked `duplicate_of` by the engine (2026-10-06: Southern listed five times).
 */
export const companiesQuery = (field, code) => ({ [field]: code, stale: { $ne: true }, duplicate_of: null })

export async function readCompanies(level, code, { limit = 25 } = {}) {
    const field = { sub_industry: 'sub_code', industry: 'industry_code', industry_group: 'group_code', sector: 'sector_code' }[level]
    if (!field) return []
    const db = await _io.db()
    return db.collection(COMPANIES).find(companiesQuery(field, code), { projection: { _id: 0, symbol: 1, name: 1, market_cap: 1, sub_industry: 1, source: 1, confidence: 1 } })
        .sort({ market_cap: -1 }).limit(limit).toArray()
}

// ─── LLM-ready formatting (pure) ──────────────────────────────────────────────

const pct = (v, d = 1) => (typeof v === 'number' ? `${(v * 100).toFixed(d)}%` : 'n/a')
const pp  = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp` : 'n/a')

// The engine's "stable" rule (aether-engine fundamentals/industry_metrics.py STABLE_RANGE), restated so the
// desk is told the rule beside the measured width. The engine decides the code grade; this only explains it.
export const STABLE_RANGE = 0.30
const _rangeWidth = (q3) => {
    const { range_low: lo, range_high: hi, normalised_value: mean } = q3
    return [lo, hi, mean].every(v => typeof v === 'number') && mean !== 0 ? (hi - lo) / Math.abs(mean) : null
}

/** One node's three-question numbers as text. Pure. */
export function formatNode(n) {
    if (!n) return 'No measurements.'
    const q1 = n.q1 ?? {}, q2 = n.q2 ?? {}, q3 = n.q3 ?? {}
    const lines = [
        `${n.name} (${n.level.replace('_', ' ')}, GICS ${n.code}) — ${n.n_companies} companies with enough history; fiscal year ${n.last_fiscal_year}, as of ${n.asof}`,
        `  DEMAND     code grade: ${q1.grade ?? 'none'} — revenue ${pct(q1.cagr)}/yr over ${q1.years ?? '?'}y (universe ${pct(q1.universe_cagr)}, relative ${pp(q1.relative)}), last 3y ${pct(q1.cagr_recent_3y)}/yr, ${pct(q1.share_positive_years, 0)} of years up, growth volatility ${pct(q1.growth_volatility)}`,
        `  ECONOMICS  code grade: ${q2.grade ?? 'none'} — the industry's ${q2.return_measure ?? 'return'} ${pct(q2.aggregate_return)} (all its capital together) vs hurdle ${pct(q2.hurdle)} (${(q2.hurdle_sources ?? []).join(', ') || 'no hurdle'}; spread ${pp(q2.spread)}); the median company earns ${pct(q2.median_return)} and ${pct(q2.share_above_hurdle, 0)} of ${q2.companies_with_returns ?? 0} clear their own hurdle; operating margin ${pct(q2.op_margin_mean)} ± ${pct(q2.op_margin_stdev)}; top-5 revenue share ${pct(q2.top5_share, 0)} (5y ago ${pct(q2.top5_share_5y_ago, 0)})`,
        `  CYCLE      code grade: ${q3.grade ?? 'none'} — ${q3.measure === 'roe' ? 'ROE' : 'operating margin'} trailing 12m ${pct(q3.ttm_value)} vs its 10y range ${pct(q3.range_low)}–${pct(q3.range_high)} (percentile ${pct(q3.percentile, 0)}), normalised ${pct(q3.normalised_value)}; the range is ${pct(_rangeWidth(q3), 0)} of its normalised value (stable only under ${pct(STABLE_RANGE, 0)} — otherwise placed peak/mid/trough by the percentile)`,
        // `cyclical` (cv or a revenue drop) sets the review CADENCE only — never the grade. Said as such, because
        // "not cyclical" beside a peak margin read as licence to grade it stable (the first live review, 2026-10-05).
        `  CADENCE    ${q3.cyclical ? 'cyclical — reviewed quarterly' : 'reviewed yearly'} (margin cv ${typeof q3.cv === 'number' ? q3.cv.toFixed(2) : 'n/a'}); this does not decide the cycle grade`,
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

// ─── companies' own money (docs/design/pythia-assessment.md §4.3) ────────────
// The engine's `money` block on each node (aether-engine fundamentals/industry_metrics.py node_money): its
// companies' capex, buybacks, dividends and acquisitions over the last four quarters against the four
// before (and the change a year earlier, to see it turning), how many raised capex, capex as a share of
// revenue, the median company's share-count change, and the top spenders. DATA — the desk reads it.

const _usd = (v) => (typeof v === 'number' ? `$${(v / 1e9).toFixed(1)}B` : 'n/a')
const _chg = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : 'n/a')

/** The money facts an assessment carries (attached by code). Pure → null without a money block. */
export function moneyFacts(node) {
    const m = node?.money
    if (!m?.capex) return null
    return {
        basket: node.name ?? null, companies: m.companies ?? null,
        capex_now: m.capex.now ?? null, capex_change: m.capex.change ?? null, capex_prev_change: m.capex.prev_change ?? null,
        capex_share_up: m.capex.share_up ?? null, capex_intensity: m.capex.intensity ?? null, capex_intensity_before: m.capex.intensity_before ?? null,
        buybacks_change: m.buybacks?.change ?? null, dividends_change: m.dividends?.change ?? null,
        acquisitions_change: m.acquisitions?.change ?? null, share_count_median_change: m.share_count_median_change ?? null,
    }
}

/**
 * Every sub-industry's money facts from ONE run, read from the node that answers it — `Map(code → moneyFacts)`,
 * null facts where a node has none. For the weekly change scan (pythia-assessment.md §8), in one query.
 */
export async function readAllMoney(asof = null) {
    const db = await _io.db()
    const when = asof ?? await latestAsof()
    if (!when) return new Map()
    const all = await db.collection(METRICS).find({ asof: when, level: { $in: LEVELS } },
        { projection: { _id: 0, level: 1, code: 1, name: 1, answered_at: 1, money: 1 } }).toArray()
    const nodes = new Map(all.map(n => [`${n.level}|${n.code}`, n]))
    return new Map(all.filter(n => n.level === 'sub_industry').map(s => {
        const a = s.answered_at ?? { level: 'sub_industry', code: s.code }
        return [s.code, moneyFacts(nodes.get(`${a.level}|${a.code}`) ?? s)]
    }))
}

/** One node's money as text. Pure. */
export function formatMoney(node) {
    const m = node?.money
    if (!m?.capex) return 'No money measurements for this industry yet (needs eight quarters of cash-flow statements).'
    const line = (label, x) => `  ${label.padEnd(12)} ${_usd(x?.now)} over the last 4 quarters vs ${_usd(x?.before)} the 4 before → ${_chg(x?.change)} (a year earlier: ${_chg(x?.prev_change)}); ${typeof x?.share_up === 'number' ? `${Math.round(x.share_up * 100)}% of ${x.companies} companies raised it` : ''}`
    return [
        `WHERE ${node.name}'s COMPANIES PUT THEIR MONEY (${m.companies} companies with eight quarters; engine run ${node.asof}):`,
        line('CAPEX', m.capex),
        `  capex intensity: ${_chg(m.capex.intensity).replace('+', '')} of revenue (a year before: ${_chg(m.capex.intensity_before).replace('+', '')})`,
        line('BUYBACKS', m.buybacks),
        line('DIVIDENDS', m.dividends),
        line('ACQUISITIONS', m.acquisitions),
        `  share count: the median company ${_chg(m.share_count_median_change)} in a year (negative = shrinking through buybacks)`,
        `  top spenders: ${(m.top_spenders ?? []).map(t => `${t.symbol} ${_usd(t.capex)} (${_chg(t.change)})`).join(', ') || 'none'}`,
        'Read capex as revenue for the SUPPLIERS: follow the money to where it lands (get_capex_leaders shows which industries are spending).',
    ].join('\n')
}

/**
 * Where corporate capex is rising and falling most across the market — GICS INDUSTRIES (the 70-odd level:
 * enough companies each), ranked by the DOLLAR change of their last four quarters' capex. → `{ asof, up, down }`.
 */
export async function readMoneyLeaders({ asof = null, n = 8 } = {}) {
    const db = await _io.db()
    const when = asof ?? await latestAsof()
    if (!when) return { asof: null, up: [], down: [] }
    const rows = (await db.collection(METRICS).find({ asof: when, level: 'industry', 'money.capex.change': { $ne: null } },
        { projection: { _id: 0, name: 1, code: 1, sector: 1, money: 1 } }).toArray())
        .map(r => ({ name: r.name, code: r.code, sector: r.sector, ...r.money.capex, delta: (r.money.capex.now ?? 0) - (r.money.capex.before ?? 0) }))
        .sort((a, b) => b.delta - a.delta)
    return { asof: when, up: rows.slice(0, n), down: rows.slice(-n).reverse().filter(r => r.delta < 0) }
}

/** The leaders as text. Pure. */
export function formatMoneyLeaders({ asof, up = [], down = [] } = {}) {
    if (!asof) return 'No money measurements yet — the engine has not run.'
    const row = (r) => `  ${r.name} [${r.sector}]: capex ${_usd(r.now)}, ${r.delta >= 0 ? '+' : ''}${_usd(r.delta)} (${_chg(r.change)}; a year earlier ${_chg(r.prev_change)}), ${typeof r.share_up === 'number' ? `${Math.round(r.share_up * 100)}% of companies up` : ''}`
    return [`CORPORATE CAPEX BY GICS INDUSTRY — last 4 quarters vs the 4 before (engine run ${asof}). Capex is the SUPPLIERS' revenue.`,
        'RISING MOST ($):', ...up.map(row), 'FALLING MOST ($):', ...(down.length ? down.map(row) : ['  none falling'])].join('\n')
}

// ─── the rest of the money: insiders, funds, government (docs/design/pythia-money-flows.md, step 8) ─────
// Three engine jobs, one collection each, one document per GICS node (aether-engine money/): insider buying over
// 90 days (industry_insiders, weekly), funds' 13F ownership against the universe (industry_funds, per quarter),
// federal contract money on the NAICS lines an industry sells into (industry_government, monthly). Read at the
// sub-industry's OWN node. DATA — how each is read is in the prompt and in formatFlows' lines.

export const INSIDERS = 'industry_insiders'
export const INSIDER_RUNS = 'industry_insiders_runs'
export const FUNDS = 'industry_funds'
export const GOVERNMENT = 'industry_government'
export const GOVERNMENT_RUNS = 'industry_government_runs'

async function _latestComplete(db, runs) {
    const d = await db.collection(runs).find({ complete: true }, { projection: { asof: 1 } }).sort({ asof: -1 }).limit(1).next()
    return d?.asof ?? null
}
async function _latestQuarter(db) {
    const d = await db.collection(FUNDS).find({ level: 'universe' }, { projection: { quarter: 1 } }).sort({ quarter: -1 }).limit(1).next()
    return d?.quarter ?? null
}

/** The latest run of each → `{ insiders, funds, government }` (asof / quarter / asof), nulls where none ran. */
async function _flowRuns(db) {
    const [insiders, funds, government] = await Promise.all([_latestComplete(db, INSIDER_RUNS), _latestQuarter(db), _latestComplete(db, GOVERNMENT_RUNS)])
    return { insiders, funds, government }
}

/**
 * The flows facts an assessment carries (attached by code), from a sub-industry's three nodes → `{ insiders,
 * funds, government }`, each null without its node; null when all three are. Pure.
 */
export function flowFacts({ insiders = null, funds = null, government = null } = {}) {
    const i = insiders?.insiders, f = funds?.funds, g = government?.government
    const out = {
        insiders: i ? {
            asof: insiders.asof ?? null, companies_buying: i.companies_buying ?? 0, n_companies: insiders.n_companies ?? null,
            share_buying: i.share_buying ?? null, vs_universe: i.vs_universe ?? null, cluster: Boolean(i.cluster),
            value: i.value ?? 0, new: i.new ?? 0, top: (i.top ?? []).slice(0, 3),
        } : null,
        funds: f ? {
            quarter: funds.quarter ?? null, share: f.share ?? null, relative_share: f.relative_share ?? null,
            flow: f.flow ?? null, flow_vs_universe: f.flow_vs_universe ?? null,
            percentile: f.percentile ?? null, history_quarters: f.history_quarters ?? 0,
        } : null,
        government: g ? {
            asof: government.asof ?? null, through: (government.quarters ?? []).at(-1) ?? null,
            now: g.now ?? null, change: g.change ?? null, prev_change: g.prev_change ?? null, lines: (g.lines ?? []).slice(0, 3),
        } : null,
    }
    return out.insiders || out.funds || out.government ? out : null
}

/** One sub-industry's three nodes from the latest runs → `{ insiders, funds, government }` (docs or nulls). */
export async function readFlowNodes(code) {
    const db = await _io.db()
    const runs = await _flowRuns(db)
    const one = (coll, key, when) => (when ? db.collection(coll).findOne({ [key]: when, level: 'sub_industry', code }, { projection: { _id: 0 } }) : null)
    const [insiders, funds, government] = await Promise.all([
        one(INSIDERS, 'asof', runs.insiders), one(FUNDS, 'quarter', runs.funds), one(GOVERNMENT, 'asof', runs.government)])
    return { insiders, funds, government }
}

/** Every sub-industry's flows facts from the latest runs → `Map(code → flowFacts)`, for the weekly change scan. */
export async function readAllFlows() {
    const db = await _io.db()
    const runs = await _flowRuns(db)
    const all = async (coll, key, when) => (when
        ? db.collection(coll).find({ [key]: when, level: 'sub_industry' }, { projection: { _id: 0 } }).toArray()
        : [])
    const [ins, fun, gov] = await Promise.all([all(INSIDERS, 'asof', runs.insiders), all(FUNDS, 'quarter', runs.funds), all(GOVERNMENT, 'asof', runs.government)])
    const by = (rows) => new Map(rows.map(r => [r.code, r]))
    const [i, f, g] = [by(ins), by(fun), by(gov)]
    const codes = new Set([...i.keys(), ...f.keys(), ...g.keys()])
    return new Map([...codes].map(c => [c, flowFacts({ insiders: i.get(c) ?? null, funds: f.get(c) ?? null, government: g.get(c) ?? null })]))
}

const _pctx = (v, d = 0) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : 'n/a')
const _share = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : 'n/a')
// Insider buys run in thousands and millions, contract lines in billions: one unit for all read "$0.0B" (live read 2026-10-12).
const _money = (v) => (typeof v !== 'number' ? 'n/a'
    : Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`)

/**
 * A sub-industry's three nodes as text, each with how to read it. Pure. The insider line says outright that the
 * cluster has NO TESTED EDGE: it failed its declared test on 2006–2026 history (pythia-money-flows.md §6, T1).
 */
export function formatFlows(nodes = {}) {
    const f = flowFacts(nodes)
    if (!f) return 'Insiders, funds, government: not measured for this industry yet.'
    const lines = []
    const i = f.insiders
    if (i) {
        const top = (i.top ?? []).map(t => `${t.symbol} ${t.title ?? ''} ${_money(t.value)} (${t.traded})`.replace(/\s+/g, ' ')).join(', ')
        lines.push(`INSIDERS (open-market buys by officers and directors, last 90 days; run ${i.asof}): ${i.companies_buying} of ${i.n_companies} companies bought`
            + `${typeof i.vs_universe === 'number' ? ` — ${i.vs_universe.toFixed(1)}× the market's rate` : ''}, ${_money(i.value)} in all, ${i.new} new this week.`
            + ` CLUSTER: ${i.cluster ? 'YES' : 'no'}${top ? `. Largest: ${top}` : ''}.`,
        '  Read as AWARENESS ONLY: a cluster had NO TESTED EDGE on industries over 2006–2026 (it did not beat the industry\'s own average afterwards). Name it as a fact; never as the reason for a verdict. Selling is not measured (most of it is scheduled).')
    }
    const fu = f.funds
    if (fu) {
        lines.push(`FUNDS (13F ownership, quarter ${fu.quarter}; filed up to 45 days after it): ${_share(fu.share)} of the industry's market value held — ${typeof fu.relative_share === 'number' ? `${fu.relative_share.toFixed(2)}× the market's share` : 'n/a'}`
            + `${typeof fu.percentile === 'number' ? `, at the ${Math.round(fu.percentile * 100)}th percentile of its own last ${fu.history_quarters} quarters` : ''}; this quarter's change against the market ${_pctx(fu.flow_vs_universe, 1)}.`,
        '  Read as CROWDING, never a lead: where funds WERE. At the top of its range it is a warning (who is left to buy?); it never says "follow".')
    }
    const g = f.government
    // An industry no contract line maps to has no government money to read — said once, not as "$0, n/a".
    if (g && !(g.now > 0)) lines.push('GOVERNMENT: no federal contract lines map to this industry.')
    else if (g) {
        lines.push(`GOVERNMENT (federal contract dollars on the lines this industry sells into, four quarters to ${g.through}): ${_money(g.now)}, ${_pctx(g.change)} on the four before (a year earlier ${_pctx(g.prev_change)})`
            + `${g.lines?.length ? `; largest lines: ${g.lines.map(l => `${l.name ?? l.naics} ${_money(l.dollars)}`).join(', ')}` : ''}.`,
        '  Read the CHANGE, not the level: the dollars are the lines\' money, shared with private contractors — not the industry\'s revenue.')
    }
    return lines.join('\n')
}

/**
 * Every ticker in the measured universe (not stale, one listing per filer) — a Set. A projected find, not
 * `distinct`: the engine's connection runs Mongo's strict versioned API, which refuses `distinct`.
 */
export async function universeSymbols() {
    const db = await _io.db()
    const rows = await db.collection(COMPANIES).find(companiesQuery('sector_code', { $exists: true }), { projection: { _id: 0, symbol: 1 } }).toArray()
    return new Set(rows.map(r => r.symbol).filter(Boolean))
}

/** At least this many of a sub-industry's own companies, or the level that answers it is used instead. */
export const MIN_OWN_COMPANIES = 3

/**
 * A sub-industry's largest companies, ROLLING UP when thin: its own when it has at least MIN_OWN_COMPANIES,
 * else those of the level that answers it (`answered_at`) — the same rule its numbers follow. `sub` is the
 * metrics node (readSubIndustry().sub). THE one place this rule lives: an industry's news basket, the basket
 * its call is graded on and a theme link's basket all read it (code review 2026-10-11: three copies had
 * drifted, and the call's never rolled up, so thin industries were silently left out of the track record).
 */
export async function largestCompanies(sub, { limit = 15 } = {}) {
    if (!sub?.code) return []
    const own = await readCompanies('sub_industry', sub.code, { limit })
    const at = sub.answered_at
    if (own.length >= MIN_OWN_COMPANIES || !at || at.level === 'sub_industry') return own
    return readCompanies(at.level, at.code, { limit })
}
