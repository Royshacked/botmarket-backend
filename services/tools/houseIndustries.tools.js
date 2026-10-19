/**
 * The house's industries for a book, as Argus's read tool (docs/design/argus-on-pythia.md §3.2): the
 * sub-industries Pythia rates FOR SWING or FOR LONG TERM (and the links of approved themes rated so), and
 * one industry's companies — so a swing or long-term scan looks there FIRST.
 *
 * A PREFERENCE, never a filter (Roy, 2026-10-13): the scan still covers the rest of the market, and a name
 * from these industries is labelled, not scored up. The tool says so in every answer.
 *
 * UNBOUND — no userId: the verdicts are a broadcast. READ-ONLY: changing a verdict is Pythia's desk.
 * Its output feeds Argus's grounding ledger as a discovery source (scanner.grounding.js DISCOVERY_TOOLS):
 * a company it lists came from the house's own classified universe.
 */

import { makeToolHandler } from '../agentUtils.js'
import { industryAssessmentService, BOOKS, VERDICTS } from '../../api/strategy/industryAssessment.service.js'
import { readSubIndustry, largestCompanies, coveredSymbols, formatCompanies } from '../../api/strategy/industryData.service.js'

const LOG = '[houseIndustries]'
const DEFAULT_COMPANIES = 15
const MAX_COMPANIES = 40
/** Industries shown in full; the rest by name only (a 32-industry swing list ran ~18k characters, 2026-10-13). */
export const FULL_ENTRIES = 20

// Atlas reads the SAME list (docs/design/atlas-industry-sleeves.md, Roy 2026-10-19) — one pipe, two readers. What
// the list is FOR is each reader's own judgment: Argus looks there first on a scan and screens the rest; Atlas builds
// a book's sleeves from it, one GICS sub-industry per sleeve. So the data and the formatting are shared, and the
// description and the closing note are the reader's (`words` below).
export const ATLAS_HOUSE_INDUSTRIES_TOOL_SPEC = {
    get_house_industries: `The HOUSE'S INDUSTRIES for this book — the GICS sub-industries Pythia (the house's industry desk) rates FOR SWING or FOR LONG TERM, plus the industries inside the themes it rates so, each with its thesis, top risk, how far it has moved and the companies it names. Pass \`book\` (the mandate's: "swing" for under about a year, "long_term" for longer — use judgment in between) at the start of a build: THESE ARE THE CANDIDATE SLEEVES, one sub-industry per sleeve. Pass \`industry\` (a code or name) for one industry's largest companies, our coverage marked. The house judges industries, never stocks, and the mandate and the user still outrank it.`,
}

export const HOUSE_INDUSTRIES_TOOL_SPEC = {
    get_house_industries: `The HOUSE'S INDUSTRIES for a book — the GICS sub-industries Pythia (the house's industry desk) currently rates FOR SWING or FOR LONG TERM, plus the industries inside the themes it rates so, each with its thesis, its top risk and how far it has moved. Pass \`book\` ("swing" or "long_term", and optionally \`sector\`) on a swing or long-term scan, BEFORE you screen: these are the first place to look. Then pass \`industry\` (a code or name from that list) for its largest companies, our coverage marked. A PREFERENCE, never a filter: screen the rest of the market as you always do, rank by the tape as you always do — being on the house's list adds nothing to a score — and keep a stronger name from outside these industries. Label every name you take from here as on the house's swing / long-term list. Intraday and day scans have no house list: Pythia's verdicts run weeks to years.`,
}

const BOOK_WORDS = { swing: 'SWING', long_term: 'LONG-TERM' }
const ORDER_WORDS = { 1: 'direct', 2: 'supplier' }

/** "swing" · "long_term" · "long term" · "long-term" → the book; anything else → null. Pure. */
export function normalizeBook(v) {
    const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    return BOOKS.includes(s) ? s : null
}

// A second-order line is up to 600 characters as written; the list carries up to twenty industries.
const SECOND_ORDER_MAX = 260
const _clip = (t) => (t.length > SECOND_ORDER_MAX ? `${t.slice(0, SECOND_ORDER_MAX - 1).trimEnd()}…` : t)

/** "CIEN (first), VRT (second — Electrical Components & Equipment)". Pure — exported for testing. */
export function namesLine(names) {
    return (names ?? []).map(n => `${n.symbol} (${n.order === 'second' ? `second — ${n.industry ?? 'another industry'}` : 'first'})`).join(', ')
}

