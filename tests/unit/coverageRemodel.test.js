import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyEdge, parseCatalystDates, remodelDecision, COOLDOWN_DAYS, FLOOR_DAYS } from '../../monitoring/coverage.remodel.js'

// Analyst P5 step 3 — when a thesis has earned an expensive re-model. Pure → exhaustively testable.

const DAY = 24 * 60 * 60 * 1000
const iso = ms => new Date(ms).toISOString()
const T0  = Date.parse('2026-01-01T00:00:00.000Z')

const cov = (over = {}) => ({
    symbol: 'NVDA',
    price_target: { value: 200 },
    risk_reward: { bear: { value: 170 }, base: { value: 200 }, bull: { value: 230 } },
    catalysts: [],
    created_at: iso(T0),
    monitor: {},
    ...over,
})
const street = (over = {}) => ({ consensus: 190, low: 150, high: 240, median: 185, ...over })

// ── classifyEdge ─────────────────────────────────────────────────────────────
test('classifyEdge: our base inside the Street range is CONTAINED, not an edge', () => {
    // The real shape of every thesis in the book: 200 sits between 150 and 240, so an analyst is
    // already where we are — whatever the percentage gap to the mean says.
    assert.equal(classifyEdge(cov(), street()), 'contained')
})

test('classifyEdge: base above their high is variant; the whole band above is contrarian', () => {
    assert.equal(classifyEdge(cov({ price_target: { value: 260 } }), street()), 'variant_bull')
    const allAbove = cov({ price_target: { value: 300 }, risk_reward: { bear: { value: 250 }, bull: { value: 350 } } })
    assert.equal(classifyEdge(allAbove, street()), 'contrarian_bull')
})

test('classifyEdge: the bearish mirror', () => {
    assert.equal(classifyEdge(cov({ price_target: { value: 120 } }), street()), 'variant_bear')
    const allBelow = cov({ price_target: { value: 100 }, risk_reward: { bear: { value: 80 }, bull: { value: 140 } } })
    assert.equal(classifyEdge(allBelow, street()), 'contrarian_bear')
})

test('classifyEdge: unknown either side → null, never a guess', () => {
    assert.equal(classifyEdge(cov(), { consensus: 190 }), null)          // no range
    assert.equal(classifyEdge(cov(), null), null)
    assert.equal(classifyEdge({ price_target: {} }, street()), null)     // no PT of our own
})

test('classifyEdge: a legacy bare-number band still classifies', () => {
    const legacy = cov({ price_target: { value: 300 }, risk_reward: { bear: 250, base: 300, bull: 350 } })
    assert.equal(classifyEdge(legacy, street()), 'contrarian_bull')
})

// ── parseCatalystDates ───────────────────────────────────────────────────────
test('parseCatalystDates: STRICT YYYY-MM-DD only — fuzzy entries are prose, not schedule', () => {
    // Straight from a real TSM doc: a precise date alongside three a scheduler cannot use.
    const dates = parseCatalystDates([
        { date: '2026-10-15', note: 'Q3 earnings' },
        { date: '2027-Q1', note: 'Arizona ramp' },
        { date: '2027-H1', note: 'A14 pre-production' },
        { date: '2026-ongoing', note: 'monthly revenue' },
    ])
    assert.deepEqual(dates, ['2026-10-15'])
})

test('parseCatalystDates: sorted, de-duped, and tolerant of junk', () => {
    assert.deepEqual(parseCatalystDates([{ date: '2026-10-15' }, '2026-03-02', { date: '2026-10-15' }]),
        ['2026-03-02', '2026-10-15'])
    assert.deepEqual(parseCatalystDates([null, 42, {}, { date: '' }, { date: '2026-13-45' }, 'nonsense']), [])
    assert.deepEqual(parseCatalystDates(null), [])
})

// ── remodelDecision ──────────────────────────────────────────────────────────
// Past the cooldown for the cases that are ABOUT a trigger rather than about the cooldown.
const SETTLED = T0 + (COOLDOWN_DAYS + 6) * DAY

