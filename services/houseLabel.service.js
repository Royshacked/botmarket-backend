// The HOUSE LABEL on a name — "on the house's swing / long-term list" (docs/design/argus-on-pythia.md §3.4, step 5).
//
// A FACT, worked out by code, never taken from the model: a name carries the label when its GICS sub-industry is on
// the house's list for the book (industryAssessmentService.listForBook — Pythia's own verdict, or an approved theme
// rated the book that links the industry). Argus still SAYS it in its thesis; this is what the card and the next
// desk read, and it cannot be invented by a model or by a request body.
//
// One mechanism, three readers: Argus's scan candidates, Argus's hand-off pick, and Mentor's opening on a handed-over
// name. A preference label, not a score: nothing here touches a rank. Never throws — a failed read is no label.

import { industryAssessmentService, BOOKS } from '../api/strategy/industryAssessment.service.js'
import { readCompaniesBySymbol } from '../api/strategy/industryData.service.js'
import { logger } from './logger.service.js'

const LOG = '[houseLabel]'

const _deps = {
    forBook:    (book) => industryAssessmentService.listForBook(book),
    industryOf: async (symbols) => Object.fromEntries(Object.entries(await readCompaniesBySymbol(symbols)).map(([s, r]) => [s, r.sub_code])),
}
/** Test seam. */
export function _setHouseLabelDeps(d) { Object.assign(_deps, d) }

/** The books a scan's style asks about: swing → swing, long term → long_term; intraday / day → none. Pure. */
export function booksForStyle(style) {
    if (style === 'swing') return ['swing']
    if (style === 'long term') return ['long_term']
    return []
}

/**
 * The label for each symbol, from the house's lists per book (`listsByBook`: book → listForBook entries) and each
 * symbol's sub-industry code (`industryOf`). When a symbol's industry is on more than one book's list, the first
 * book in `books` wins. Pure → Map(SYMBOL → { book, code, industry, hype, avoid, themes, thesis }).
 */
export function labelsFrom(symbols, industryOf, listsByBook, books) {
    const out = new Map()
    for (const sym of symbols ?? []) {
        const code = industryOf?.[sym]
        if (!code) continue
        for (const book of books) {
            const e = (listsByBook?.[book] ?? []).find(x => x.code === code)
            if (!e) continue
            out.set(sym, {
                book, code, industry: e.name, hype: e.hype === true, avoid: e.avoid === true,
                themes: (e.themes ?? []).map(t => t.name),
                // The industry's own thesis, else the first theme's: the reason the house holds it on the list.
                thesis: e.thesis ?? e.themes?.[0]?.thesis ?? null,
            })
            break
        }
    }
    return out
}

/** Labels for these symbols on these books. Never throws: any failure → an empty map (no label). */
export async function houseLabels(symbols, { books = BOOKS } = {}, deps = _deps) {
    const syms = [...new Set((symbols ?? []).map(s => String(s ?? '').toUpperCase().trim()).filter(Boolean))]
    const want = (books ?? []).filter(b => BOOKS.includes(b))
    if (!syms.length || !want.length) return new Map()
    try {
        const [industryOf, ...lists] = await Promise.all([deps.industryOf(syms), ...want.map(b => deps.forBook(b))])
        return labelsFrom(syms, industryOf, Object.fromEntries(want.map((b, i) => [b, lists[i]])), want)
    } catch (err) {
        logger.warn(LOG, 'house labels unreadable — names go without one', err.message)
        return new Map()
    }
}

/** The label as the wire carries it (the card's chip and the next desk). Pure. */
export function wireLabel(l) {
    return l ? { book: l.book, industry: l.industry, hype: l.hype, avoid: l.avoid, themes: l.themes } : null
}

/** The label as a desk's prompt reads it. Pure. */
export function formatHouseLabel(l) {
    if (!l) return ''
    const list = l.book === 'swing' ? 'swing' : 'long-term'
    const via = l.themes?.length ? ` (via the theme${l.themes.length > 1 ? 's' : ''} ${l.themes.map(t => `"${t}"`).join(', ')})` : ''
    const flags = [l.hype ? 'HYPE — ran up 100%+ in two years and 100%+ over the market, a crash-risk flag' : null,
        l.avoid ? 'the house rates the industry itself AVOID' : null].filter(Boolean)
    return `on the house's ${list} list — ${l.industry}${via}${flags.length ? `; ${flags.join('; ')}` : ''}${l.thesis ? `. The house's reason: ${l.thesis}` : ''}`
}
