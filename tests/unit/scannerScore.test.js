import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _normalizeArgusPick } from '../../services/agents/scanner.agent.service.js'

// The list scoring and ranking tests (_cleanScore / _normalizeScan) went to archive/tests/scannerScore.test.js on
// 2026-11-09 with Argus's lists. The single pick is what is left of his output.

// ── _normalizeArgusPick (hand-off single pick) ─────────────────────────
test('argusPick: clean pick uppercases ticker, keeps direction + text, drops a lens', () => {
    const p = _normalizeArgusPick({ ticker: 'nvda', direction: 'long', thesis: 't', analysis: 'a', recommended_mode: 'smc' })
    assert.deepEqual(p, { ticker: 'NVDA', direction: 'long', thesis: 't', analysis: 'a' })
})

test('argusPick: direction defaults long; missing text → empty', () => {
    assert.deepEqual(_normalizeArgusPick({ ticker: 'AAPL' }), { ticker: 'AAPL', direction: 'long', thesis: '', analysis: '' })
    assert.equal(_normalizeArgusPick({ ticker: 'TSLA', direction: 'short' }).direction, 'short')
})

test('argusPick: no/empty ticker → null', () => {
    assert.equal(_normalizeArgusPick(null), null)
    assert.equal(_normalizeArgusPick({}), null)
    assert.equal(_normalizeArgusPick({ ticker: '   ' }), null)
})
