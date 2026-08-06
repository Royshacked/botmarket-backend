import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    normalizeTilt, stanceCoherence, incoherentRows,
    STANCES, TILT_BASES, TILT_STATUSES, BALANCE_TOLERANCE_BP,
} from '../../api/strategy/tilt.service.js'

// Pythia's `tilt` schema normalizer (pure). The CRUD is DB-bound and not unit-tested, mirroring
// normalizeCoverage vs the coverage CRUD.

const row = (over = {}) => ({ sector: 'Technology', stance: 'over', active_bp: 150, basis: 'bottom_up', ...over })
const NOW = '2026-08-06T00:00:00.000Z'

// ── identity + defaults ──────────────────────────────────────────────────────
test('normalize: defaults benchmark + status, stamps id and timestamps, and carries NO userId', () => {
    const t = normalizeTilt({ tilts: [row()] }, NOW)
    assert.equal(t.benchmark, 'SPX')
    assert.equal(t.status, 'active')
    assert.match(t.id, /^tilt_SPX_[0-9a-f]{8}$/)
    assert.equal(t.created_at, NOW)
    // A house view is a BROADCAST — joining it to a user's book is the trap this guards.
    assert.ok(!('userId' in t), 'a tilt must never carry an owner')
})

test('normalize: non-object raw never throws', () => {
    const t = normalizeTilt(null, NOW)
    assert.deepEqual(t.tilts, [])
    assert.equal(t.status, 'active')
    assert.equal(t.regime, null)
})

// ── rows: the sector is the join key ─────────────────────────────────────────
test('normalize: sector is canonicalised, so a GICS spelling still joins', () => {
    const t = normalizeTilt({ tilts: [row({ sector: 'Financials' }), row({ sector: 'Health Care', active_bp: -150, stance: 'under' })] }, NOW)
    assert.deepEqual(t.tilts.map(r => r.sector), ['Financial Services', 'Healthcare'])
})

test('normalize: a row with no usable sector is DROPPED — it cannot be joined or graded', () => {
    const t = normalizeTilt({ tilts: [row(), row({ sector: 'Semiconductors' }), row({ sector: null }), 'nonsense'] }, NOW)
    assert.equal(t.tilts.length, 1)
    assert.equal(t.tilts[0].sector, 'Technology')
})

test('normalize: one row per sector — a duplicate never quietly overrides the first', () => {
    const t = normalizeTilt({ tilts: [
        row({ active_bp: 150 }),
        row({ sector: 'Information Technology', active_bp: -300, stance: 'under' }),   // same sector, other spelling
    ] }, NOW)
    assert.equal(t.tilts.length, 1)
    assert.equal(t.tilts[0].active_bp, 150, 'first wins')
})

test('normalize: unknown stance / basis / state null out rather than defaulting to a view', () => {
    const t = normalizeTilt({ tilts: [row({ stance: 'buy', basis: 'vibes', state: 'weird' })] }, NOW)
    assert.equal(t.tilts[0].stance, null)
    assert.equal(t.tilts[0].basis, null)
    assert.equal(t.tilts[0].state, 'open')      // state has a safe default; a view does not
    for (const s of STANCES) assert.equal(normalizeTilt({ tilts: [row({ stance: s, active_bp: 0 })] }, NOW).tilts[0].stance, s)
    for (const b of TILT_BASES) assert.equal(normalizeTilt({ tilts: [row({ basis: b })] }, NOW).tilts[0].basis, b)
})

// ── the clock lives on the ROW ───────────────────────────────────────────────
test('each row carries its OWN window, defaulted and derived', () => {
    const t = normalizeTilt({ tilts: [row(), row({ sector: 'Energy', horizon: '3m', active_bp: -150, stance: 'under' })] }, NOW)
    assert.equal(t.tilts[0].horizon, '12m')                          // house default
    assert.equal(t.tilts[0].set_at, NOW)
    assert.equal(t.tilts[0].review_date, '2027-08-06T00:00:00.000Z')
    assert.equal(t.tilts[1].horizon, '3m')
    assert.equal(t.tilts[1].review_date, '2026-11-06T00:00:00.000Z')
})

test('REAFFIRMING a row keeps its clock; re-authoring restarts it', () => {
    // The whole reason the clock is per row: a monthly review that changes two sectors must not
    // reset the nine it reaffirmed, or a 12-month call never comes due.
    const held  = row({ set_at: '2026-01-01T00:00:00.000Z', horizon: '12m' })
    const fresh = row({ sector: 'Energy', active_bp: -150, stance: 'under' })
    const t = normalizeTilt({ tilts: [held, fresh] }, NOW)
    assert.equal(t.tilts[0].set_at, '2026-01-01T00:00:00.000Z')
    assert.equal(t.tilts[0].review_date, '2027-01-01T00:00:00.000Z')   // deadline holds
    assert.equal(t.tilts[1].set_at, NOW)                                // new call, new window
})

