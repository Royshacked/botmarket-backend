import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCoverage, makeCoverageHandlers, COVERAGE_TOOL_SPEC } from '../../services/tools/coverage.tools.js'
import { TOOLS as AXL_TOOLS } from '../../services/agents/axl.agent.service.js'

// Axl reads the analyst's thesis on a name (Roy, 2026-11-20: a view question went to the analyst's desk, which asked to update).

const NVDA = {
    symbol: 'NVDA', industry: 'Semiconductors', status: 'active', rating: 'strong_buy', updated_at: '2026-11-20T19:11:47.443Z',
    thesis: 'Blackwell is sold out.', price_target: { value: 210, target_date: '2027-01-31', horizon: '12m' },
    gap: { pct: 12.3, consensus_pt: 187 }, conviction: { level: 'high', rationale: 'orders visible' },
    risk_reward: { bear: { price: 110 }, base: { price: 210 }, bull: { price: 260 } },
    catalysts: [{ date: '2027-02-25', note: 'Q4 print' }], kill_criteria: ['DC growth under 20% two quarters running'],
    revisions: [{ at: '2026-11-20T19:11:47.444Z', note: 'remodelled on the print' }],
}

test('a covered name: rating, target with its date, the case, what breaks it, dated and attributed', () => {
    const t = formatCoverage('NVDA', NVDA)
    assert.match(t, /ANALYST COVERAGE — NVDA \(Semiconductors\), last revised 2026-11-20/)
    assert.match(t, /rating: strong buy/)
    assert.match(t, /our price target: 210\.00 by 2027-01-31/)
    assert.match(t, /against the Street: \+12\.3% vs consensus 187\.00/)
    assert.match(t, /bear case: 110\.00/)
    assert.match(t, /DC growth under 20%/)
    assert.match(t, /say it as his, with the date/)
})

test('not covered, or retired: says so, and research is only an offer', () => {
    assert.match(formatCoverage('ZZZ', null), /NOT COVERED/)
    assert.match(formatCoverage('NVDA', { ...NVDA, status: 'retired' }), /NOT COVERED/)
})

test('the handler reads one symbol, uppercased; a bad symbol is refused', async () => {
    const asked = []
    const h = makeCoverageHandlers({ coverage: { getCoverageBySymbol: async (s) => { asked.push(s); return NVDA } } })
    assert.match(await h.get_coverage_view({ symbol: ' nvda ' }), /ANALYST COVERAGE — NVDA/)
    assert.deepEqual(asked, ['NVDA'])
    assert.match(await h.get_coverage_view({}), /symbol is required/)
})

test('Axl carries it, appended last; the description says a view is a read, updating is the desk', () => {
    assert.equal(AXL_TOOLS.at(-1).name, 'get_coverage_view')
    assert.match(COVERAGE_TOOL_SPEC.get_coverage_view, /answer from it, attributed and dated/)
    assert.match(COVERAGE_TOOL_SPEC.get_coverage_view, /Updating a thesis is the analyst's desk/)
})
