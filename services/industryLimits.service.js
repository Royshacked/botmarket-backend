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
 * so, and Atlas recorded it as `concentration: "single_industry"`. The cap is off for that book; the hype brake and
 * the Avoid flag still apply. Pure.
 */
export function isSingleIndustry(mandate) {
    return mandate?.concentration === 'single_industry'
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
    if (braked.length) {
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

/** The Avoid names among these symbols → `[{ asset, industry }]`. For the server-side check at save time. */
export async function avoidNames(symbols, deps = _deps) {
    const bySymbol = await industriesFor(symbols, deps)
    return [...new Set(symbols.map(s => String(s ?? '').toUpperCase()))]
        .filter(s => bySymbol[s]?.assessment?.verdict === 'avoid')
        .map(s => ({ asset: s, industry: bySymbol[s].name ?? bySymbol[s].code }))
}
