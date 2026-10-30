// The Argus hand-off seed — ONE parser for every desk a scanned name can be handed to.
//
// A hand-off arrives as a typed object rather than free text: Argus validated the name, wrote a
// one-line thesis and a short read, and recommended the lens to build it through. Three desks now
// receive that: Kairos (`call`), Analyst (`coverage`) and Mentor (`setup`).
//
// It was two hand-written copies before this — Kairos's, and Analyst's carrying the comment
// "Mirrors Kairos's _sanitizeSeed", which is the shape duplication takes just before it drifts. They
// had ALREADY diverged in what they carried (a forward-dated window on one, a sector on the other),
// and a third copy for Mentor would have made the divergence permanent.
//
// SHARE THE PIPE, NOT THE JUDGMENT. This coerces every field a hand-off can carry and each desk
// decides what to DO with it — which is not a formality here: `recommended_mode` is deliberately
// dropped from Kairos's prompt (its lens is chosen by the caller, and the field only pre-fills a UI
// chip) and is load-bearing for Mentor, which AUTHORS `trade_mode` and must put the recommendation
// in front of the user. Same field, opposite handling, one parser.
//
// String-only and lean on purpose: this is untrusted request-body input on the way into a prompt.

import { isMode } from './analysisModes.js'

/**
 * Coerce a hand-off seed. Returns null when there is no usable ticker — a seed without one names
 * nothing and is worse than absent, because a desk would open on a blank.
 *
 * Every field is optional except the ticker. A desk reads the ones it has a use for and ignores
 * the rest; nothing here decides anything.
 *
 * @param {unknown} raw
 * @returns {{ticker, direction, sector, thesis, analysis, recommended_mode, window}|null}
 */
export function sanitizeScanSeed(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const s = k => (typeof raw[k] === 'string' && raw[k].trim() ? raw[k].trim() : null)
    const ticker = s('ticker')
    if (!ticker) return null

    // A forward-dated list's period. It rides along so a desk can NARRATE the gated window; the
    // actual time-gate is set by code at save, never from this.
    const w    = (raw.window && typeof raw.window === 'object' && !Array.isArray(raw.window)) ? raw.window : {}
    const from = (typeof w.from === 'string' && w.from.trim()) ? w.from.trim() : null
    const to   = (typeof w.to   === 'string' && w.to.trim())   ? w.to.trim()   : null

    return {
        ticker:           ticker.toUpperCase(),
        direction:        s('direction'),
        sector:           s('sector'),
        thesis:           s('thesis'),
        analysis:         s('analysis'),
        // A lens the desks know, or nothing — a free string here would reach the prompt as a lens nobody has.
        recommended_mode: isMode(s('recommended_mode')) ? s('recommended_mode') : null,
        window:           (from || to) ? { from, to } : null,
        hotlist:          _hotlistRef(raw.hotlist, ticker.toUpperCase()),
        book:             _bookRef(raw.book, ticker.toUpperCase()),
    }
}

const HOTLIST_BOARD_ID = /^hb_\d{4}-\d{2}-\d{2}_[a-z]+$/
const HOTLIST_COLUMNS  = new Set(['open', 'mid', 'eod', 'tomorrow', 'week'])

/**
 * A hotlist hand-off is a REFERENCE — which board, which column — never the board's facts: those are
 * read back from the board by the server (hotlist.service hotlistSeed), the way the house label is
 * worked out from the ticker rather than taken off a request. Null unless both parts are well-formed.
 */
function _hotlistRef(raw, ticker) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const board  = typeof raw.board === 'string' ? raw.board.trim() : ''
    const column = typeof raw.column === 'string' ? raw.column.trim() : ''
    if (!HOTLIST_BOARD_ID.test(board) || !HOTLIST_COLUMNS.has(column)) return null
    return { board, column, symbol: ticker }
}

const BOOK_COLUMNS = new Set(['swing', 'long_term'])

/**
 * A hand-off off the Hotlist's SWING / LONG TERM lists (the house's coverage, houseBook.service) is a reference too —
 * which list — and the name's coverage is read back by the server (houseBook bookSeed): its horizon comes from the
 * stored price target, never from the request. Null unless the list is one of the two.
 */
function _bookRef(raw, ticker) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const column = typeof raw.column === 'string' ? raw.column.trim() : ''
    return BOOK_COLUMNS.has(column) ? { column, symbol: ticker } : null
}
