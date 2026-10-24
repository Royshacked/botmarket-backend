// ARGUS'S READ OF THE HOTLIST (docs/design/daily-names.md §1, build phase 5; Roy, 2026-10-21).
//
// Once per checkpoint, for everyone: the board's numbers in, Argus's judgment out — a short summary
// of the tape, the names it would look at first and why, and the traps. Stored on the board, so
// every user opens the same read; a user's OWN criteria go to Argus's chat with the board loaded.
//
// THE SPLIT (§1). The screener did the arithmetic and the grades; this is the judgment the numbers
// cannot make — which catalyst reads true, which gap is a trap, which of three B's is the trade.
// Argus may only pick from the board, and only on a column the board graded: code holds it to that,
// so a pick can never be a name nobody screened. No entry, stop or target — that is Mentor's, with
// the user (§5).
//
// Runs on the HOUSE chat model (houseModels — the admin's pick is everyone's), through the shared
// one-shot. FAILS SOFT: any error and the board goes out without Argus's read.

import { getHouseModels } from './houseModels.service.js'
import { oneShotText } from './oneShot.service.js'
import { DEFAULT_MODEL } from './llmModels.js'
import { extractFirstJSON } from '../monitoring/parsers/llmReply.parser.js'
import { logger } from './logger.service.js'

const LOG = '[hotlist.argus]'

/**
 * Picks PER COLUMN (docs/design/horizon-chains.md §2; Roy, 2026-10-23: "a list for each horizon"). Until then he picked
 * 8 across every column, so a board with an open and a week column could hand one horizon nothing. A name may be his
 * pick on two columns of one board — the open trade and the week's are different trades. DOUBLED 2026-10-24 (Roy: "more
 * Argus checks — double"): ten per column and ten avoids, over a board of sixty — a record twice as fast.
 */
export const MAX_PICKS = 10
export const MAX_AVOID = 10
const TEXT_CHARS = 280

/** The board's column ids in the words a trader uses — the prompt and the summary speak these. */
export const COLUMN_WORDS = Object.freeze({
    open: 'the session open', mid: 'mid-session', eod: 'into the close', tomorrow: 'tomorrow (overnight)', week: 'this week (2–10 days)',
})

export const SYSTEM = `You are Argus, the scanning desk, reading today's HOTLIST — a screened board of US stocks that are in play right now, long side only. The numbers are computed and the grades are given; your job is the judgment the numbers cannot make.

Each row: the ticker, its price and gap, volume against an ordinary day, ATR %, the catalyst label and headline if any, earnings date, and one cell per column it was graded on: the grade (A/B/C) and its FREE RANGE — how far price can travel before the nearest overhead level, in % and in × ATR. A is the most room. Free range is not a target and the board has no entries or stops; never invent them. A week cell marked RUN-UP holds a report inside its window: the trade is the run-up into it and ends before it — if you pick one, the caution says so.

Answer:
- "summary": 2–4 plain sentences on the tape — the regime, what is moving and why, where the room is.
- "picks": for EACH column on the board, up to ${MAX_PICKS} names you would look at FIRST for THAT horizon, best first — every column is its own list (the open's trade and this week's are different trades; a name can be a pick on both when it carries both). Each: "symbol", "column" (one the row is graded on), "why" (one sentence: what makes this the trade on this horizon — the catalyst, the structure, the room), "caution" (one sentence: what would make it wrong). Prefer a real catalyst with room over a big grade on a thin story. Fewer is fine; none is fine for a column with nothing worth it.
- "avoid": up to ${MAX_AVOID} names on the board that look better than they are — a minor story under a big gap, a catalyst already priced, an earnings coin-toss — each with "symbol" and "why".

Output ONLY a JSON object, no prose:
{"summary":"...","picks":[{"symbol":"ABC","column":"mid","why":"...","caution":"..."}],"avoid":[{"symbol":"XYZ","why":"..."}]}`

const _f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—')

