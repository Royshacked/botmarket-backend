import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    relativeReturnPct, contributionBp, gradeRow, totalContributionBp, maturedRows, reviewDecision,
    reviewAnchorMs, REVIEW_FLOOR_DAYS, COOLDOWN_DAYS,
} from '../../monitoring/tilt.assess.js'

// Pythia's grading + wake logic (pure). Attribution is arithmetic, not judgment — these pin the
// arithmetic and the abstains.

const DAY = 24 * 60 * 60 * 1000
const T0  = Date.parse('2026-01-01T00:00:00.000Z')
const at  = days => T0 + days * DAY

const row = (over = {}) => ({
    sector: 'Technology', stance: 'over', active_bp: 150,
    set_at: '2026-01-01T00:00:00.000Z', review_date: '2027-01-01T00:00:00.000Z',
    // The baseline is FROZEN on the row at authoring time — grading never looks up history.
    base_px: 100, base_bench_px: 100,
    state: 'open', contribution_bp: null, ...over,
})

// ── relative return ──────────────────────────────────────────────────────────
test('relative return is the sector MINUS the benchmark, in percent', () => {
    // Sector +10%, benchmark +4% → +6% relative.
    assert.equal(relativeReturnPct({ sectorStart: 100, sectorNow: 110, benchStart: 100, benchNow: 104 }), 6)
})

test('a tilt can WORK in a falling market — the whole reason it is relative', () => {
    // Sector -8%, benchmark -12%. An overweight was right.
    const rel = relativeReturnPct({ sectorStart: 100, sectorNow: 92, benchStart: 100, benchNow: 88 })
    assert.equal(rel, 4)
    assert.ok(contributionBp(150, rel) > 0, 'an overweight beat the index and must score positive')
})

test('relative return: an unpriceable leg is null, and a ZERO is absence not collapse', () => {
    const base = { sectorStart: 100, sectorNow: 110, benchStart: 100, benchNow: 104 }
    assert.equal(relativeReturnPct({ ...base, sectorNow: 0 }), null)
    assert.equal(relativeReturnPct({ ...base, benchStart: 0 }), null)
    assert.equal(relativeReturnPct({ ...base, sectorStart: null }), null)
    assert.equal(relativeReturnPct({ ...base, benchNow: undefined }), null)
    assert.equal(relativeReturnPct({ ...base, sectorNow: -5 }), null)
    assert.equal(relativeReturnPct(), null)
})

// ── contribution ─────────────────────────────────────────────────────────────
test('contribution = active weight x relative return', () => {
    assert.equal(contributionBp(150, 3), 4.5)      // +1.5% weight on +3% relative
    assert.equal(contributionBp(-150, 3), -4.5)    // underweight a sector that beat → it cost us
    assert.equal(contributionBp(-150, -3), 4.5)    // underweight a sector that lagged → it earned
    assert.equal(contributionBp(0, 10), 0)         // neutral earns nothing, and that IS zero
})

test('contribution is null — never 0 — when an input is unknown', () => {
    // "We don't know" and "it contributed nothing" are different facts, and only one of them may be
    // shown to someone judging the desk.
    assert.equal(contributionBp(150, null), null)
    assert.equal(contributionBp(null, 3), null)
    assert.equal(contributionBp(undefined, undefined), null)
})

// ── grading a row ────────────────────────────────────────────────────────────
const PRICES = { sectorNow: 110, benchNow: 104 }   // vs the row's frozen base of 100/100

test('gradeRow scores an open stance and leaves it open', () => {
    const g = gradeRow(row(), PRICES, at(30))
    assert.equal(g.contribution_bp, 9)      // 150bp x 6%
    assert.equal(g.state, 'open')
    assert.equal(g.sector, 'Technology', 'the rest of the row rides through untouched')
})

test('a stance MATURES when its own window closes', () => {
    assert.equal(gradeRow(row(), PRICES, at(400)).state, 'matured')
    assert.equal(gradeRow(row(), PRICES, at(364)).state, 'open')
})

test('maturity never reverses, and an unmeasurable window stays open', () => {
    assert.equal(gradeRow(row({ state: 'matured' }), PRICES, at(30)).state, 'matured')
    assert.equal(gradeRow(row({ set_at: null, review_date: null }), PRICES, at(30)).state, 'open')
    assert.equal(gradeRow(row(), PRICES, 0).state, 'open', 'no clock → no verdict')
})

test('a bad data day keeps the last known figure rather than nulling it', () => {
    // A sector we could not price today did not stop having earned what it earned yesterday.
    const g = gradeRow(row({ contribution_bp: 9 }), { sectorNow: 0, benchNow: 104 }, at(30))
    assert.equal(g.contribution_bp, 9)
})

test('gradeRow never mutates its input', () => {
    const r = row()
    gradeRow(r, PRICES, at(400))
    assert.equal(r.state, 'open')
    assert.equal(r.contribution_bp, null)
})

// ── aggregates ───────────────────────────────────────────────────────────────
test('total skips unpriced rows rather than counting them as zero', () => {
    assert.equal(totalContributionBp([{ contribution_bp: 9 }, { contribution_bp: -4.5 }]), 4.5)
    assert.equal(totalContributionBp([{ contribution_bp: 9 }, { contribution_bp: null }]), 9)
    assert.equal(totalContributionBp([{ contribution_bp: null }]), null, 'nothing known → null, not 0')
    assert.equal(totalContributionBp([]), null)
})