test('a quiet name is not due — and reports where it sits + when it is next scheduled', () => {
    const d = remodelDecision(cov({ catalysts: [{ date: '2026-06-01' }] }), { street: street(), nowMs: SETTLED })
    assert.equal(d.due, false)
    assert.equal(d.edge_category, 'contained')
    assert.equal(d.next_remodel_at, '2026-06-02T00:00:00.000Z')   // the day AFTER the print
})

test('a freshly-initiated thesis is inside its cooldown — initiation WAS the research run', () => {
    const justCovered = cov({ monitor: { edge_category: 'variant_bull' } })   // edge flipped on day 5
    assert.equal(remodelDecision(justCovered, { street: street(), nowMs: T0 + 5 * DAY }).due, false)
})

test('a dated catalyst that has landed is due', () => {
    const c = cov({ catalysts: [{ date: '2026-03-01', note: 'Q4 print' }] })
    const before = remodelDecision(c, { street: street(), nowMs: Date.parse('2026-03-01T12:00:00Z') })
    assert.equal(before.due, false, 'same day — the print is not in the data yet')
    const after = remodelDecision(c, { street: street(), nowMs: Date.parse('2026-03-02T12:00:00Z') })
    assert.equal(after.due, true)
    assert.match(after.reason, /catalyst passed: 2026-03-01/)
})

test('a catalyst already consumed by a prior re-model does not re-fire', () => {
    const c = cov({
        catalysts: [{ date: '2026-03-01' }],
        monitor: { last_remodel_at: iso(Date.parse('2026-03-05T00:00:00Z')) },
    })
    // Far enough out that the cooldown is not what is holding it back.
    const d = remodelDecision(c, { street: street(), nowMs: Date.parse('2026-04-20T00:00:00Z') })
    assert.equal(d.due, false)
})

test('the edge changing category is due — the shape of the variant view moved', () => {
    const c = cov({ monitor: { edge_category: 'variant_bull' } })
    const d = remodelDecision(c, { street: street(), nowMs: SETTLED })
    assert.equal(d.due, true)
    assert.equal(d.reason, 'edge variant_bull → contained')
})

test('an unchanged edge category is not due', () => {
    const c = cov({ monitor: { edge_category: 'contained' } })
    assert.equal(remodelDecision(c, { street: street(), nowMs: SETTLED }).due, false)
})

test('a FIRST-seen category is not a change — nothing to compare against', () => {
    const d = remodelDecision(cov({ monitor: {} }), { street: street(), nowMs: SETTLED })
    assert.equal(d.due, false)
    assert.equal(d.edge_category, 'contained')   // ...but it IS recorded, so the next tick can compare
})

test('the quarterly floor fires when nothing else has', () => {
    const d = remodelDecision(cov(), { street: street(), nowMs: T0 + (FLOOR_DAYS + 1) * DAY })
    assert.equal(d.due, true)
    assert.match(d.reason, /no re-model in 9[01] days/)
})

test('the cooldown outranks every trigger', () => {
    const c = cov({
        catalysts: [{ date: '2026-03-01' }],
        monitor: { edge_category: 'variant_bull', last_remodel_at: iso(Date.parse('2026-03-03T00:00:00Z')) },
    })
    // Catalyst landed AND the edge flipped — but we modelled this name two days ago.
    const inside = remodelDecision(c, { street: street(), nowMs: Date.parse('2026-03-05T00:00:00Z') })
    assert.equal(inside.due, false)
    // Past the cooldown, the same state is due.
    const outside = remodelDecision(c, { street: street(), nowMs: Date.parse('2026-03-03T00:00:00Z') + (COOLDOWN_DAYS + 1) * DAY })
    assert.equal(outside.due, true)
})

test('an undated thesis with no history never crashes and never fires', () => {
    const d = remodelDecision({ symbol: 'X' }, { street: null, nowMs: T0 })
    assert.deepEqual(d, { due: false, reason: null, edge_category: null, next_remodel_at: null })
})