/** The board as the user turn — one compact line per row. Pure. */
export function boardText(board) {
    const regime = board.regime ?? {}
    const head = [
        `CHECKPOINT: ${board.checkpoint} on ${board.day} — columns: ${(board.columns ?? []).map(c => `${c} (${COLUMN_WORDS[c] ?? c})`).join(', ')}`,
        `REGIME: breadth ${_f(regime.breadth_above_sma20, 1)}% of the universe above its 20-day average; SPY ${regime.spy?.above_sma20 ? 'above' : 'below'} its own, ${_f(regime.spy?.ret5)}% over 5 sessions`,
        'ROWS:',
    ]
    const rows = (board.rows ?? []).map(r => {
        const cells = Object.entries(r.cells ?? {}).filter(([, c]) => c.grade).map(([col, c]) =>
            `${col} ${c.grade} (${c.range?.open_sky ? 'open sky' : `${_f(c.range?.pct)}% / ${_f(c.range?.atr_mult)}× ATR to ${_f(c.range?.level)}`})${c.exit_before ? `, RUN-UP: out before earnings ${c.exit_before}` : ''}`).join('; ')
        const cat = r.catalyst ? `${r.catalyst.material ? `${r.catalyst.type} ${r.catalyst.surprise}` : 'not material'}${r.catalyst.headline ? `: "${r.catalyst.headline}"` : ''}` : 'no news label'
        return `${r.symbol} ${r.sector ?? ''} | $${_f(r.price)} gap ${_f(r.gap_pct)}%${r.rvol != null ? ` rvol ${r.rvol}×` : ''}${r.pm_vol_pct != null ? ` pre-mkt vol ${_f(r.pm_vol_pct, 1)}% of a day` : ''} ATR ${_f(r.atr_pct)}% | ${cat}${r.fade_check ? ' | FLAG: minor story under a big gap' : ''}${r.next_earnings ? ` | earnings ${r.next_earnings}` : ''} | ${cells}`
    })
    return [...head, ...rows].join('\n')
}

/**
 * The model's reply, held to the board: a pick must be a row, on a column that row is GRADED on;
 * a repeat of the same name on the same column and anything past MAX_PICKS on a column are dropped;
 * text is trimmed and capped. Pure.
 */
export function normalizeRead(raw, board) {
    const bySym = new Map((board.rows ?? []).map(r => [r.symbol, r]))
    const txt = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, TEXT_CHARS) : null)
    const picks = [], seen = new Set(), perColumn = new Map()
    for (const p of Array.isArray(raw?.picks) ? raw.picks : []) {
        const symbol = String(p?.symbol ?? '').toUpperCase()
        const row = bySym.get(symbol)
        const key = `${symbol}|${p?.column}`
        if (!row || seen.has(key) || !row.cells?.[p.column]?.grade) continue
        if ((perColumn.get(p.column) ?? 0) >= MAX_PICKS) continue
        seen.add(key)
        perColumn.set(p.column, (perColumn.get(p.column) ?? 0) + 1)
        picks.push({ symbol, column: p.column, why: txt(p.why), caution: txt(p.caution) })
    }
    const picked = new Set(picks.map(p => p.symbol))
    const avoid = []
    for (const a of Array.isArray(raw?.avoid) ? raw.avoid : []) {
        const symbol = String(a?.symbol ?? '').toUpperCase()
        if (!bySym.has(symbol) || picked.has(symbol) || avoid.some(x => x.symbol === symbol)) continue
        avoid.push({ symbol, why: txt(a.why) })
        if (avoid.length >= MAX_AVOID) break
    }
    return { summary: txt(raw?.summary), picks, avoid }
}

async function _houseModel() {
    try { return (await getHouseModels()).chatModel || DEFAULT_MODEL } catch { return DEFAULT_MODEL }
}

/**
 * Argus's read of a built board. → `{ summary, picks, avoid, model }`, or null when there is
 * nothing to read or the call failed (the board then goes out without it).
 *
 * @param {object} board  the board as _build made it (rows, columns, regime, day, checkpoint)
 * @param {{ send?: Function, model?: () => Promise<string>, onUsage?: Function }} [deps]  test seams;
 *   `onUsage(usage, model)` books the call's spend
 */
export async function argusRead(board, { send = oneShotText, model = _houseModel, onUsage } = {}) {
    if (!board?.rows?.length) return null
    try {
        const m = await model()
        const text = await send({ model: m, systemText: SYSTEM, userText: boardText(board), maxTokens: 8000, onUsage: onUsage && (u => onUsage(u, m)) })
        const read = normalizeRead(extractFirstJSON(text), board)
        if (!read.summary && !read.picks.length) return null
        return { ...read, model: m }
    } catch (err) {
        logger.warn(LOG, `no read on ${board.id ?? board.checkpoint} — the board goes out without it: ${err.message}`)
        return null
    }
}