test('maturedRows finds exactly the stances the desk owes a verdict on', () => {
    const rows = [
        row({ sector: 'Technology' }),                                                  // 12m, open
        row({ sector: 'Energy', review_date: '2026-04-01T00:00:00.000Z' }),             // 3m, due
        row({ sector: 'Utilities', set_at: null, review_date: null }),                  // unmeasurable
    ]
    assert.deepEqual(maturedRows(rows, at(120)).map(r => r.sector), ['Energy'])
    assert.deepEqual(maturedRows(rows, at(10)).map(r => r.sector), [])
})

// ── the wake decision ────────────────────────────────────────────────────────
const doc = (over = {}) => ({
    status: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    tilts: [row()], ...over,
})

test('quiet inside the cooldown, whatever else is true', () => {
    const d = doc({ tilts: [row({ review_date: '2026-01-02T00:00:00.000Z' })] })   // already matured
    const v = reviewDecision(d, { nowMs: at(COOLDOWN_DAYS - 1), catalystDates: ['2026-01-02'] })
    assert.equal(v.due, false, 'the cooldown outranks every trigger')
})

test('a matured stance wakes the desk — a call nobody graded is the failure to avoid', () => {
    const d = doc({ tilts: [row({ sector: 'Energy', review_date: '2026-02-01T00:00:00.000Z' })] })
    const v = reviewDecision(d, { nowMs: at(40) })
    assert.equal(v.due, true)
    assert.match(v.reason, /stance matured: Energy/)
})

test('a dated macro catalyst wakes it the day AFTER it lands', () => {
    const v = reviewDecision(doc(), { nowMs: at(20), catalystDates: ['2026-01-19'] })
    assert.equal(v.due, true)
    assert.match(v.reason, /macro catalyst passed: 2026-01-19/)
    // ON the day itself is too early — the print is not in the data yet. (at(18) IS Jan 19.)
    assert.equal(reviewDecision(doc(), { nowMs: at(18), catalystDates: ['2026-01-19'] }).due, false)
    // ...and at(19) is Jan 20, the day after, which does fire.
    assert.equal(reviewDecision(doc(), { nowMs: at(19), catalystDates: ['2026-01-19'] }).due, true)
    // A catalyst that predates the last publish was already accounted for.
    assert.equal(reviewDecision(doc(), { nowMs: at(20), catalystDates: ['2025-12-01'] }).due, false)
})

test('the monthly floor is the backstop, and next_review_at is always offered', () => {
    const quiet = reviewDecision(doc(), { nowMs: at(10) })
    assert.equal(quiet.due, false)
    assert.equal(quiet.next_review_at, new Date(T0 + REVIEW_FLOOR_DAYS * DAY).toISOString())

    const v = reviewDecision(doc(), { nowMs: at(REVIEW_FLOOR_DAYS + 1) })
    assert.equal(v.due, true)
    assert.match(v.reason, /no review in \d+ days/)
})

test("today's sector move is deliberately NOT a trigger", () => {
    // A 3-12 month call is not re-authored because a week went against it — that is being early,
    // not being wrong. Nothing in the input surface can express a daily move, and that is the point.
    const v = reviewDecision(doc(), { nowMs: at(10) })
    assert.equal(v.due, false)
})

test('a retired view is never re-authored', () => {
    const d = doc({ status: 'retired', tilts: [row({ review_date: '2026-01-02T00:00:00.000Z' })] })
    assert.equal(reviewDecision(d, { nowMs: at(400) }).due, false)
})

// ── the anchor ───────────────────────────────────────────────────────────────
// What "when did the desk last look?" reads off. NOT `updated_at`: the monitor writes that itself on
// the maturity path, so a stance coming due used to restart the cooldown and mute its own trigger.
test('the review clock anchors on the last publish, not on any write', () => {
    const published = doc({
        updated_at: '2026-02-20T00:00:00.000Z',                          // a maturity write, days ago
        revisions: [
            { at: '2026-02-20T00:00:00.000Z', kind: 'stance_matured' },  // newest first
            { at: '2026-01-01T00:00:00.000Z', kind: 'publish' },
        ],
    })
    assert.equal(reviewAnchorMs(published), T0)
    // ...so the monthly floor still counts from the publish, and the view is overdue rather than
    // freshly reviewed.
    const v = reviewDecision(published, { nowMs: at(REVIEW_FLOOR_DAYS + 1) })
    assert.equal(v.due, true)
    assert.match(v.reason, /no review in/)
})

test('a re-author counts as the desk looking; bookkeeping kinds do not', () => {
    const kinds = k => doc({ revisions: [{ at: '2026-02-01T00:00:00.000Z', kind: k }, { at: '2026-01-01T00:00:00.000Z', kind: 'publish' }] })
    assert.equal(reviewAnchorMs(kinds('reauthor')), Date.parse('2026-02-01T00:00:00.000Z'))
    assert.equal(reviewAnchorMs(kinds('update')), T0, 'an edit is not a review')
    assert.equal(reviewAnchorMs(kinds('retire')), T0)
})

test('a doc with no trail falls back to created_at — the instant it was published', () => {
    assert.equal(reviewAnchorMs(doc({ revisions: [] })), T0)
    assert.equal(reviewAnchorMs(doc({ revisions: undefined })), T0)
    assert.equal(reviewAnchorMs({ created_at: null }), null)
    assert.equal(reviewAnchorMs(null), null)
})

test('a doc with no usable timestamps degrades quietly instead of firing every tick', () => {
    const v = reviewDecision({ status: 'active', tilts: [], created_at: null, updated_at: null }, { nowMs: at(10) })
    assert.equal(v.due, false)
    assert.equal(v.next_review_at, null)
})
