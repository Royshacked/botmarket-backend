import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHoldings } from '../../services/holdingsParse.util.js'

// The paste is how an adopted book actually arrives (docs/design/adopted-book.md §3). These are the
// shapes real statements and real people produce. The rule under all of it: read what is unambiguous,
// REPORT what isn't, never guess a cost basis — a plausible one is indistinguishable from a real one
// afterwards, and every weight and R multiple downstream inherits it.

test('the stated shape: ticker, quantity, avg cost', () => {
    const { rows, problems } = parseHoldings('AAPL 100 150.25\nMSFT 50 300')
    assert.deepEqual(problems, [])
    assert.deepEqual(rows.map(r => [r.symbol, r.quantity, r.avgCost]), [['AAPL', 100, 150.25], ['MSFT', 50, 300]])
})

test('separators people and spreadsheets use', () => {
    const csv = parseHoldings('AAPL,100,150.25')
    assert.deepEqual([csv.rows[0].quantity, csv.rows[0].avgCost], [100, 150.25])
    const tab = parseHoldings('AAPL\t100\t150.25')
    assert.deepEqual([tab.rows[0].quantity, tab.rows[0].avgCost], [100, 150.25])
})

test('thousands separators and currency symbols survive', () => {
    // A PLAIN space is never a grouping separator — it is the column delimiter. Only comma and the
    // Unicode spaces Excel emits group, which is why the second line uses U+00A0 explicitly.
    const { rows } = parseHoldings(`BRK.A 2 $471,250.50\nNESN 10 ₪1\u00A0234.5`)
    assert.equal(rows[0].symbol, 'BRK.A', 'a class suffix is part of the ticker')
    assert.equal(rows[0].avgCost, 471250.5)
    // Written as an ESCAPE, not a literal: the whole point is which space character this is, and a
    // literal one in a source file is indistinguishable from the plain space that must NOT group.
    const euro = parseHoldings(`NESN 10 ₪1\u00A0234.5`).rows[0]
    assert.equal(euro.avgCost, 1234.5, 'U+00A0 groups — it is what Excel emits')
    const plain = parseHoldings('NESN 10 1 234.5').rows[0]
    assert.equal(plain.avgCost, 1, 'a PLAIN space delimits, so this line has three columns, not two')
})

test('a plain space between columns never merges two numbers', () => {
    // The bug this file exists to prevent: "100 150.25" read as 100150.25, turning every two-column
    // paste into an incomplete row.
    const r = parseHoldings('AAPL 100 150.25').rows[0]
    assert.equal(r.quantity, 100)
    assert.equal(r.avgCost, 150.25)
})

test('an @ names the price, whichever side it falls on', () => {
    assert.deepEqual(
        (() => { const r = parseHoldings('AAPL 100 @ 150.25').rows[0]; return [r.quantity, r.avgCost] })(),
        [100, 150.25])
    // Quantity after the price still reads correctly, because the @ decides.
    const r = parseHoldings('AAPL 150.25 @ 100').rows[0]
    assert.equal(r.avgCost, 100)
    assert.equal(r.quantity, 150.25)
})

test('a currency symbol marks the price when the other number has none', () => {
    const r = parseHoldings('AAPL $150.25 100').rows[0]
    assert.equal(r.quantity, 100, 'the money is the price, so the bare number is the size')
    assert.equal(r.avgCost, 150.25)
})

test('a header row is skipped silently — it is not the user\'s mistake', () => {
    const { rows, problems } = parseHoldings('Symbol\tQty\tAvg Cost\nAAPL\t100\t150.25')
    assert.deepEqual(problems, [])
    assert.equal(rows.length, 1)
})

test('a company name next to the ticker does not become the ticker', () => {
    // A statement writes the ticker in caps; the name is what sits beside it.
    assert.equal(parseHoldings('Apple Inc AAPL 100 150.25').rows[0].symbol, 'AAPL')
})

test('the words between the numbers are not tickers', () => {
    const r = parseHoldings('100 shares of AAPL at 150.25').rows[0]
    assert.equal(r.symbol, 'AAPL')
    assert.equal(r.quantity, 100)
    assert.equal(r.avgCost, 150.25)
})

test('a full bank export reads the first two columns and WARNS', () => {
    // Symbol, qty, avg cost, last, market value, P&L — right for every export layout I can check, and
    // wrong quietly enough to deserve a highlight rather than silence.
    const { rows, warnings, problems } = parseHoldings('AAPL 100 150.25 200.00 20,000.00 4,975.00')
    assert.deepEqual(problems, [])
    assert.deepEqual([rows[0].quantity, rows[0].avgCost], [100, 150.25])
    assert.deepEqual(warnings, ['assumed_columns:AAPL'])
})

test('a percent column is never read as a size or a price', () => {
    const { rows } = parseHoldings('AAPL 12.5% 100 150.25')
    assert.deepEqual([rows[0].quantity, rows[0].avgCost], [100, 150.25])
})

test('a parenthesised negative is a negative', () => {
    // How statements write a loss; it must not become a positive price.
    const { rows } = parseHoldings('AAPL 100 150.25 (1,250.00)')
    assert.deepEqual([rows[0].quantity, rows[0].avgCost], [100, 150.25])
})

test('a negative quantity is a short line, not a typo', () => {
    const r = parseHoldings('TSLA -50 210.40').rows[0]
    assert.equal(r.direction, 'short')
    assert.equal(r.quantity, 50, 'size is carried positive; the sign became the direction')
})

test('one number cannot be split into a size and a price', () => {
    const { rows, problems } = parseHoldings('AAPL 100')
    assert.deepEqual(problems, ['incomplete_row:AAPL'])
    // The row still comes back so the grid can show it with the missing cell to fill.
    assert.equal(rows[0].symbol, 'AAPL')
    assert.equal(rows[0].avgCost, null)
})

test('numbers with no name are named as a problem, prose is not', () => {
    const { problems } = parseHoldings("here's my book:\n100 150.25\nAAPL 100 150.25")
    assert.deepEqual(problems, ['missing_symbol:line 2'])
})

test('a name with no numbers is a problem against that name', () => {
    const { problems } = parseHoldings('AAPL\nMSFT 50 300')
    assert.deepEqual(problems, ['missing_numbers:AAPL'])
})

test('empty input is no rows, not a crash', () => {
    assert.deepEqual(parseHoldings('').problems, ['no_rows'])
    assert.deepEqual(parseHoldings(null).problems, ['no_rows'])
    assert.deepEqual(parseHoldings('   \n  \n').problems, ['no_rows'])
})

test('prose alone yields no rows rather than a fabricated one', () => {
    assert.deepEqual(parseHoldings('I have a portfolio at my bank').problems, ['no_rows'])
})

test('a realistic multi-line paste, blank lines and all', () => {
    const { rows, problems, warnings } = parseHoldings([
        'Symbol   Quantity   Avg Cost   Market Value',
        'AAPL     100        150.25     20,000.00',
        '',
        'MSFT     50         $300.00    20,000.00',
        'BRK.B    12         410.10     4,900.00',
    ].join('\n'))
    assert.deepEqual(problems, [])
    assert.deepEqual(rows.map(r => r.symbol), ['AAPL', 'MSFT', 'BRK.B'])
    assert.deepEqual(rows.map(r => r.quantity), [100, 50, 12])
    assert.deepEqual(rows.map(r => r.avgCost), [150.25, 300, 410.10])
    assert.equal(warnings.length, 3, 'every row carried an extra column — all three flagged for review')
})