test('a hand-supplied review_date is ignored — the deadline cannot disagree with the horizon', () => {
    const t = normalizeTilt({ tilts: [row({ horizon: '6m', set_at: NOW, review_date: '2099-01-01T00:00:00.000Z' })] }, NOW)
    assert.equal(t.tilts[0].review_date, '2027-02-06T00:00:00.000Z')
})

// ── balance ──────────────────────────────────────────────────────────────────
test('a balanced table nets to ~zero; an unbalanced one is FLAGGED, not destroyed', () => {
    const balanced = normalizeTilt({ tilts: [
        row({ active_bp: 150 }),
        row({ sector: 'Energy', stance: 'under', active_bp: -150 }),
    ] }, NOW)
    assert.equal(balanced.net_bp, 0)
    assert.equal(balanced.balanced, true)

    const lopsided = normalizeTilt({ tilts: [
        row({ active_bp: 300 }),
        row({ sector: 'Energy', stance: 'over', active_bp: 200 }),
    ] }, NOW)
    assert.equal(lopsided.net_bp, 500)
    assert.equal(lopsided.balanced, false)
    assert.equal(lopsided.tilts.length, 2, 'the rows survive — the flag is the signal')
})

test('rounding slack inside the tolerance still counts as balanced', () => {
    const t = normalizeTilt({ tilts: [
        row({ active_bp: BALANCE_TOLERANCE_BP }),
        row({ sector: 'Energy', stance: 'neutral', active_bp: 0 }),
    ] }, NOW)
    assert.equal(t.balanced, true)
    const over = normalizeTilt({ tilts: [row({ active_bp: BALANCE_TOLERANCE_BP + 1 })] }, NOW)
    assert.equal(over.balanced, false)
})

// ── coherence: the words must agree with the number ──────────────────────────
test('stanceCoherence: the sector twin of coverage rating-vs-target', () => {
    assert.equal(stanceCoherence({ stance: 'over',    active_bp:  150 }).ok, true)
    assert.equal(stanceCoherence({ stance: 'under',   active_bp: -150 }).ok, true)
    assert.equal(stanceCoherence({ stance: 'neutral', active_bp:    0 }).ok, true)

    // active_bp is what Atlas would ALLOCATE on, so these would move the book the wrong way.
    assert.equal(stanceCoherence({ stance: 'over',    active_bp: -150 }).ok, false)
    assert.equal(stanceCoherence({ stance: 'under',   active_bp:  150 }).ok, false)
    assert.equal(stanceCoherence({ stance: 'neutral', active_bp:  150 }).ok, false)
    assert.equal(stanceCoherence({ stance: 'over',    active_bp:    0 }).ok, false, 'over with no weight is not a tilt')
})

test('stanceCoherence ABSTAINS when nothing is claimed', () => {
    assert.equal(stanceCoherence({ stance: null, active_bp: 150 }).ok, true)
    assert.equal(stanceCoherence({ stance: 'over', active_bp: null }).ok, true)
    assert.equal(stanceCoherence({}).ok, true)
    assert.equal(stanceCoherence(undefined).ok, true)
})

test('incoherentRows names every offender, so the author can fix them in one pass', () => {
    const doc = normalizeTilt({ tilts: [
        row(),                                                              // fine
        row({ sector: 'Energy',    stance: 'under',   active_bp:  200 }),   // contradicts
        row({ sector: 'Utilities', stance: 'neutral', active_bp: -100 }),   // contradicts
    ] }, NOW)
    const bad = incoherentRows(doc)
    assert.deepEqual(bad.map(b => b.sector), ['Energy', 'Utilities'])
    assert.match(bad[0].detail, /negative active weight/)
    assert.equal(incoherentRows(normalizeTilt({ tilts: [row()] }, NOW)).length, 0)
})

// ── the regime is the BASIS, not a second entity ─────────────────────────────
test('regime keeps name + thesis + falsifiers; an empty one is null, not a husk', () => {
    const t = normalizeTilt({ regime: {
        name: 'late-cycle disinflation', thesis: 'Growth slows, cuts arrive.',
        kill_criteria: ['core CPI re-accelerates above 3.5% for two prints', '  ', null],
    }, tilts: [row()] }, NOW)
    assert.equal(t.regime.name, 'late-cycle disinflation')
    assert.deepEqual(t.regime.kill_criteria, ['core CPI re-accelerates above 3.5% for two prints'])

    assert.equal(normalizeTilt({ regime: {}, tilts: [row()] }, NOW).regime, null)
    assert.equal(normalizeTilt({ regime: 'a vibe', tilts: [row()] }, NOW).regime, null)
})

// ── status ───────────────────────────────────────────────────────────────────
test('status is validated; unknown falls back to active', () => {
    for (const s of TILT_STATUSES) assert.equal(normalizeTilt({ status: s, tilts: [row()] }, NOW).status, s)
    assert.equal(normalizeTilt({ status: 'published', tilts: [row()] }, NOW).status, 'active')
})
