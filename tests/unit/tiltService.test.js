import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    normalizeTilt, stanceCoherence, incoherentRows, balanceOf,
    carryReaffirmed, draftForPublish, tiltService, _setTiltIO,
    STANCES, TILT_BASES, TILT_STATUSES, BALANCE_TOLERANCE_BP, DESK_HORIZON,
} from '../../api/strategy/tilt.service.js'

// Pythia's `tilt` schema normalizer (pure). The CRUD is DB-bound and not unit-tested, mirroring
// normalizeCoverage vs the coverage CRUD.

const row = (over = {}) => ({ bucket: 'Technology', stance: 'over', active_bp: 150, basis: 'bottom_up', ...over })
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
    const t = normalizeTilt({ tilts: [row({ bucket: 'Financials' }), row({ bucket: 'Health Care', active_bp: -150, stance: 'under' })] }, NOW)
    assert.deepEqual(t.tilts.map(r => r.bucket), ['Financial Services', 'Healthcare'])
})

test('normalize: a row naming nothing the vocabulary knows is DROPPED', () => {
    const t = normalizeTilt({ tilts: [row(), row({ bucket: 'the AI trade' }), row({ bucket: null }), 'nonsense'] }, NOW)
    assert.equal(t.tilts.length, 1)
    assert.equal(t.tilts[0].bucket, 'Technology')
})

test('normalize: an INDUSTRY is kept, at its own grain and against its own fund', () => {
    // It used to be dropped for not being one of the eleven. A semis call is a semis call.
    const t = normalizeTilt({ tilts: [row({ bucket: 'Semiconductors' })] }, NOW)
    assert.equal(t.tilts.length, 1)
    assert.equal(t.tilts[0].bucket, 'Semiconductors')
    assert.equal(t.tilts[0].grain, 'industry')
    assert.equal(t.tilts[0].proxy.symbol, 'SMH')
})

test('normalize: the proxy is FROZEN onto the row, not looked up on every read', () => {
    // Same rule as the baseline. Swapping a fund in the table must not re-score a standing call
    // against an instrument it was never measured on.
    const stored = normalizeTilt({ tilts: [row({ bucket: 'Energy', proxy: { symbol: 'XOP', weighting: 'equal', exact: false } })] }, NOW)
    assert.equal(stored.tilts[0].proxy.symbol, 'XOP', 'the row keeps what it was published against')
    assert.equal(normalizeTilt({ tilts: [row({ bucket: 'Energy' })] }, NOW).tilts[0].proxy.symbol, 'XLE')
})

test('normalize: one row per sector — a duplicate never quietly overrides the first', () => {
    const t = normalizeTilt({ tilts: [
        row({ active_bp: 150 }),
        row({ bucket: 'Information Technology', active_bp: -300, stance: 'under' }),   // same sector, other spelling
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
    const t = normalizeTilt({ tilts: [row(), row({ bucket: 'Energy', horizon: '3m', active_bp: -150, stance: 'under' })] }, NOW)
    // THE DESK's default, not the clock module's `12m`. Pythia's prompt has always said 6m, and a
    // stance defaulting to 12m under a monthly review would never be graded inside a year.
    assert.equal(t.tilts[0].horizon, DESK_HORIZON)
    assert.equal(DESK_HORIZON, '6m')
    assert.equal(t.tilts[0].set_at, NOW)
    assert.equal(t.tilts[0].review_date, '2027-02-06T00:00:00.000Z')
    assert.equal(t.tilts[1].horizon, '3m')
    assert.equal(t.tilts[1].review_date, '2026-11-06T00:00:00.000Z')
})

test('REAFFIRMING a row keeps its clock; re-authoring restarts it', () => {
    // The whole reason the clock is per row: a monthly review that changes two sectors must not
    // reset the nine it reaffirmed, or a 12-month call never comes due.
    const held  = row({ set_at: '2026-01-01T00:00:00.000Z', horizon: '12m' })
    const fresh = row({ bucket: 'Energy', active_bp: -150, stance: 'under' })
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
        row({ bucket: 'Energy', stance: 'under', active_bp: -150 }),
    ] }, NOW)
    assert.equal(balanced.net_bp, 0)
    assert.equal(balanced.balanced, true)

    const lopsided = normalizeTilt({ tilts: [
        row({ active_bp: 300 }),
        row({ bucket: 'Energy', stance: 'over', active_bp: 200 }),
    ] }, NOW)
    assert.equal(lopsided.net_bp, 500)
    assert.equal(lopsided.balanced, false)
    assert.equal(lopsided.tilts.length, 2, 'the rows survive — the flag is the signal')
})

