// The HOUSE's industry limits on a book (docs/design/pythia-assessment.md §10, build step 7; Roy, 2026-10-11).
// One mechanism for both places Atlas commits money — constructing a book (portfolio.agent `_sizePlan`) and adding
// a name to one (portfolioRebalance `_addItem`):
//
//   • HYPE BRAKE   a name in an industry whose basket carries Pythia's hype flag (up 100%+ in two years and 100%+
//                  over the market, read on the size-weighted line) gets HALF the weight it was given
//   • INDUSTRY CAP no GICS SUB-INDUSTRY holds more than a third of the book; the excess goes to the other
//                  industries in proportion, and what cannot go anywhere stays in cash
//   • AVOID        a name in an industry Pythia rates `avoid` is FLAGGED, never removed: the book is saved only with
//                  the user's explicit OK (the house advises; the mandate and the user decide)
//
// Clamped in CODE, not asked of the model (until step 7 every limit lived in Atlas's prompt). A name the engine never
// classified has no industry: it is neither braked nor capped. The join is industryView.viewsForSymbols — the one
// "what does the house think of this name's industry" read.

import { industryViewService } from '../api/strategy/industryView.service.js'
import { logger } from './logger.service.js'

const LOG = '[industryLimits]'
export const INDUSTRY_CAP = 1 / 3
export const HYPE_FACTOR = 0.5

const _pct = (v) => `${Math.round(v * 100)}%`

/**
 * A mandate that IS one industry (Roy, 2026-10-11: "let a single-industry mandate override the cap") — the user said
 * so, and Atlas recorded it as `concentration: "single_industry"`. Pure.
 */
export function isSingleIndustry(mandate) {
    return mandate?.concentration === 'single_industry'
}

/**
 * The share of the book that must sit in ONE sub-industry before a single-industry mandate lifts the cap (code review
 * 2026-10-11: the mandate field is written by the model, so the book itself has to bear it out — an ordinary book
 * with the flag keeps its cap).
 */
export const SINGLE_INDUSTRY_MIN = 0.8

/** The largest share of `total` any one sub-industry holds in these weights. Pure. */
export function topIndustryShare(items, bySymbol = {}) {
    const total = items.reduce((s, i) => s + (i.weight > 0 ? i.weight : 0), 0)
    if (!(total > 0)) return 0
    const by = new Map()
    for (const i of items) {
        const c = bySymbol[String(i.asset ?? '').toUpperCase()]?.code
        if (c && i.weight > 0) by.set(c, (by.get(c) ?? 0) + i.weight)
    }
    return Math.max(0, ...by.values()) / total
}

/**
 * The cap for this book: none when the mandate is single-industry AND the book is (≥ SINGLE_INDUSTRY_MIN in one
 * sub-industry), else INDUSTRY_CAP. → `{ cap, note }`, `note` saying why a flag was not honoured. Pure.
 */
export function capFor(mandate, items, bySymbol = {}) {
    if (!isSingleIndustry(mandate)) return { cap: INDUSTRY_CAP, note: null }
    const top = topIndustryShare(items, bySymbol)
    if (top >= SINGLE_INDUSTRY_MIN - 1e-9) return { cap: Infinity, note: 'Industry cap off: the mandate is a single-industry book.' }
    return { cap: INDUSTRY_CAP, note: `The mandate says single-industry, but no industry holds ${_pct(SINGLE_INDUSTRY_MIN)} of this book (the largest ${_pct(top)}) — the cap stays.` }
}

/** Does the user's OK (`avoid_ok`: the symbols they said yes to) cover every Avoid name? Pure. */
export function avoidOkCovers(avoid, ok) {
    const yes = new Set((Array.isArray(ok) ? ok : []).map(s => String(s ?? '').toUpperCase()))
    return (avoid ?? []).every(a => yes.has(String(a.asset ?? '').toUpperCase()))
}

/**
 * Apply the limits to weights. Pure. `items`: `[{ asset, weight }]` (weights > 0, any sum); `bySymbol`: the
 * viewsForSymbols shape (`{ SYM: { code, name, assessment: { verdict, hype } } }`). The output weights sum to the
 * input's total minus what had to stay in cash. → `{ weights: [number], cash, notes: [string], avoid: [{ asset,
 * industry }], braked: [asset], capped: [code] }`.
 */
