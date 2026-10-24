// ARGUS PICKS THE HOUSE SCAN'S NAMES — filter 1 of the house research chain (docs/design/house-research-chain.md
// step 4; Roy, 2026-10-23: "argus takes the industry names and pythia thesis and gives the best 5").
//
// One call per FOR SWING / FOR LONG TERM industry (or theme link): Pythia's assessment in, the industry's candidate
// list in (houseScan.candidates — code measured it), the names that best carry HER thesis out, each with why and
// what would make it wrong. Prometheus is filter 2: he researches each pick and writes the coverage.
//
// THE SPLIT. The list's numbers are code; which names carry the thesis — the pure play against the conglomerate,
// the second-order name the crowd misses, the leader that keeps leading — is the judgment numbers cannot make.
// Argus may only pick from the list, never a name already in our coverage (it is in the book already), and at
// most `max`; code holds him to all three. "Already moved" is not a reason to skip a name (Roy, 2026-10-23).
//
// FAILS SOFT: no answer, an unreadable one, or no valid pick → the code order (named first, then the book's order),
// marked `source: 'code'`, so a week always sends names. Runs on the HOUSE chat model through the shared one-shot,
// like the hotlist's read (hotlist.argus.js).

import { getHouseModels } from './houseModels.service.js'
import { oneShotText } from './oneShot.service.js'
import { DEFAULT_MODEL } from './llmModels.js'
import { extractFirstJSON } from '../monitoring/parsers/llmReply.parser.js'
import { candidateLine } from './houseScan.candidates.js'
import { logger } from './logger.service.js'

const LOG = '[houseScan.argus]'
const TEXT_CHARS = 300

const BOOK_WORDS = { swing: 'FOR SWING (a trade over weeks to months)', long_term: 'FOR LONG TERM (a holding over years)' }

export const SYSTEM = `You are Argus, the scanning desk. Pythia, the industry desk, has rated an industry for a book and written her case. Your job: from the industry's companies, choose the names that best carry HER thesis — the ones Prometheus, the research desk, should research next. He will judge each one and set a price target; you choose who gets researched.

Read her case first: the verdict and horizon, the thesis, what caused the move, the second-order view, the risks, and the companies she named. Then the list — every company measured the same way: its 3, 6 and 12-month returns and their gap to the industry's, its beta to the industry (how much it moves when the industry moves), the trend, how much trades a day; for the long-term book its return on capital, revenue growth and margin; the Street's EPS growth for next year; insiders buying; the next report.

How to choose:
- The thesis has to be THIS company's story. A name whose revenue mostly comes from something else (a conglomerate, a platform that only sits in the industry) does not carry it, however large.
- FOR SWING: the names that move with the industry's driver and are leading it — relative strength, a high beta to the industry, enough liquidity to get in and out, a report or catalyst inside the window. A name that has already run is NOT disqualified: strength tends to persist over months.
- FOR LONG TERM: the business that compounds on the thesis — a return on capital above its cost, revenue in what her thesis is about, room to reinvest. A long run-up is not a reason to skip it either.
- A second-order name she points at — a supplier, a customer the thesis implies — is yours to choose when the case supports it, even if it has not moved.
- A name marked [OUR COVERAGE] is already researched: never pick it.
- A name marked NAMED BY PYTHIA came from her reading of the news: a strong candidate, not a reserved seat. Take it when it carries the thesis; when it does not, say why in "passed".
- The rest of the slots are YOURS: fill them from the whole list with the names that carry the thesis best — her names do not use up your judgment. The industry's leaders, the purest plays, the names with a report inside the window are the ones she may not have named.
- Fewer than the slots only when the rest of the list truly does not carry the case; none when nothing does.

Answer ONLY a JSON object, no prose:
{"picks":[{"symbol":"ABC","why":"one sentence: how this company carries the thesis","caution":"one sentence: what would make it wrong"}],"passed":[{"symbol":"XYZ","why":"one sentence"}],"note":"one sentence on the list as a whole"}
"picks" best first, at most the number you are told. "passed": only names Pythia named that you did not pick.`

const _txt = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, TEXT_CHARS) : null)

