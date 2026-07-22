import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _formatCoverage } from '../../services/portfolio.agent.service.js'

// Atlas P4d — get_coverage read (Analyst→Atlas pull): render coverage for construction (pure).

test('formats each covered name with rating, our PT, the gap vs Street, status, thesis', () => {
    const out = _formatCoverage([
        { symbol: 'NVDA', rating: 'buy', price_target: { value: 200 }, gap: { our_pt: 200, consensus_pt: 180, pct: 11.1 }, status: 'active', thesis: 'AI data-center compounder' },
        { symbol: 'MSFT', rating: 'hold', price_target: { value: 420 }, gap: { our_pt: 420, consensus_pt: 428, pct: -1.9 }, status: 'active', thesis: 'fairly valued' },
    ])
    assert.match(out, /NVDA \[buy\] our PT 200 \(\+11\.1% vs Street 180\) · active — AI data-center compounder/)
    assert.match(out, /MSFT \[hold\] our PT 420 \(-1\.9% vs Street 428\)/)
})

test('empty coverage → a clear "nothing researched" read', () => {
    assert.match(_formatCoverage([]), /No Analyst coverage yet/)
    assert.match(_formatCoverage(null), /No Analyst coverage yet/)
})

test('missing fields degrade gracefully (no PT / no gap / no thesis / unrated)', () => {
    const out = _formatCoverage([{ symbol: 'ABC' }])
    assert.match(out, /- ABC \[unrated\] · active/)   // no PT block, no thesis, default status
    assert.doesNotMatch(out, /our PT/)
})

test('a long thesis is truncated', () => {
    const long = 'x'.repeat(300)
    const out = _formatCoverage([{ symbol: 'ABC', rating: 'buy', thesis: long }])
    assert.ok(out.includes('…'))
    assert.ok(out.length < 300 + 100)
})
