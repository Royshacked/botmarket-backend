import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _checkTilt, _resolvePrices } from '../../monitoring/tilt.monitor.service.js'

// Pythia's per-view check, with mocked prices/DB (deps injectable).

const DAY = 24 * 60 * 60 * 1000
const T0  = Date.parse('2026-01-01T00:00:00.000Z')
const at  = days => T0 + days * DAY

const row = (over = {}) => ({
    sector: 'Technology', stance: 'over', active_bp: 150,
    set_at: '2026-01-01T00:00:00.000Z', review_date: '2027-01-01T00:00:00.000Z',
    base_px: 100, base_bench_px: 100, state: 'open', contribution_bp: null, ...over,
})
const doc = (over = {}) => ({
    id: 'tilt1', benchmark: 'SPX', status: 'active',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    tilts: [row()], ...over,
})

function harness({ prices = { XLK: 110, XLE: 90, SPY: 104 }, catalystDates = [] } = {}) {
    // Two write paths, both owned by tilt.service and both injected — the monitor no longer reaches
    // into the collection itself. `updateTilt` is the PUBLICATION path (appends a revision, for a
    // real state change like a stance maturing); `recordMonitorState` is the quiet daily grade
    // refresh, which must NOT append a revision or eleven a day would bury the trail.
    const db = { collection: () => ({ find: () => ({ toArray: async () => [] }) }) }
    const updates = [], reviews = [], writes = []
    const deps = {
        getPrice:      async (sym) => prices[sym] ?? null,
        updateTilt:    async (id, patch) => { updates.push({ id, patch }); return { ok: true } },
        recordMonitorState: async (id, { set = {}, inc = null } = {}) => { writes.push({ id, set, inc }); return { ok: true } },
        // The wake is an OFFER — a card asking the user to run the review — so the dep returns how
        // many were posted, not whether a run started. The whole doc is kept: the card is built from
        // it, and it must be the GRADED view, not the stored one.
        requestReview: async (d, reason) => { reviews.push({ id: d.id, reason, doc: d }); return 1 },
        catalystDates: async () => catalystDates,
    }
    return { db, deps, updates, reviews, writes }
}

// ── price resolution ─────────────────────────────────────────────────────────
test('only sectors carrying an OPEN stance are priced', async () => {
    const asked = []
    const deps = { getPrice: async (s) => { asked.push(s); return 100 } }
    await _resolvePrices([row(), row({ sector: 'Energy', state: 'matured' })], 'SPX', deps)
    assert.deepEqual(asked.sort(), ['SPY', 'XLK'], 'a matured stance is settled — no need to re-price it')
})

test('an unknown benchmark or unpriceable sector degrades to null, not a throw', async () => {
    const deps = { getPrice: async () => null }
    const { bySector, bench } = await _resolvePrices([row()], 'NIKKEI', deps)
    assert.equal(bench, null)
    assert.equal(bySector.get('Technology'), null)
})

// ── the daily grade ──────────────────────────────────────────────────────────
test('a quiet day writes the grade as BOOKKEEPING — no revision, no card', async () => {
    const h = harness()
    const res = await _checkTilt(h.db, doc(), at(30), h.deps)
    assert.equal(res.graded, true)
    assert.equal(h.updates.length, 0, 'a contribution ticking with the tape is not the desk changing its mind')

    const $set = h.writes.at(-1).set
    assert.equal($set.tilts[0].contribution_bp, 9)     // 150bp x (+10% - +4%)
    assert.equal($set['monitor.total_bp'], 9)
    assert.equal($set['monitor.next_check_at'], new Date(at(31)).toISOString())
})

test('an underweight that beat its benchmark scores POSITIVE', async () => {
    // Energy proxy 100 → 90 (-10%) while SPY 100 → 104 (+4%): -14% relative, and we were -150bp.
    const h = harness()
    const d = doc({ tilts: [row({ sector: 'Energy', stance: 'under', active_bp: -150 })] })
    await _checkTilt(h.db, d, at(30), h.deps)
    assert.equal(h.writes.at(-1).set.tilts[0].contribution_bp, 21)
})

// ── maturity ─────────────────────────────────────────────────────────────────
test('a newly matured stance IS a state change — it gets a revision through the service', async () => {
    const h = harness()
    const d = doc({ tilts: [row({ sector: 'Energy', review_date: '2026-02-01T00:00:00.000Z' })] })
    const res = await _checkTilt(h.db, d, at(45), h.deps)
    assert.deepEqual(res.matured, ['Energy'])
    assert.equal(h.updates.length, 1)
    assert.equal(h.updates[0].patch.revision_kind, 'stance_matured')
    assert.match(h.updates[0].patch.revision_note, /Energy .*bp/)
})

test('a stance already matured does not re-fire on the next tick', async () => {
    const h = harness()
    const d = doc({ tilts: [row({ state: 'matured', review_date: '2026-02-01T00:00:00.000Z' })] })
    const res = await _checkTilt(h.db, d, at(60), h.deps)
    assert.deepEqual(res.matured, [])
    assert.equal(h.updates.length, 0)
})