/** Her case and the list as the user turn. Pure. */
export function pickText({ assessment: a, subject, link = null, rows, max }) {
    const book = BOOK_WORDS[a?.verdict] ?? String(a?.verdict ?? '')
    const named = (a?.names ?? []).map(n => `${n.symbol}${n.why ? ` — ${n.why}` : ''}`)
    return [
        `INDUSTRY: ${subject}${link ? ` (the ${link} link of the theme)` : ''} — Pythia rates it ${book}${a?.horizon ? `, horizon ${a.horizon}` : ''}.`,
        `THESIS: ${a?.thesis ?? 'n/a'}`,
        `WHAT MOVED IT: ${a?.cause?.text ?? 'n/a'}${a?.cause?.kind ? ` (${a.cause.kind})` : ''}`,
        `SECOND ORDER: ${a?.second_order ?? 'n/a'}`,
        `RISKS: ${(a?.risks ?? []).join('; ') || 'n/a'}`,
        named.length ? `SHE NAMED: ${named.join('; ')}` : 'SHE NAMED: none',
        '',
        `CHOOSE UP TO ${max}. THE LIST (${rows.length}):`,
        ...rows.map(candidateLine),
    ].join('\n')
}

/**
 * The reply held to the list: a pick must be on it, not covered, not repeated; at most `max`. Pure →
 * `{ picks: [{ symbol, why, caution }], passed, note }`.
 */
export function normalizePicks(raw, rows, max) {
    const bySym = new Map(rows.map(r => [r.symbol, r]))
    const picks = [], seen = new Set()
    for (const p of Array.isArray(raw?.picks) ? raw.picks : []) {
        const symbol = String(p?.symbol ?? '').toUpperCase().trim()
        const row = bySym.get(symbol)
        if (!row || row.covered || seen.has(symbol)) continue
        seen.add(symbol)
        picks.push({ symbol, why: _txt(p.why), caution: _txt(p.caution) })
        if (picks.length >= max) break
    }
    const passed = (Array.isArray(raw?.passed) ? raw.passed : [])
        .map(p => ({ symbol: String(p?.symbol ?? '').toUpperCase().trim(), why: _txt(p?.why) }))
        .filter(p => bySym.has(p.symbol) && !seen.has(p.symbol)).slice(0, 10)
    return { picks, passed, note: _txt(raw?.note) }
}

/** The code order's first `max` uncovered names — the fallback. Pure. */
export function codePicks(rows, max) {
    return rows.filter(r => !r.covered).slice(0, max).map(r => ({ symbol: r.symbol, why: r.named ? 'named by Pythia' : null, caution: null }))
}

async function _houseModel() {
    try { return (await getHouseModels()).chatModel || DEFAULT_MODEL } catch { return DEFAULT_MODEL }
}

/**
 * Argus's picks for one industry. → `{ picks, passed, note, source: 'argus' | 'code', model? }`; never throws.
 *
 * @param {{ assessment: object, subject: string, link?: string, rows: object[], max: number }} input
 * @param {{ send?: Function, model?: () => Promise<string>, onUsage?: Function }} [deps]  test seams; `onUsage(usage, model)` books the spend
 */
export async function argusPicks(input, { send = oneShotText, model = _houseModel, onUsage } = {}) {
    const { rows = [], max } = input
    if (!rows.length || !(max > 0)) return { picks: [], passed: [], note: null, source: 'code' }
    const fallback = (why) => {
        logger.warn(LOG, `code order for ${input.subject}: ${why}`)
        return { picks: codePicks(rows, max), passed: [], note: null, source: 'code', fallback: why }
    }
    try {
        const m = await model()
        const text = await send({ model: m, systemText: SYSTEM, userText: pickText(input), maxTokens: 6000, onUsage: onUsage && (u => onUsage(u, m)) })
        const raw = extractFirstJSON(text)
        if (!raw || typeof raw !== 'object') return fallback('no readable answer')
        const read = normalizePicks(raw, rows, max)
        // An empty pick list is an ANSWER ("nothing carries it") only when he gave one; picks that were all off the
        // list or already covered are a failed answer, not a "none".
        if (!Array.isArray(raw.picks)) return fallback('no picks field')
        if (!read.picks.length && raw.picks.length) return fallback('no pick on the list')
        return { ...read, source: 'argus', model: m }
    } catch (err) {
        return fallback(err.message)
    }
}
