/**
 * Parse a pasted book into holdings — pure, no I/O.
 *
 * Intake for an adopted book (docs/design/adopted-book.md §3) asks for ticker · quantity · avg cost.
 * Typing twenty lines into a chat box is where this feature dies, so the user pastes: a bank export,
 * a spreadsheet column, or three numbers typed by hand. **The model converses; it does not parse
 * numbers.** A language model asked to extract a cost basis will occasionally produce a plausible one,
 * and a plausible cost basis is indistinguishable from a real one afterwards — every weight, every R
 * multiple and every "is this working" answer downstream inherits it silently.
 *
 * So the numbers are read here, deterministically, and anything ambiguous is REPORTED rather than
 * guessed. Two channels, deliberately distinct:
 *   • `problems` — this row cannot be used. Blocking.
 *   • `warnings` — this row was read, but a choice was made the user should look at. Advisory: the
 *     confirm grid highlights it, nothing refuses.
 *
 * CELLS FIRST, THEN NUMBERS. The line is split into columns before any number is read, because the
 * two characters that group digits are also the two that separate columns:
 *   • a plain space groups in some locales AND delimits everywhere — "100 150.25"
 *   • a comma groups in en-US AND delimits in CSV — "100,150.25" is either 100150.25 or two numbers
 * Read character-by-character, both collapse into one wrong number, and a wrong cost basis is
 * unrecoverable. So a delimiter is chosen per line by whether it produces clean cells, and grouping is
 * only ever interpreted INSIDE a cell.
 *
 * Shared: Atlas's adopt mode, the confirm grid, and a future CSV import all read the same rows.
 */

import { toNum } from './format.util.js'

// Tokens that look like a ticker but are furniture: statement headers, units, currency codes, and the
// words people write between the numbers. Without this, "100 shares of AAPL at 150" parses `SHARES`.
const NOISE = new Set([
    'SYMBOL', 'TICKER', 'NAME', 'STOCK', 'SHARE', 'SHARES', 'QTY', 'QUANTITY', 'UNITS', 'AMOUNT',
    'AVG', 'AVERAGE', 'COST', 'BASIS', 'PRICE', 'PAID', 'BUY', 'BOUGHT', 'AT', 'OF', 'EACH',
    'VALUE', 'MARKET', 'TOTAL', 'POSITION', 'POSITIONS', 'HOLDING', 'HOLDINGS', 'PL', 'PNL', 'GAIN',
    'LOSS', 'WEIGHT', 'CURRENT', 'LAST', 'CLOSE', 'CHANGE', 'RETURN', 'DATE', 'ACCOUNT', 'CASH',
    'USD', 'EUR', 'GBP', 'ILS', 'NIS', 'CHF', 'JPY', 'CAD', 'AUD',
])

// Words that are never a holding on a line carrying NO NUMBERS — i.e. prose ("here's my book",
// "I have a portfolio at my bank"). Applied ONLY in that case, deliberately: `A` is Agilent and `I`
// was Intelsat, so filtering these globally would drop real one-letter holdings. A row with numbers
// is a row; a sentence without them is conversation.
const PROSE = new Set(['I', 'A', 'MY', 'ME', 'WE', 'IT', 'IS', 'TO', 'THE', 'AND', 'SO', 'DO', 'IN', 'ON', 'BE', 'HI'])

// A ticker: 1-5 letters, optionally a class/exchange suffix (BRK.B, RY.TO, ABC-B).
const TICKER = /^[A-Za-z]{1,5}(?:[.-][A-Za-z]{1,3})?$/

// The only grouping separator that survives INSIDE a cell is the comma (see _cells for why a
// comma is safe there and ambiguous as a delimiter).
const GROUPING = /,/g

// One whole cell as a number, with the decoration real statements carry: a currency symbol, grouped
// digits, a parenthesised negative, a trailing percent. Anchored — a cell is a number or it isn't.
const CELL_NUMBER = /^(\()?\s*([$€£₪¥])?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(%)?\s*(\))?$/

// Delimiters, most explicit first. The first one that yields clean cells wins (see _cells).
const DELIMITERS = [/\t+/, /\s*[;|]\s*/, /\s*,\s*/, /\s{2,}/, /\s+/]

// The Unicode spaces Excel and European locales group with (U+00A0 no-break, U+202F narrow
// no-break) are stripped BEFORE the line is split, and only where they genuinely group: between a
// digit and exactly three digits. They cannot be handled inside a cell the way the comma is,
// because JS `\s` MATCHES them — every delimiter above would already have split "1<nbsp>234.5"
// into two cells. A plain space is never touched: it is the column delimiter.
const UNICODE_GROUPING = new RegExp('(\\d)[\\u00A0\\u202F](?=\\d{3}(?!\\d))', 'g')

/**
 * One cell → a number and its decoration, or null when the cell isn't a number.
 * @returns {{value:number, isMoney:boolean, isPercent:boolean}|null}
 */
function _asNumber(cell) {
    const m = String(cell).trim().match(CELL_NUMBER)
    if (!m) return null
    const [, openParen, currency, digits, percent, closeParen] = m
    const n = toNum(digits.replace(GROUPING, ''))
    if (n == null) return null
    // (1,234) is how a statement writes a negative.
    const negated = openParen === '(' && closeParen === ')'
    return { value: negated ? -Math.abs(n) : n, isMoney: !!currency, isPercent: percent === '%' }
}