test('a failed maturity write leaves the view DUE rather than swallowing the verdict', async () => {
    const h = harness()
    h.deps.updateTilt = async () => ({ ok: false, reason: 'mongo down' })
    const d = doc({ tilts: [row({ review_date: '2026-02-01T00:00:00.000Z' })] })
    const res = await _checkTilt(h.db, d, at(45), h.deps)
    assert.equal(res.graded, false)
    // No bookkeeping written → next_check_at unchanged → the next tick retries.
    assert.equal(h.writes.length, 0)
})

// ── baseline backfill ────────────────────────────────────────────────────────
test('a stance published without a baseline is backfilled, not left unscoreable', async () => {
    const h = harness()
    const d = doc({ tilts: [row({ base_px: null, base_bench_px: null })] })
    await _checkTilt(h.db, d, at(30), h.deps)
    const stored = h.writes.at(-1).set.tilts[0]
    assert.equal(stored.base_px, 110)          // today's price, a tick late
    assert.equal(stored.base_bench_px, 104)
    assert.equal(stored.contribution_bp, 0)    // graded from today → nothing earned yet, correctly
})

test('an EXISTING baseline is never rewritten — it is what the call was made at', async () => {
    const h = harness()
    await _checkTilt(h.db, doc(), at(30), h.deps)
    assert.equal(h.writes.at(-1).set.tilts[0].base_px, 100, 'immutable once stamped')
})

test('a baseline that still cannot be priced stays null rather than being guessed', async () => {
    const h = harness({ prices: { SPY: 104 } })   // no XLK
    const d = doc({ tilts: [row({ base_px: null, base_bench_px: null })] })
    await _checkTilt(h.db, d, at(30), h.deps)
    const stored = h.writes.at(-1).set.tilts[0]
    assert.equal(stored.base_px, null)
    assert.equal(stored.contribution_bp, null, 'ungradeable is null, never 0')
})

// ── waking the desk ──────────────────────────────────────────────────────────
test('a matured stance wakes the desk — as an OFFER, not a run', async () => {
    const h = harness()
    const d = doc({ tilts: [row({ sector: 'Energy', review_date: '2026-02-01T00:00:00.000Z' })] })
    const res = await _checkTilt(h.db, d, at(45), h.deps)
    assert.equal(h.reviews.length, 1)
    assert.match(h.reviews[0].reason, /stance matured/)
    assert.equal(res.offered, 1, 'the tick reports how many were asked')
    // The card is built from the GRADED view. Built from the stored copy the stance that just came
    // due would still read `open`, and the card would lead with a generic "review due" — losing the
    // one thing it was posted to say.
    assert.equal(h.reviews[0].doc.tilts[0].state, 'matured')
    assert.equal(h.reviews[0].doc.revisions !== undefined || h.reviews[0].doc.created_at !== undefined, true,
        'and the rest of the doc rides along — the dedupe window anchors on its publish')
})

test('a quiet day inside the cooldown wakes nobody', async () => {
    const h = harness()
    const res = await _checkTilt(h.db, doc(), at(3), h.deps)
    assert.equal(res.remodel.due, false)
    assert.equal(h.reviews.length, 0)
    assert.equal(res.offered, 0)
})

test('a dated macro catalyst wakes it', async () => {
    const h = harness({ catalystDates: ['2026-01-19'] })
    await _checkTilt(h.db, doc(), at(20), h.deps)
    assert.equal(h.reviews.length, 1)
    assert.match(h.reviews[0].reason, /macro catalyst/)
})

// The bug this fixed: the maturity write bumps `updated_at`, which used to be the anchor — so the
// stance that came due restarted the cooldown and muted its own trigger on the very next tick.
test('the maturity write does not mute the trigger it just fired', async () => {
    const h = harness()
    const matured = row({ sector: 'Energy', review_date: '2026-02-01T00:00:00.000Z' })
    const d = doc({
        tilts:      [matured],
        revisions:  [{ at: '2026-01-01T00:00:00.000Z', kind: 'publish' }],
    })
    await _checkTilt(h.db, d, at(45), h.deps)
    assert.equal(h.reviews.length, 1)

    // The next tick sees what the maturity write left behind: updated_at is NOW, the trail carries a
    // stance_matured entry on top of the publish, and the row is already flagged matured.
    const after = {
        ...d,
        updated_at: new Date(at(45)).toISOString(),
        tilts:      [{ ...matured, state: 'matured' }],
        revisions:  [{ at: new Date(at(45)).toISOString(), kind: 'stance_matured' }, ...d.revisions],
    }
    const res = await _checkTilt(h.db, after, at(46), h.deps)
    // Anchored on `updated_at` this was inside a fresh 7-day cooldown and read as quiet. Anchored on
    // the publish it stays due, because the review has not happened — only the grading.
    assert.equal(res.remodel.due, true)
    assert.match(res.remodel.reason, /stance matured/)
})

test('a catalyst lookup that throws never breaks the daily grade', async () => {
    const h = harness()
    h.deps.catalystDates = async () => { throw new Error('calendar down') }
    const res = await _checkTilt(h.db, doc(), at(30), h.deps)
    assert.equal(res.graded, true, 'grading is free and must not depend on the calendar')
})
