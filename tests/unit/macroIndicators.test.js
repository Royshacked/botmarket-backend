import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatMacroSnapshot } from '../../providers/fmp.provider.js'

// Where the macro snapshot's INDICATOR leg comes from, and the one property that broke.
//
// It used to come from FMP's /economic-indicators, which returns two or three rows ending
// 2025-12-01 — nine months stale on 2026-09-30, and not a fetch bug: the data is not there to
// take. Four desks read the block as current (Pythia, Prometheus, Atlas, the institutional trading
// tools) and Pythia names the REGIME off it, so published views quoted "unemployment 4.40%" as a
// fact about a labour market last seen in December. FRED serves the same measures to within a
// month, through the reader this repo already had behind get_priced_in.
//
// The fetch itself is I/O and lives in fred.provider; what is pinned here is the CONTRACT between
// the two — the snapshot's shape, and the labels that are now the only key the two providers share.

const LABELS = ['Real GDP', 'CPI', 'Inflation (YoY)', 'Unemployment', 'Fed funds rate', 'Consumer sentiment']

const parts = (over = {}) => ({
    treasury: [{ date: '2026-09-29', month3: 4.25, year2: 4.89, year10: 5.26, year30: 5.59 }],
    sectors: [],
    indicators: LABELS.map(label => ({ label, value: 1, date: '2026-08-01' })),
    ...over,
})

test('the snapshot renders every indicator WITH ITS DATE — staleness has to be visible', () => {
    // The desk can only distrust a number it can date. This block is the only place the reader
    // sees how old the labour market read is.
    const out = formatMacroSnapshot(parts())
    for (const label of LABELS) assert.match(out, new RegExp(`${label.replace(/[()]/g, '\\$&')}:`), label)
    assert.match(out, /as of 2026-08-01/)
})

test('the LABEL is the contract, because the two providers share nothing else', () => {
    // FRED's series ids (UNRATE, FEDFUNDS, CPIAUCSL) and FMP's indicator names (unemploymentRate,
    // federalFunds, CPI) have no overlap. getMacroRaw keys on the display label for that reason,
    // so a label renamed on one side silently nulls the other.
    const out = formatMacroSnapshot(parts({
        indicators: [{ label: 'Fed funds rate', value: 3.63, date: '2026-08-01' }],
    }))
    assert.match(out, /Fed funds rate: 3\.63/)
})

test('a missing indicator is ABSENT, never zero', () => {
    // A series FRED could not answer for is dropped by the fetcher rather than defaulted. "We do
    // not know" and "it printed nothing" are different facts about the economy.
    const out = formatMacroSnapshot(parts({ indicators: [] }))
    assert.doesNotMatch(out, /Unemployment/)
    assert.match(out, /Treasury curve/, 'the other legs still render')
})

test('the curve and the tape stay on their own provider, and still render alone', () => {
    // Only the indicator leg moved. FMP is current for both of these and FRED serves neither as
    // conveniently, so a partial outage on one side must not empty the block.
    const out = formatMacroSnapshot({ treasury: parts().treasury, sectors: [], indicators: [] })
    assert.match(out, /Treasury curve \(2026-09-29\)/)
    assert.match(out, /2s10s \+37bp/)
})