export function applyIndustryLimits(items, bySymbol = {}, { cap = INDUSTRY_CAP } = {}) {
    const total = items.reduce((s, i) => s + (i.weight > 0 ? i.weight : 0), 0)
    const notes = [], avoid = [], braked = []
    if (!(total > 0)) return { weights: items.map(() => 0), cash: 0, notes, avoid, braked, capped: [] }
    const info = items.map(i => bySymbol[String(i.asset ?? '').toUpperCase()] ?? null)

    // 1. Hype brake: halve, then rescale so the book is still fully invested — the braked names lose share to the rest.
    let w = items.map((i, k) => {
        const base = i.weight > 0 ? i.weight : 0
        if (info[k]?.assessment?.hype) { braked.push(i.asset); return base * HYPE_FACTOR }
        return base
    })
    const weighted = items.filter(i => i.weight > 0).length
    if (braked.length && braked.length === weighted) {
        // Every name is braked: halving them all and rescaling changes nothing, so say THAT, not "at half weight".
        w = items.map(i => (i.weight > 0 ? i.weight : 0))
        notes.push(`Every name here is in a hype industry, so the brake has nothing to shift weight to — the weights stand; consider holding cash.`)
    } else if (braked.length) {
        const s = w.reduce((a, b) => a + b, 0)
        w = w.map(x => x * total / s)
        notes.push(`Hype brake: ${braked.join(', ')} at half weight — ${braked.length === 1 ? 'its industry has' : 'their industries have'} run up 100%+ in two years and 100%+ over the market.`)
    }

    // 2. Industry cap, water-filled: cap the heaviest sub-industry, hand its excess to the uncapped classified ones,
    //    repeat. Unclassified names take a share of the excess too but are never capped. What no one can take is cash.
    const key = (k) => info[k]?.code ?? null
    const capped = new Set()
    const capAbs = cap * total
    for (let guard = 0; Number.isFinite(capAbs) && guard < items.length + 1; guard++) {
        const byCode = new Map()
        w.forEach((x, k) => { const c = key(k); if (c) byCode.set(c, (byCode.get(c) ?? 0) + x) })
        const over = [...byCode.entries()].filter(([c, s]) => s > capAbs + 1e-12 && !capped.has(c))
        if (!over.length) break
        let excess = 0
        for (const [c, s] of over) {
            const f = capAbs / s
            w = w.map((x, k) => (key(k) === c ? x * f : x))
            excess += s - capAbs
            capped.add(c)
        }
        const takers = w.map((x, k) => (x > 0 && !capped.has(key(k)) ? k : -1)).filter(k => k >= 0)
        const room = takers.reduce((s, k) => s + w[k], 0)
        if (room > 0) w = w.map((x, k) => (takers.includes(k) ? x + excess * x / room : x))
    }
    const invested = w.reduce((a, b) => a + b, 0)
    const cash = Math.max(0, total - invested)
    for (const c of capped) {
        const name = info.find(v => v?.code === c)?.name ?? c
        notes.push(`Industry cap: ${name} held to a third of the book.`)
    }
    if (cash > 1e-9) notes.push(`${_pct(cash / total)} left in cash — too few industries to spread it without passing the cap.`)

    // 3. Avoid: flagged for the user's OK.
    items.forEach((i, k) => {
        if (info[k]?.assessment?.verdict === 'avoid') avoid.push({ asset: i.asset, industry: info[k].name ?? info[k].code })
    })
    if (avoid.length) notes.push(`Pythia rates ${[...new Set(avoid.map(a => a.industry))].join(', ')} AVOID (${avoid.map(a => a.asset).join(', ')}) — the book is saved only with your OK.`)

    return { weights: w, cash, notes, avoid, braked, capped: [...capped] }
}

const _deps = { views: (symbols) => industryViewService.viewsForSymbols(symbols) }
export function _setDeps(d) { Object.assign(_deps, d) }

/**
 * The industries of these symbols, or {} when the read fails — a limit that cannot read the industries does not
 * apply (and says so in the log) rather than blocking a book.
 */
export async function industriesFor(symbols, deps = _deps) {
    try {
        return await deps.views(symbols)
    } catch (err) {
        logger.warn(LOG, 'industries not read — limits not applied', err.message)
        return {}
    }
}

/**
 * The limits on ONE name added to a book by WEIGHT — an edit-mode add (`POST /api/trade-ideas` with a portfolioId),
 * where the book has no live value yet and its siblings carry ratios (code review 2026-10-11: those adds bypassed
 * every limit). `siblings`: `[{ asset, allocationRatio }]` of the book's open ideas. → `{ ok: true, allocationRatio,
 * notes }` or `{ ok: false, reason: 'avoid_industry' | 'industry_cap', detail, avoid? }`. Pure.
 */
export function limitAddByRatio(spec, siblings, bySymbol = {}, { mandate = null, avoidOk = [] } = {}) {
    const asset = String(spec?.asset ?? '').toUpperCase()
    const mine = bySymbol[asset]
    const notes = []
    let ratio = Number(spec?.allocationRatio) > 0 ? Number(spec.allocationRatio) : null
    if (!mine?.code) return { ok: true, allocationRatio: ratio, notes }
    if (mine.assessment?.verdict === 'avoid' && !avoidOkCovers([{ asset }], avoidOk)) {
        const industry = mine.name ?? mine.code
        return { ok: false, reason: 'avoid_industry', detail: `Pythia rates ${industry} AVOID — add ${asset} only with your OK`, avoid: [{ asset, industry }] }
    }
    if (ratio == null) return { ok: true, allocationRatio: null, notes }
    if (mine.assessment?.hype) { ratio *= HYPE_FACTOR; notes.push(`Hype brake: ${asset} at half weight.`) }
    const book = (siblings ?? []).map(s => ({ asset: s.asset, weight: Number(s.allocationRatio) || 0 })).concat([{ asset, weight: ratio }])
    if (capFor(mandate, book, bySymbol).cap === Infinity) return { ok: true, allocationRatio: ratio, notes }
    const total = book.reduce((s, i) => s + (i.weight > 0 ? i.weight : 0), 0) || 1
    const already = book.slice(0, -1).filter(s => bySymbol[String(s.asset).toUpperCase()]?.code === mine.code).reduce((s, i) => s + i.weight, 0)
    const room = INDUSTRY_CAP * total - already
    if (room <= 1e-9) return { ok: false, reason: 'industry_cap', detail: `${mine.name ?? mine.code} already holds a third of the book` }
    if (ratio > room) { ratio = room; notes.push(`Industry cap: ${asset} cut to keep ${mine.name ?? mine.code} at a third of the book.`) }
    return { ok: true, allocationRatio: ratio, notes }
}

/** The Avoid names among these symbols → `[{ asset, industry }]`. For the server-side check at save time. */
export async function avoidNames(symbols, deps = _deps) {
    const bySymbol = await industriesFor(symbols, deps)
    return [...new Set(symbols.map(s => String(s ?? '').toUpperCase()))]
        .filter(s => bySymbol[s]?.assessment?.verdict === 'avoid')
        .map(s => ({ asset: s, industry: bySymbol[s].name ?? bySymbol[s].code }))
}