/** A cell is clean if it is wholly a number, or carries no digits at all (a label). */
const _isCleanCell = cell => _asNumber(cell) != null || !/\d/.test(cell)

/**
 * Split a line into columns. Tries delimiters in order and takes the first whose cells are ALL clean;
 * that is what tells a CSV comma from a thousands comma — "BRK.A 2 $471,250.50" split on commas leaves
 * `BRK.A 2 $471`, which is neither a number nor a label, so the comma is rejected as a delimiter and
 * the space is used instead.
 */
function _cells(line) {
    for (const d of DELIMITERS) {
        const fields = line.split(d).map(s => s.trim()).filter(Boolean)
        if (fields.length >= 2 && fields.every(_isCleanCell)) return fields
    }
    return line.split(/\s+/).map(s => s.trim()).filter(Boolean)
}

/** The ticker among these cells, or null. Prefers an ALL-CAPS cell — a statement writes tickers in
 *  caps, which is what separates AAPL from the company name beside it ("Apple Inc AAPL 100 150"). */
function _ticker(cells, { prose = false } = {}) {
    const candidates = cells
        .map(c => c.replace(/^[^A-Za-z]+|[^A-Za-z.-]+$/g, ''))
        .filter(c => TICKER.test(c) && !NOISE.has(c.toUpperCase()) && !(prose && PROSE.has(c.toUpperCase())))
    if (!candidates.length) return null
    return (candidates.find(c => c === c.toUpperCase()) ?? candidates[0]).toUpperCase()
}

/** A header row: labels, no numbers, and it names the columns. Skipped silently — not a mistake. */
function _isHeader(cells, line) {
    if (cells.some(c => _asNumber(c) != null)) return false
    return /symbol|ticker|qty|quantity|shares|cost|price|name|position|holding/i.test(line)
}

/**
 * Parse pasted text into holdings.
 *
 * COLUMN ORDER. `ticker quantity avgCost` is the stated shape and the conventional one, so the first
 * two usable numbers are read in that order — unless the line says otherwise:
 *   • an `@` marks the price ("AAPL 100 @ 150.25"), whichever side it falls on
 *   • a currency symbol marks the price when the other number has none ("AAPL $150.25 100")
 * A percent is never a quantity or a price — it is a weight or a return column, so it is ignored.
 * A row carrying MORE than two usable numbers (a full bank export: qty, cost, last, value, P&L) is
 * read as the first two and WARNED about, because that is right for every export layout I can check
 * and wrong quietly enough to deserve a highlight.
 *
 * A negative quantity is read as a short line, not as a typo: that is what the sign means on a
 * statement, and `normalizeHolding` carries `direction` through.
 *
 * @param {string} text
 * @returns {{ rows: Array<{symbol:string, quantity:number|null, avgCost:number|null, direction:'long'|'short', raw:string}>,
 *             problems: string[], warnings: string[] }}
 */
export function parseHoldings(text) {
    const rows = [], problems = [], warnings = []
    const lines = String(text ?? '').split(/\r?\n/)
        .map(l => l.trim().replace(UNICODE_GROUPING, '$1'))
        .filter(Boolean)

    if (!lines.length) return { rows, problems: ['no_rows'], warnings }

    lines.forEach((line, i) => {
        const cells = _cells(line)
        if (_isHeader(cells, line)) return

        // Each number with the CELL it came from, so the @ rule can ask which side of it they fall on.
        const nums = cells
            .map((c, idx) => ({ ...(_asNumber(c) ?? {}), cell: idx, ok: _asNumber(c) != null }))
            .filter(n => n.ok && !n.isPercent)

        const symbol = _ticker(cells, { prose: nums.length === 0 })
        if (!symbol) {
            // Numbers with no name is a real mistake worth naming. Neither is conversation.
            if (nums.length) problems.push(`missing_symbol:line ${i + 1}`)
            return
        }
        if (!nums.length) {
            // A bare ticker is an unfinished row and should be flagged; a SENTENCE that happens to
            // contain a ticker-shaped word is not, which is what the cell count separates.
            if (cells.length <= 2) problems.push(`missing_numbers:${symbol}`)
            return
        }
        if (nums.length === 1) {
            // One number cannot be split into size and price, and guessing which it is would be the
            // worst possible guess. The row still comes back for the grid to complete.
            rows.push({ symbol, quantity: null, avgCost: null, direction: 'long', raw: line })
            problems.push(`incomplete_row:${symbol}`)
            return
        }

        let [first, second] = nums
        const atCell = cells.findIndex(c => c.includes('@'))
        if (atCell >= 0) {
            const before = nums.find(n => n.cell <= atCell)
            const after  = nums.find(n => n.cell > atCell)
            if (before && after) { first = before; second = after }
        } else if (first.isMoney && !second.isMoney) {
            [first, second] = [second, first]   // "$150.25 100" — the money is the price
        }

        if (nums.length > 2) warnings.push(`assumed_columns:${symbol}`)

        rows.push({
            symbol,
            quantity:  Math.abs(first.value),
            avgCost:   second.value,
            direction: first.value < 0 ? 'short' : 'long',
            raw:       line,
        })
    })

    if (!rows.length && !problems.length) problems.push('no_rows')
    return { rows, problems, warnings }
}