test('rounding slack inside the tolerance still counts as balanced', () => {
    const t = normalizeTilt({ tilts: [
        row({ active_bp: BALANCE_TOLERANCE_BP }),
        row({ bucket: 'Energy', stance: 'neutral', active_bp: 0 }),
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
        row({ bucket: 'Energy',    stance: 'under',   active_bp:  200 }),   // contradicts
        row({ bucket: 'Utilities', stance: 'neutral', active_bp: -100 }),   // contradicts
    ] }, NOW)
    const bad = incoherentRows(doc)
    assert.deepEqual(bad.map(b => b.bucket), ['Energy', 'Utilities'])
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

// ── the balance verdict, which is the SERVER's answer ────────────────────────
//
// It moved out of the frontend, where the panel re-derived it against a hardcoded 50 — a copy of
// BALANCE_TOLERANCE_BP living in a second repo, with nothing to say when the two drifted. The desk's
// draft response carries balanceOf() now, so the preview and the publish cannot disagree about
// whether a table nets out. These are the cases the panel's own test can no longer assert.

test('a table that cancels is balanced', () => {
    assert.deepEqual(balanceOf([{ active_bp: 150 }, { active_bp: -150 }]), { net_bp: 0, balanced: true })
})

test('rounding slack inside the tolerance is not a warning', () => {
    // The tolerance exists because a hand-written table rarely nets to exactly zero, and flagging
    // ±10bp of rounding would make the warning meaningless by firing constantly.
    assert.equal(balanceOf([{ active_bp: 50 }]).balanced, true)
    assert.equal(balanceOf([{ active_bp: -50 }]).balanced, true)
})

test('past the tolerance is flagged, in both directions', () => {
    assert.equal(balanceOf([{ active_bp: 51 }]).balanced, false)
    assert.equal(balanceOf([{ active_bp: -51 }]).balanced, false)
    assert.deepEqual(balanceOf([{ active_bp: 300 }, { active_bp: 200 }]), { net_bp: 500, balanced: false })
})

test('missing and junk weights count as zero rather than poisoning the sum', () => {
    // A row can legitimately arrive without a weight (the panel renders a dash for it). NaN
    // propagating through the sum would make `balanced` false for every table containing one.
    assert.deepEqual(balanceOf([{ active_bp: null }, { active_bp: 'x' }, {}]), { net_bp: 0, balanced: true })
    assert.deepEqual(balanceOf(), { net_bp: 0, balanced: true })
    assert.deepEqual(balanceOf(null), { net_bp: 0, balanced: true })
})

test('the stored document and the draft answer alike', () => {
    // Same function on both sides of the publish, which is the whole point of extracting it.
    const rows = [{ bucket: 'Energy', stance: 'over', active_bp: 400 }]
    const doc  = normalizeTilt({ benchmark: 'SPX', tilts: rows })
    assert.equal(doc.balanced, balanceOf(rows).balanced)
    assert.equal(doc.net_bp,   balanceOf(rows).net_bp)
})

// ── the reaffirm carry, on the PUBLISH path ──────────────────────────────────
//
// The clock test above hands `set_at` straight to the normalizer, which is the one thing a real
// publish never does: Pythia emits a table, the `<tilt>` block has no `set_at` field, and the
// frontend posts what the model emitted. So the rule held in the helper and broke in the app —
// every publish re-stamped every window and re-priced every baseline. These tests run the path the
// wire actually takes.

const LATER = '2026-09-19T00:00:00.000Z'
/** A STORED row, as the standing view carries it — clock and baseline already frozen. */
const heldRow = (over = {}) => ({
    bucket: 'Technology', grain: 'sector', proxy: { symbol: 'XLK', weighting: 'cap', exact: true },
    stance: 'over', active_bp: 150, horizon: '12m',
    set_at: NOW, review_date: '2027-08-06T00:00:00.000Z',
    base_px: 180, base_bench_px: 700, contribution_bp: 1.25, state: 'open', ...over,
})
/** A row off the wire — what the model emits, which is stance, weight and words. */
const wireRow = (over = {}) => ({ bucket: 'Technology', stance: 'over', active_bp: 150, horizon: '12m', basis: 'bottom_up', ...over })

test('carry: a RESTATED stance keeps its window, its baseline and its running grade', () => {
    const [carried] = carryReaffirmed([wireRow()], { tilts: [heldRow()] }, LATER)
    assert.equal(carried.set_at, NOW, 'the deadline first chosen is the one it is judged against')
    assert.equal(carried.base_px, 180)
    assert.equal(carried.base_bench_px, 700)
    assert.equal(carried.contribution_bp, 1.25)
})

test('carry: a MOVED stance is a new call — weight, direction or horizon each restart it', () => {
    const held = { tilts: [heldRow()] }
    for (const moved of [
        wireRow({ active_bp: 200 }),                               // resized
        wireRow({ stance: 'under', active_bp: -150 }),             // reversed
        wireRow({ horizon: '3m' }),                                // re-cut to a different deadline
    ]) {
        const [row0] = carryReaffirmed([moved], held, LATER)
        assert.equal(row0.set_at, undefined, 'a changed call may not inherit the old one\'s clock')
        assert.equal(row0.base_px, undefined)
    }
})

test('carry: a CLOSED window is never inherited — the old call was already owed a verdict', () => {
    // Both shapes of closed: graded shut by the monitor, and simply past its deadline. Carrying
    // either would store a row that is overdue the instant it is written, and the review it triggers
    // would offer the same stance again on every tick.
    const matured = { tilts: [heldRow({ state: 'matured' })] }
    const expired = { tilts: [heldRow({ review_date: '2026-09-01T00:00:00.000Z' })] }
    for (const prev of [matured, expired]) {
        const [row0] = carryReaffirmed([wireRow()], prev, LATER)
        assert.equal(row0.set_at, undefined)
        assert.equal(row0.base_px, undefined)
    }
})

test('carry: an OMITTED horizon is the desk default, so it still reads as the same call', () => {
    // The trap the desk default closes. `_sameCall` compares horizons, so if the normalizer and the
    // reaffirm check disagreed about what an omission means, a row Pythia meant to restate would be
    // filed as a re-author and silently lose its window — and `diffStances` ignores the horizon, so
    // no card would say so either. One row at a time, which is harder to see than all six at once.
    const held = { tilts: [heldRow({ horizon: '6m', review_date: '2027-02-06T00:00:00.000Z' })] }
    const [carried] = carryReaffirmed([wireRow({ horizon: undefined })], held, LATER)
    assert.equal(carried.set_at, NOW, 'an omitted horizon must not restart the clock')
    assert.equal(carried.base_px, 180)

    // ...and the other direction: a row that really is re-cut still restarts.
    const [recut] = carryReaffirmed([wireRow({ horizon: '3m' })], held, LATER)
    assert.equal(recut.set_at, undefined)
})

test('carry: the sector is matched CANONICALLY, so a GICS spelling still finds its own history', () => {
    const [carried] = carryReaffirmed(
        [wireRow({ bucket: 'Information Technology' })],
        { tilts: [heldRow()] }, LATER,
    )
    assert.equal(carried.set_at, NOW)
})

test('carry: no standing view, an unknown sector and junk rows are all the identity', () => {
    const rows = [wireRow()]
    assert.deepEqual(carryReaffirmed(rows, null, LATER), rows)
    assert.deepEqual(carryReaffirmed(rows, { tilts: [] }, LATER), rows)
    assert.deepEqual(carryReaffirmed([wireRow({ bucket: 'Energy' })], { tilts: [heldRow()] }, LATER),
        [wireRow({ bucket: 'Energy' })], 'a sector we held no view on has nothing to inherit')
    assert.deepEqual(carryReaffirmed(['nonsense', null], { tilts: [heldRow()] }, LATER), ['nonsense', null])
    assert.deepEqual(carryReaffirmed(undefined, { tilts: [heldRow()] }, LATER), [])
})

test('carry: a caller that states the window itself is not overridden', () => {
    // A repair script or a re-publish of a stored document is asserting the call's history on
    // purpose. This is a fallback for the author who cannot state it, not an override of one who can.
    const [carried] = carryReaffirmed(
        [wireRow({ set_at: '2026-01-01T00:00:00.000Z', base_px: 99 })],
        { tilts: [heldRow()] }, LATER,
    )
    assert.equal(carried.set_at, '2026-01-01T00:00:00.000Z')
    assert.equal(carried.base_px, 99)
})

test('draft: a RESTATED stance stays on the fund its baseline was priced from, whatever the map says now', () => {
    // The baseline is a price of ONE instrument. E&P moved XOP → IEO in BUCKET_PROXY on 2026-09-30;
    // a stance set on XOP and restated afterwards must still be graded on XOP, or its score compares
    // IEO today against XOP at inception.
    const ep = { bucket: 'Oil & Gas Exploration & Production', grain: 'industry' }
    const held = { tilts: [heldRow({ ...ep, proxy: { symbol: 'XOP', weighting: 'equal', exact: true }, base_px: 130 })] }

    const [kept] = draftForPublish({ tilts: [wireRow({ bucket: ep.bucket })] }, held, LATER).tilts
    assert.equal(kept.proxy.symbol, 'XOP', 'the fund the baseline was priced from')
    assert.equal(kept.base_px, 130)

    // A MOVED call is a new call: fresh clock, fresh baseline, and the fund the map names today.
    const [fresh] = draftForPublish({ tilts: [wireRow({ bucket: ep.bucket, active_bp: 200 })] }, held, LATER).tilts
    assert.equal(fresh.proxy.symbol, 'IEO')
    assert.equal(fresh.base_px, null)
})

test('carry: a held row with no stored fund falls back to the map rather than to nothing', () => {
    // A document written before `proxy` existed. There is no instrument to keep, so the map decides.
    const [row0] = draftForPublish({ tilts: [wireRow()] }, { tilts: [heldRow({ proxy: undefined })] }, LATER).tilts
    assert.equal(row0.proxy.symbol, 'XLK')
})

test('draft: the carried window survives normalisation, and the deadline holds', () => {
    // The end of the publish path that a database is not needed for: what publishTilt stores.
    const draft = draftForPublish(
        { tilts: [wireRow(), wireRow({ bucket: 'Energy', stance: 'under', active_bp: -150, horizon: '3m' })] },
        { tilts: [heldRow()] },
        LATER,
    )
    const [tech, energy] = draft.tilts
    assert.equal(tech.set_at, NOW)
    assert.equal(tech.review_date, '2027-08-06T00:00:00.000Z', 'a monthly review must not push the deadline out')
    assert.equal(tech.base_px, 180, 'still graded from where the call was actually made')
    assert.equal(energy.set_at, LATER, 'a sector we had no view on is a fresh call')
    assert.equal(energy.review_date, '2026-12-19T00:00:00.000Z')
})

test('draft: republishing an unchanged table leaves every clock exactly where it was', () => {
    // The failure this whole fix is about: four of five real republishes restarted all six rows,
    // so nothing could ever mature and the score re-based at each review's own prices.
    const standing = { tilts: [heldRow(), heldRow({ bucket: 'Energy', stance: 'under', active_bp: -150, horizon: '3m', set_at: NOW, review_date: '2026-11-06T00:00:00.000Z', base_px: 58 })] }
    const draft = draftForPublish({ tilts: [wireRow(), wireRow({ bucket: 'Energy', stance: 'under', active_bp: -150, horizon: '3m' })] }, standing, LATER)
    assert.deepEqual(draft.tilts.map(r => r.set_at), [NOW, NOW])
    assert.deepEqual(draft.tilts.map(r => r.base_px), [180, 58])
    assert.equal(draft.created_at, LATER, 'the DOCUMENT is new; the calls on it are not')
})

test('publish reads the standing view before it normalises anything', async () => {
    // The link the helper tests cannot reach: publishTilt must fetch what it is restating, and do it
    // for the benchmark being published. Asserted on the refusal path, which returns before any DB.
    const seen = []
    _setTiltIO({ currentView: async (benchmark) => { seen.push(benchmark); return null } })
    try {
        const res = await tiltService.publishTilt({ benchmark: 'NDX', tilts: [wireRow({ stance: 'under', active_bp: 150 })] })
        assert.equal(res.ok, false)
        assert.equal(res.reason, 'stance_contradicts_weight')
        assert.deepEqual(seen, ['NDX'], 'the read happens, and for the benchmark being published')
    } finally {
        _setTiltIO({ currentView: (benchmark) => tiltService.getCurrentTilt(benchmark) })
    }
})

// ── the reaffirm rule for SIZED rows ─────────────────────────────────────────
// A sized row's weight is the server's arithmetic: the same calls published 40bp rows as 45bp the
// next review. Under the strict rule every one restarted its clock, baseline and line.

const sizedHeld = (over = {}) => heldRow({ bucket: 'Semiconductors', grain: 'industry', basis: 'evidence', active_bp: 40,
    proxy: { symbol: 'SMH', weighting: 'cap', exact: true }, contribution_bp: 2, ...over })
const sizedWire = (over = {}) => ({ bucket: 'Semiconductors', stance: 'over', active_bp: 45, horizon: '12m', basis: 'evidence', ...over })

test('reaffirm: a sized row that keeps its direction keeps its clock, baseline and fund, at the new weight', () => {
    const [carried] = carryReaffirmed([sizedWire()], { tilts: [sizedHeld()] }, LATER)
    assert.equal(carried.set_at, NOW)
    assert.equal(carried.base_px, 180)
    assert.equal(carried.proxy.symbol, 'SMH')
    assert.equal(carried.active_bp, 45, 'the new weight is applied')
    assert.equal(carried.contribution_bp, 2.25, 'contribution restated at the new weight: 2 × 45/40')
})

test('reaffirm: a sized row moving from channels to evidence is still the same call', () => {
    const [carried] = carryReaffirmed([sizedWire({ basis: 'channels' })], { tilts: [sizedHeld()] }, LATER)
    assert.equal(carried.set_at, NOW)
})

test('reaffirm: a sized row that FLIPS direction, or changes horizon, is a new call', () => {
    for (const moved of [sizedWire({ stance: 'under', active_bp: -45 }), sizedWire({ horizon: '3m' })]) {
        const [row0] = carryReaffirmed([moved], { tilts: [sizedHeld()] }, LATER)
        assert.equal(row0.set_at, undefined)
        assert.equal(row0.base_px, undefined)
    }
})

test('reaffirm: the desk\'s OWN row still restarts when its weight changes', () => {
    const own = heldRow({ basis: 'bottom_up', active_bp: 150 })
    const [row0] = carryReaffirmed([wireRow({ active_bp: 200 })], { tilts: [own] }, LATER)
    assert.equal(row0.set_at, undefined, 'changing your own weight is re-authoring the call')
})

test('reaffirm: an own row and a sized row on the same bucket are not the same call at a new weight', () => {
    // A bucket that was Pythia's coverage row and is now sized (or back) — the weight rule stays strict.
    const [row0] = carryReaffirmed([sizedWire()], { tilts: [sizedHeld({ basis: 'bottom_up' })] }, LATER)
    assert.equal(row0.set_at, undefined)
})
