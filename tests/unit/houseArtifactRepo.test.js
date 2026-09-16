import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeHouseArtifactRepo } from '../../services/houseArtifact.repo.js'
import { _updateSet as coverageSet, normalizeCoverage } from '../../api/analyst/coverage.service.js'
import { _updateSet as tiltSet, normalizeTilt } from '../../api/strategy/tilt.service.js'

// The write pipe under coverage and the tilt. Both services used to read the doc, rebuild `revisions`
// as a whole array and `$set` it back beside EVERY field of the merged document — so two writers in
// one window lost a revision or resurrected a field the other had just moved. The repo makes the
// trail append-only in the database ($push at position 0) and each service's `_updateSet` writes only
// what the patch named.

function fakeDb() {
    const calls = []
    const db = { collection: () => ({ updateOne: async (filter, update) => { calls.push({ filter, update }); return { matchedCount: 1 } } }) }
    return { calls, getDb: async () => db }
}

// ── the repo ─────────────────────────────────────────────────────────────────

test('revise: one update — the patched fields set, the revision PREPENDED, never the whole trail', async () => {
    const f = fakeDb()
    const repo = makeHouseArtifactRepo({ collection: 'x', getDb: f.getDb })
    const rev  = { at: '2026-09-16T00:00:00.000Z', kind: 'update', note: null, changed: null }
    const res  = await repo.revise('cov_1', { rating: 'buy', updated_at: 'now' }, rev)
    assert.deepEqual(res, { ok: true })
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.calls[0].filter, { id: 'cov_1' })
    assert.deepEqual(f.calls[0].update, {
        $set:  { rating: 'buy', updated_at: 'now' },
        $push: { revisions: { $each: [rev], $position: 0 } },   // newest first — reviewAnchorMs .find()s the latest
    })
})

test('revise refuses a $set that carries the trail — the trail is appended, never overwritten', async () => {
    const repo = makeHouseArtifactRepo({ collection: 'x', getDb: fakeDb().getDb })
    await assert.rejects(() => repo.revise('id', { revisions: [] }, { kind: 'x' }), /appended, never set/)
    await assert.rejects(() => repo.revise('id', {}, null), /revision is required/)
})

test('revise with nothing to set sends only the $push — an empty $set is a rejected update on older Mongo', async () => {
    const f = fakeDb()
    const repo = makeHouseArtifactRepo({ collection: 'x', getDb: f.getDb })
    await repo.revise('id', {}, { kind: 'reaffirm' })
    assert.deepEqual(Object.keys(f.calls[0].update), ['$push'])
})

test('revise reports a miss as ok:false, from matchedCount', async () => {
    const db = { collection: () => ({ updateOne: async () => ({ matchedCount: 0 }) }) }
    const repo = makeHouseArtifactRepo({ collection: 'x', getDb: async () => db })
    assert.deepEqual(await repo.revise('gone', {}, { kind: 'x' }), { ok: false })
})

test('recordMonitorState: a flat $set, $inc only when given, no revision', async () => {
    const f = fakeDb()
    const repo = makeHouseArtifactRepo({ collection: 'x', getDb: f.getDb })
    await repo.recordMonitorState('id', { set: { 'monitor.checks_at': 't' } })
    await repo.recordMonitorState('id', { set: { 'monitor.next_check_at': 't' }, inc: { 'monitor.checks': 1 } })
    assert.deepEqual(f.calls[0].update, { $set: { 'monitor.checks_at': 't' } })
    assert.deepEqual(f.calls[1].update, { $set: { 'monitor.next_check_at': 't' }, $inc: { 'monitor.checks': 1 } })
    assert.ok(f.calls.every(c => !('$push' in c.update)), 'bookkeeping never touches the trail')
})

test('a collection name is required', () => {
    assert.throws(() => makeHouseArtifactRepo({}), /collection is required/)
})

// ── coverage._updateSet: only what the patch named ───────────────────────────

const cur = normalizeCoverage({ id: 'cov_1', symbol: 'NVDA', rating: 'buy', price_target: { value: 200 }, thesis: 'v1', created_at: '2026-01-01T00:00:00.000Z' })

test('coverage: a rating patch writes rating + updated_at — NOT the target it did not name', () => {
    const merged = normalizeCoverage({ ...cur, rating: 'hold' })
    const $set = coverageSet({ rating: 'hold', revision_kind: 'rating_change' }, merged)
    assert.deepEqual(Object.keys($set).sort(), ['rating', 'updated_at'])
    assert.equal($set.rating, 'hold')
    assert.ok(!('price_target' in $set), 'a stale merged copy of the target must not be written back')
    assert.ok(!('revisions' in $set), 'the trail is the repo\'s $push, never a $set')
})

test('coverage: flags ride the $set only when the patch re-ran them', () => {
    const merged = { ...normalizeCoverage({ ...cur, rating: 'hold' }), flags: [{ code: 'band_contradicts_conviction', leg: null, detail: 'd' }] }
    assert.ok(!('flags' in coverageSet({ rating: 'hold' }, merged)))
    assert.deepEqual(coverageSet({ rating: 'hold' }, merged, { flagsRecomputed: true }).flags, merged.flags)
})

test('coverage: the monitor\'s verdict patch writes gap (+ status when terminal) and nothing else', () => {
    const merged = normalizeCoverage({ ...cur, gap: { our_pt: 200, consensus_pt: 180 }, status: 'target_hit' })
    const $set = coverageSet({ gap: merged.gap, status: 'target_hit', revision_kind: 'target_hit', revision_note: 'n' }, merged)
    assert.deepEqual(Object.keys($set).sort(), ['gap', 'status', 'updated_at'])
})

test('coverage: a re-model draft names every plan field, and every plan field is written', () => {
    const draft = { symbol: 'NVDA', rating: 'buy', price_target: { value: 240 }, thesis: 'v2', sector: 'Technology', catalysts: [], kill_criteria: [], conviction: { level: 'high' } }
    const merged = normalizeCoverage({ ...cur, ...draft })
    const $set = coverageSet(draft, merged, { flagsRecomputed: true })
    for (const k of ['rating', 'price_target', 'thesis', 'sector', 'catalysts', 'kill_criteria', 'conviction', 'flags']) assert.ok(k in $set, k)
    assert.equal($set.price_target.value, 240)
})

// ── tilt._updateSet ──────────────────────────────────────────────────────────

const view = normalizeTilt({ id: 'tilt_1', benchmark: 'SPX', tilts: [{ sector: 'Energy', stance: 'over', active_bp: 150 }, { sector: 'Utilities', stance: 'under', active_bp: -150 }] })

test('tilt: a retire writes status + updated_at and leaves the rows alone', () => {
    const merged = normalizeTilt({ ...view, status: 'retired' })
    const $set = tiltSet({ status: 'retired', revision_kind: 'retire' }, merged)
    assert.deepEqual(Object.keys($set).sort(), ['status', 'updated_at'])
})

test('tilt: a rows patch writes the rows AND the balance verdict they imply', () => {
    const merged = normalizeTilt({ ...view, tilts: [{ sector: 'Energy', stance: 'over', active_bp: 150 }] })
    const $set = tiltSet({ tilts: merged.tilts, revision_kind: 'stance_matured' }, merged)
    assert.deepEqual(Object.keys($set).sort(), ['balanced', 'net_bp', 'tilts', 'updated_at'])
    assert.equal($set.balanced, false)   // one 150bp row does not net out
    assert.ok(!('revisions' in $set))
})
