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

// An ABSENT key and a key carrying an explicit `null` are the same fact — "the Street range is
// unknown" — and the consensus feed reports the second one. They were NOT the same to the local
// numeric coercion this module used to carry: `Number(null)` is 0 and 0 is finite, so a null bound
// became a REAL ZERO that survived the `=== null` guard and classified.
//
// It never threw and never logged. A null `low` alone silently answered `contained` — the one
// verdict that means "no edge here" — and a null on BOTH bounds answered `variant_bull`, the
// strongest edge in the enum, off a Street range that was never read. Both are worse than the
// throw would have been, because a re-model schedule is decided from this string.
test('classifyEdge: an explicitly null Street bound is UNKNOWN, not a zero', () => {
    assert.equal(classifyEdge(cov(), street({ low: null })), null)
    assert.equal(classifyEdge(cov(), street({ high: null })), null)
    assert.equal(classifyEdge(cov(), street({ low: null, high: null })), null)
    assert.equal(classifyEdge(cov(), street({ low: '', high: '' })), null)   // empty string coerces to 0 too
})

// The mirror on OUR side of the comparison: a band leg present but unpriced. `bull: null` used to
// read as a bull case of 0, which is below every Street low — so an ordinary contained thesis was
// reported as `contrarian_bear`, a conviction we never held.
test('classifyEdge: an unpriced band leg does not fabricate a contrarian read', () => {
    const noBull = cov({ risk_reward: { bear: { value: 170 }, base: { value: 200 }, bull: { value: null } } })
    assert.equal(classifyEdge(noBull, street()), 'contained')

    const noBear = cov({ price_target: { value: 300 }, risk_reward: { bear: { value: null }, bull: { value: 350 } } })
    assert.equal(classifyEdge(noBear, street()), 'variant_bull')   // not contrarian_bull — the bear leg is unknown

    const legacyNull = cov({ risk_reward: { bear: null, base: null, bull: null } })
    assert.equal(classifyEdge(legacyNull, street()), 'contained')
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
    assert.deepEqual(d, {
        due: false, reason: null, edge_category: null,
        next_remodel_at: null, next_remodel_reason: null,
    })
})

// ── next_remodel_reason ──────────────────────────────────────────────────────
// The LABEL on the scheduled date, so a reader sees what the wait is FOR. Distinct from `reason`,
// which says why a re-model is due NOW and is null on every quiet tick.

test('a catalyst names itself — the note is the label', () => {
    const c = cov({ catalysts: [{ date: '2026-06-01', note: 'Q3 earnings' }] })
    const d = remodelDecision(c, { street: street(), nowMs: SETTLED })
    assert.equal(d.next_remodel_at, '2026-06-02T00:00:00.000Z')
    assert.equal(d.next_remodel_reason, 'Q3 earnings')
    assert.equal(d.reason, null, 'quiet tick — nothing is due')
})

test('a catalyst with no note still labels itself as one', () => {
    const withoutNote = remodelDecision(cov({ catalysts: [{ date: '2026-06-01' }] }), { street: street(), nowMs: SETTLED })
    assert.equal(withoutNote.next_remodel_reason, 'catalyst')
    // A bare date STRING is a legal catalyst too, and carries no note by construction.
    const bare = remodelDecision(cov({ catalysts: ['2026-06-01'] }), { street: street(), nowMs: SETTLED })
    assert.equal(bare.next_remodel_reason, 'catalyst')
})

test('the label follows the NEXT catalyst, not the first one written', () => {
    // Order in the array is the analyst's; order in time is ours. A passed catalyst must not label
    // a date that a later one produced.
    const c = cov({ catalysts: [
        { date: '2026-09-01', note: 'analyst day' },
        { date: '2026-06-01', note: 'Q3 earnings' },
    ] })
    const d = remodelDecision(c, { street: street(), nowMs: SETTLED })
    assert.equal(d.next_remodel_reason, 'Q3 earnings')
    // Past June, the schedule and its label both move on.
    const later = remodelDecision(c, { street: street(), nowMs: Date.parse('2026-07-01T00:00:00Z') })
    assert.equal(later.next_remodel_at, '2026-09-02T00:00:00.000Z')
    assert.equal(later.next_remodel_reason, 'analyst day')
})

test('a FUZZY catalyst is not a schedule, so it cannot be a label either', () => {
    // "2027-H1" is prose for the analyst to read; parseCatalystDates drops it, and the schedule
    // falls back to the quarterly floor — which must say so rather than borrow the note.
    const c = cov({ catalysts: [{ date: '2027-H1', note: 'the re-rating' }] })
    const d = remodelDecision(c, { street: street(), nowMs: SETTLED })
    assert.equal(d.next_remodel_reason, 'quarterly floor')
    assert.equal(d.next_remodel_at, iso(T0 + FLOOR_DAYS * DAY))
})

test('no catalyst ahead → the quarterly floor, named', () => {
    const d = remodelDecision(cov(), { street: street(), nowMs: SETTLED })
    assert.equal(d.next_remodel_reason, 'quarterly floor')
})

test('a runaway note is capped — this is a label, not a paragraph', () => {
    const long = 'earnings plus the guidance revision and the segment disclosure everyone has been waiting for'
    const d = remodelDecision(cov({ catalysts: [{ date: '2026-06-01', note: long }] }), { street: street(), nowMs: SETTLED })
    assert.ok(d.next_remodel_reason.length <= 60, `too long: ${d.next_remodel_reason.length}`)
    assert.ok(d.next_remodel_reason.endsWith('…'))
})

test('a blank or non-string note falls back rather than labelling with whitespace', () => {
    for (const note of ['   ', '', null, 42, { text: 'x' }]) {
        const d = remodelDecision(cov({ catalysts: [{ date: '2026-06-01', note }] }), { street: street(), nowMs: SETTLED })
        assert.equal(d.next_remodel_reason, 'catalyst')
    }
})

test('the label is reported on a DUE tick too — the next date is already scheduled', () => {
    // Due-ness returns `{...quiet}`, so the schedule and its label ride along. A UI reading the doc
    // mid-re-model still has something coherent to show.
    const c = cov({ monitor: { edge_category: 'variant_bull' }, catalysts: [{ date: '2026-06-01', note: 'Q3 earnings' }] })
    const d = remodelDecision(c, { street: street(), nowMs: SETTLED })
    assert.equal(d.due, true)
    assert.equal(d.next_remodel_reason, 'Q3 earnings')
})