const _pct = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%` : null)

/**
 * What each reader is told around the shared list (see ATLAS_HOUSE_INDUSTRIES_TOOL_SPEC). `empty` and `footer` take
 * the book; `noBook` the value passed; `failed` the error.
 */
export const SCAN_WORDS = Object.freeze({
    empty:  (book, where) => `The house has no industries rated for ${BOOK_WORDS[book].toLowerCase()}${where} right now (none rated, or every verdict is due for reassessment). Scan the market as you normally would, and say in one line that there was no house list to start from.`,
    footer: (book) => `Look here FIRST — \`get_house_industries\` with \`industry\` lists one's largest companies; these are GICS names, which the screener does not know, so never pass them to \`screen_candidates\` — then screen the rest of the market as usual, in the screener's own names. A preference, not a filter: the tape still ranks, the list adds nothing to a score, and a stronger name from outside these industries stays. Label each name you take from here "on the house's ${book === 'swing' ? 'swing' : 'long-term'} list". "Who else it reaches" is the house's second-order read — the suppliers, customers or neighbours its view spills into: a place to look as good as the industry itself, neither preferred. The house judges industries, not stocks: whether a name is priced in is yours to check.`,
    noBook: (v) => `The house has no list for "${v}". Pythia's verdicts are for swing (weeks to months) and long term (years); an intraday or day scan has no house list — scan the market as you normally would.`,
    failed: (err) => `Could not read the house's industries: ${err.message} — scan the market as you normally would.`,
})

export const ATLAS_WORDS = Object.freeze({
    empty:  (book, where) => `The house has no industries rated for ${BOOK_WORDS[book].toLowerCase()}${where} right now (none rated, or every verdict is due for reassessment). Say so in one line, and build the sleeves from the mandate and the user's asks — each one GICS sub-industry, with the reason for it stated.`,
    footer: () => 'These are the CANDIDATE SLEEVES — one GICS sub-industry each; carry its code on the sleeve. `get_coverage` with `industry` gives the researched names to place in one; `get_house_industries` with `industry` its largest companies. FOR this book: build from them. AVOID: only when the user asks for it (the platform asks them before it saves). HYPE: allowed — the platform halves the weight; say so. An industry NOT on this list is fine when the user asks for it, or when you state the reason for it. "Who else it reaches" is the house\'s second-order read — a candidate sleeve too. The house judges industries, not stocks; the mandate and the user outrank it.',
    noBook: (v) => `The house has no list for "${v}". Pythia's verdicts are for swing (weeks to months) and long term (years) — pick the nearer one for this mandate's horizon.`,
    failed: (err) => `Could not read the house's industries: ${err.message} — say so, and build the sleeves from the mandate with the reason for each stated.`,
})

/** The list for a book → LLM-ready text. Pure — exported for testing. `words`: the reader's (SCAN_WORDS by default). */
export function formatHouseIndustries(book, entries, { sector = null, words = SCAN_WORDS } = {}) {
    const where = sector ? ` in ${sector}` : ''
    if (!entries?.length) return words.empty(book, where)
    const lines = entries.slice(0, FULL_ENTRIES).map(e => {
        const flags = [
            e.hype ? 'HYPE (ran up 100%+ in two years and 100%+ over the market — a crash-risk flag)' : null,
            e.avoid ? 'the house rates the industry itself AVOID — it is here only through a theme; say so on any name from it' : null,
            _pct(e.excess_12m) ? `12 months ${_pct(e.excess_12m)} over SPY` : null,
        ].filter(Boolean)
        const out = [`  ${e.code}  ${e.name} [${e.sector ?? 'sector n/a'}]${flags.length ? ` · ${flags.join(' · ')}` : ''}`]
        if (e.rated) {
            out.push(`      thesis (${e.horizon ?? 'horizon n/a'}): ${e.thesis ?? 'n/a'}`)
            if (e.top_risk) out.push(`      top risk: ${e.top_risk}`)
            if (e.second_order) out.push(`      who else it reaches: ${_clip(e.second_order)}`)
            if (e.names?.length) out.push(`      the house names: ${namesLine(e.names)}`)
        }
        for (const t of e.themes ?? []) {
            out.push(`      via theme "${t.name}" (${ORDER_WORDS[t.order] ?? `order ${t.order}`} link): ${t.thesis ?? 'n/a'}`)
            if (t.second_order) out.push(`        who else the theme reaches: ${_clip(t.second_order)}`)
            if (t.names?.length) out.push(`        the theme names: ${namesLine(t.names)}`)
        }
        return out.join('\n')
    })
    const rest = entries.slice(FULL_ENTRIES)
    if (rest.length) {
        const names = rest.map(e => `${e.name} (${e.code})${e.hype ? ' HYPE' : ''}${e.avoid ? ' avoid' : ''}`).join(', ')
        lines.push(`  ${rest.length} more, names only (smaller moves — pass \`industry\` for any): ${names}`)
    }
    return [
        `THE HOUSE'S ${BOOK_WORDS[book]} INDUSTRIES${where} (Pythia's standing verdicts, biggest 12-month move first):`,
        ...lines,
        '',
        words.footer(book),
    ].join('\n')
}

