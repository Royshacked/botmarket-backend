// Argus grounding provenance — "names come from the tape, never from memory".
//
// A session-scoped ledger records which tickers a REAL, SUCCESSFUL tool engaged
// during a scan, so a candidate that no tool ever touched (a pure-memory
// fabrication) can be dropped before it reaches the UI or persistence. This is
// the code backing for the prompt's core doctrine (scanner_system_prompt.md L11),
// which until now was enforced by nothing. See the Argus audit — grounding slice 1.
//
// Two grounded sources, unioned:
//   • sourced   — the candidate's symbol appears in the formatted OUTPUT of a
//                 discovery tool (screen_candidates / market_movers / …). That
//                 output IS the tape. Tested by word-boundary presence in the
//                 accumulated discovery text (robust to each tool's text shape).
//   • validated — a per-name tool (get_candles, get_indicators, …) SUCCESSFULLY
//                 ran on the symbol. Proof a real tool saw it, even if the name
//                 originated from web_search or recall.
// A candidate in NEITHER set is `ungrounded` → the fabrication.

// Discovery tools whose formatted text output is "the tape".
export const DISCOVERY_TOOLS = new Set([
    'screen_candidates', 'get_market_movers', 'get_sector_snapshot',
    'get_analyst_actions', 'get_earnings_calendar',
])

// Per-name tools → how to read the ticker(s) they ran on from their input args.
// A successful call on the symbol confers `validated` grounding.
export const PER_NAME_TICKER_ARGS = {
    get_price_action:        a => [a?.ticker],
    get_risk_metrics:        a => [a?.ticker],
    get_candles:             a => [a?.ticker],
    get_indicators:          a => [a?.ticker],
    get_chart:               a => [a?.ticker],
    get_orderblocks:         a => [a?.ticker],
    get_false_breaks:        a => [a?.ticker],
    get_fundamentals:        a => [a?.ticker],
    get_earnings:            a => [a?.ticker],
    get_sec_filings:         a => [a?.ticker],
    get_cycle_analysis:      a => [a?.ticker],
    get_short_interest:      a => [a?.ticker],
    get_options_context:     a => [a?.ticker],
    get_derivatives_context: a => [a?.symbol],
    get_quotes:              a => a?.tickers,   // array
}

export function normTicker(t) {
    return typeof t === 'string' ? t.toUpperCase().trim() : ''
}

/** A fresh per-session ledger. */
export function makeGroundingLedger() {
    return { sourcedText: '', touched: new Set() }
}

/** Append a discovery tool's formatted output to the tape. */
export function recordSourced(ledger, text) {
    if (ledger && typeof text === 'string' && text) ledger.sourcedText += '\n' + text
}

/** Record the ticker(s) a per-name tool successfully ran on. */
export function recordTouched(ledger, tickers) {
    if (!ledger) return
    for (const t of (Array.isArray(tickers) ? tickers : [])) {
        const n = normTicker(t)
        if (n) ledger.touched.add(n)
    }
}

function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') }

// Word-boundary presence of a ticker in the accumulated discovery text. The
// boundary excludes adjacent alphanumerics AND dots so "AAP" doesn't match inside
// "AAPL" and "BRK" doesn't match inside "BRK.B". Case-sensitive: symbols render
// uppercase on the tape, so this avoids matching a 2-letter ticker against a
// lowercase English word (e.g. "IT", "ON").
function _inSourcedText(text, ticker) {
    if (!text || !ticker) return false
    const re = new RegExp(`(^|[^A-Z0-9.])${_escapeRe(ticker)}([^A-Z0-9.]|$)`)
    return re.test(text)
}

/**
 * Grounding tier for one candidate ticker against the ledger:
 *   'sourced'    — on the tape (a discovery output)
 *   'validated'  — a per-name tool successfully ran on it
 *   'ungrounded' — no successful tool ever engaged it (the fabrication)
 * Pure. A null ledger yields 'ungrounded' — callers gate enforcement on ledger
 * presence so a no-ledger path (tests, non-scan callers) never drops anything.
 */
export function groundingTier(ticker, ledger) {
    const t = normTicker(ticker)
    if (!t || !ledger) return 'ungrounded'
    if (_inSourcedText(ledger.sourcedText, t)) return 'sourced'
    if (ledger.touched.has(t)) return 'validated'
    return 'ungrounded'
}
