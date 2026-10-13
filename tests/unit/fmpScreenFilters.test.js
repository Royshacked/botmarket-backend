import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeScreenFilters } from '../../providers/fmp.provider.js'

// The screener speaks FMP's sector names; a GICS name matched nothing and came back as an empty pond with no
// error (Argus live replay 2026-10-13). The shared sector map translates it before the query.

test('a GICS sector is sent in the screener\'s spelling', () => {
    assert.equal(normalizeScreenFilters({ sector: 'Information Technology' }).sector, 'Technology')
    assert.equal(normalizeScreenFilters({ sector: 'Materials' }).sector, 'Basic Materials')
    assert.equal(normalizeScreenFilters({ sector: 'Health Care' }).sector, 'Healthcare')
    assert.equal(normalizeScreenFilters({ sector: 'Financials' }).sector, 'Financial Services')
    assert.equal(normalizeScreenFilters({ sector: 'Consumer Discretionary' }).sector, 'Consumer Cyclical')
    assert.equal(normalizeScreenFilters({ sector: 'Consumer Staples' }).sector, 'Consumer Defensive')
})

test('the screener\'s own names, unknown names, other filters and industries pass unchanged', () => {
    const f = { sector: 'Technology', marketCapMoreThan: 2e9 }
    assert.equal(normalizeScreenFilters(f), f, 'nothing to translate: the same object')
    assert.equal(normalizeScreenFilters({ sector: 'Moon Mining' }).sector, 'Moon Mining')
    const g = normalizeScreenFilters({ sector: 'Information Technology', industry: 'Communications Equipment', limit: 5 })
    assert.deepEqual(g, { sector: 'Technology', industry: 'Communications Equipment', limit: 5 })
    assert.deepEqual(normalizeScreenFilters(null), {})
    assert.deepEqual(normalizeScreenFilters({ sector: '' }), { sector: '' })
})