/**
 * One industry's companies → text. Pure — exported for testing. `verdict` is verdictsForCodes' entry, or null; `named`
 * the companies its standing assessment names (pythia-names.md) — listed FIRST, as company rows, with why.
 */
export function formatIndustryCompanies(sub, rows, covered, verdict = null, named = []) {
    const rolled = (rows ?? []).some(r => r.sub_industry && r.sub_industry !== sub.name)
    const v = verdict?.verdict ? (VERDICTS[verdict.verdict] ?? verdict.verdict) : 'not assessed'
    return [
        `${sub.name} (${sub.code}) [${sub.sector ?? 'sector n/a'}] — the house's verdict: ${v}${verdict?.hype ? ' · HYPE' : ''}`,
        ...(rolled ? [`  Too few ${sub.name} companies of its own: these are the largest of the level that answers it — check each one's own business fits.`] : []),
        ...(named.length ? [
            '  The companies the house\'s assessment names — what its evidence pointed at (first and second order equal):',
            ...named.map(n => `  ${n.symbol.padEnd(6)} ${n.order === 'second' ? `second order (${n.industry ?? 'another industry'})` : 'first order'} — ${n.why}${covered.has(n.symbol) ? '  [OUR COVERAGE]' : ''}`),
        ] : []),
        `  Largest ${rows?.length ?? 0}, by market cap:`,
        formatCompanies(rows, covered),
        '',
        'Every name here still goes through the usual checks — the tape, liquidity, the catalyst. Size alone is not a reason.',
    ].join('\n')
}

export function makeHouseIndustriesHandlers(deps = {}) {
    const {
        forBook  = (book, opts) => industryAssessmentService.listForBook(book, opts),
        readSub  = (key) => readSubIndustry(key),
        largest  = (sub, limit) => largestCompanies(sub, { limit }),
        covered  = () => coveredSymbols(),
        verdicts = (codes) => industryAssessmentService.verdictsForCodes(codes),
        assessment = (code) => industryAssessmentService.getAssessment(code),
        now      = () => new Date().toISOString(),
        words    = SCAN_WORDS,
    } = deps

    return {
        get_house_industries: makeToolHandler('get_house_industries', async (input) => {
            const industry = typeof input?.industry === 'string' ? input.industry.trim() : ''
            if (industry) {
                const b = await readSub(industry)
                if (!b) return `No GICS sub-industry "${industry}" — pass a code or name from the \`book\` list.`
                const limit = Math.min(Math.max(parseInt(input?.limit, 10) || DEFAULT_COMPANIES, 1), MAX_COMPANIES)
                const [rows, cov, vs, a] = await Promise.all([largest(b.sub, limit), covered(), verdicts([b.sub.code]),
                    assessment(b.sub.code).catch(() => null)])
                // The names of a STANDING assessment only: an expired one is due for reassessment.
                const named = a && (!a.expires_at || a.expires_at > now()) ? (a.names ?? []) : []
                return formatIndustryCompanies(b.sub, rows, cov ?? new Set(), vs?.get?.(b.sub.code) ?? null, named)
            }
            if (input?.book == null || input.book === '') return 'Pass `book` ("swing" or "long_term") for the house\'s industries, or `industry` for one industry\'s companies.'
            const book = normalizeBook(input.book)
            if (!book) return words.noBook(input.book)
            const sector = typeof input?.sector === 'string' && input.sector.trim() ? input.sector.trim() : null
            return formatHouseIndustries(book, await forBook(book, { sector }), { sector, words })
        }, (err) => words.failed(err), LOG),
    }
}
