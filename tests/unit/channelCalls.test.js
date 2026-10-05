import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    planCallSync, newCall, dueMarks, trackRecord, formatRecord, syncCallLedger, gradeChannelCalls, _setCallsIO,
    HORIZON_WEEKS, MIN_GRADED, PLACEHOLDER_CONFIDENCE,
} from '../../api/strategy/channelCalls.service.js'

// The call ledger: each channel call graded against what the channel then did. What must hold — a
// restated call keeps its clock, a revised one is still graded, marks are judged on the departure
// from the base rate, and the record only replaces the placeholder once there is enough of it.

const DAY = 24 * 60 * 60 * 1000
const SET = '2026-01-02T00:00:00.000Z'
const SET_MS = Date.parse(SET)
const call = (over = {}) => ({ _id: 'c1', channel_id: 'discount_rate', dz: -0.5, base_dz: -1.8, deviation: 1.3, set_at: SET, marks: {}, graded: false, active: true, ...over })

// A weekly grid from the call: z falls `perWeek` each Friday from 4.0.
const grid = (perWeek, weeks = 30) => Array.from({ length: weeks + 1 }, (_, i) => ({ t: SET_MS + i * 7 * DAY, z: 4.0 + perWeek * i }))

// ── sync ─────────────────────────────────────────────────────────────────────

test('a call restated with the same dz is the same call; a changed dz supersedes and starts a new one', () => {
    const held = [call(), call({ _id: 'c2', channel_id: 'energy_cost', dz: 0.4 })]
    const plan = planCallSync([{ channel_id: 'discount_rate', dz: -0.5 }, { channel_id: 'energy_cost', dz: -0.2 }], held)
    assert.deepEqual(plan.reaffirm.map(r => r.call._id), ['c1'])
    assert.deepEqual(plan.supersede.map(c => c._id), ['c2'])
    assert.deepEqual(plan.create.map(v => v.channel_id), ['energy_cost'])
})

test('a call dropped from the view is superseded — and stays in the ledger to be graded', () => {
    const plan = planCallSync([], [call()])
    assert.deepEqual(plan.supersede.map(c => c._id), ['c1'])
    assert.equal(plan.create.length, 0)
})

test('a call past its six months is never reaffirmed — the same dz restated after it is a new forecast', () => {
    const matured = call({ matures_at: new Date(SET_MS + HORIZON_WEEKS * 7 * DAY).toISOString() })
    const later = SET_MS + 30 * 7 * DAY
    const plan = planCallSync([{ channel_id: 'discount_rate', dz: -0.5 }], [matured], later)
    assert.equal(plan.reaffirm.length, 0, 'its clock has run out; reaffirming would leave the restatement ungraded')
    assert.deepEqual(plan.supersede.map(c => c._id), ['c1'])
    assert.deepEqual(plan.create.map(v => v.channel_id), ['discount_rate'])
    // ...and a call already graded is matured even if its date says otherwise.
    const graded = planCallSync([{ channel_id: 'discount_rate', dz: -0.5 }], [call({ graded: true })], SET_MS + DAY)
    assert.equal(graded.reaffirm.length, 0)
    // Before maturity, the same dz is still the same call.
    const early = planCallSync([{ channel_id: 'discount_rate', dz: -0.5 }], [matured], SET_MS + 10 * 7 * DAY)
    assert.deepEqual(early.reaffirm.map(r => r.call._id), ['c1'])
})

test('a new ledger entry carries its six-month maturity and the deviation it was sized on', () => {
    const c = newCall({ channel_id: 'discount_rate', dz: -0.5, base_dz: -1.8, z_at_set: 3.97, set_at: SET }, 'tilt_1', SET)
    assert.equal(c.matures_at, new Date(SET_MS + HORIZON_WEEKS * 7 * DAY).toISOString())
    assert.equal(c.deviation, 1.3)
    assert.deepEqual(c.tilt_ids, ['tilt_1'])
})

// ── marks ────────────────────────────────────────────────────────────────────

test('marks are written at 4, 13 and 26 weeks as their dates pass', () => {
    const g = grid(-0.02)
    assert.deepEqual(Object.keys(dueMarks(call(), g, SET_MS + 3 * 7 * DAY)), [])
    assert.deepEqual(Object.keys(dueMarks(call(), g, SET_MS + 5 * 7 * DAY)), ['4'])
    const all = dueMarks(call(), g, SET_MS + 27 * 7 * DAY)
    assert.deepEqual(Object.keys(all), ['4', '13', '26'])
    assert.equal(all[26].final, true)
    assert.equal(dueMarks(call({ marks: { 4: {} } }), g, SET_MS + 5 * 7 * DAY)[4], undefined, 'a mark is written once')
})

test('a call that departed the right way beats the base rate', () => {
    // Called -0.5 against a base of -1.8: "less reversion than usual". The channel fell only 0.52.
    const m = dueMarks(call(), grid(-0.02), SET_MS + 27 * 7 * DAY)[26]
    assert.equal(m.actual_dz, -0.52)
    assert.equal(m.beat_base, true)
    assert.equal(m.direction_right, true)
})

test('a call the base rate beat is marked so', () => {
    // The channel fell 2.6 — the base rate's -1.8 was closer than the call's -0.5.
    const m = dueMarks(call(), grid(-0.1), SET_MS + 27 * 7 * DAY)[26]
    assert.equal(m.beat_base, false)
    assert.equal(m.direction_right, false)
})

test('an interim mark is judged against the pro-rated call and base rate', () => {
    const m = dueMarks(call(), grid(-0.02), SET_MS + 14 * 7 * DAY)[13]
    assert.equal(m.expected_dz, -0.25)
    assert.equal(m.base_expected_dz, -0.9)
    assert.equal(m.final, false)
})

test('a mark waits for its data rather than grading against a stale week', () => {
    // The grid stops at week 10 (it lags); week 13 is past but has no reading yet.
    assert.equal(dueMarks(call(), grid(-0.02, 10), SET_MS + 20 * 7 * DAY)[13], undefined)
})

// ── the record ───────────────────────────────────────────────────────────────

const graded = (beat) => call({ graded: true, marks: { 26: { weeks: 26, beat_base: beat, direction_right: beat } } })

test('the placeholder stands until enough calls are graded', () => {
    const r = trackRecord([graded(true), graded(true), graded(false)])
    assert.equal(r.graded, 3)
    assert.equal(r.measured, false)
    assert.equal(r.confidence, PLACEHOLDER_CONFIDENCE)
})

test('a measured record maps to confidence: 70% matches the placeholder, a coin flip earns nothing', () => {
    const of = (hits, n) => trackRecord(Array.from({ length: n }, (_, i) => graded(i < hits)))
    assert.equal(of(7, 10).confidence, 0.4)
    assert.equal(of(5, 10).confidence, 0)
    assert.equal(of(3, 10).confidence, 0, 'worse than a coin is clamped, not negative')
    assert.equal(of(17, 20).confidence, 0.7)
    assert.ok(of(7, 10).measured && MIN_GRADED === 10)
})

test('interim marks are reported, not counted', () => {
    const r = trackRecord([call({ marks: { 4: { weeks: 4, beat_base: true, direction_right: true } } })])
    assert.equal(r.graded, 0)
    assert.deepEqual(r.interim.map(i => [i.channel_id, i.weeks, i.beat_base]), [['discount_rate', 4, true]])
    assert.match(formatRecord(r), /discount_rate \(call -0\.5z\) at 4w: AHEAD of the base rate, moving the way you called/)
    assert.match(formatRecord(r), /placeholder until 10 calls are graded/)
})

// ── the hooks ────────────────────────────────────────────────────────────────

function fakeLedger(docs = []) {
    const store = new Map(docs.map(d => [d._id, structuredClone(d)]))
    const match = (d, q) => Object.entries(q).every(([k, v]) => d[k] === v)
    return {
        store,
        coll: async () => ({
            find: (q) => ({ toArray: async () => [...store.values()].filter(d => match(d, q)) }),
            insertOne: async (d) => { store.set(d._id, structuredClone(d)) },
            updateOne: async ({ _id }, u) => {
                const d = store.get(_id)
                for (const [k, v] of Object.entries(u.$set ?? {})) {
                    const [a, b] = k.split('.')
                    if (b) (d[a] ??= {})[b] = v
                    else d[k] = v
                }
                for (const [k, v] of Object.entries(u.$addToSet ?? {})) if (!d[k].includes(v)) d[k].push(v)
            },
        }),
    }
}

test('publishing a restated call keeps its original clock on the stored view', async () => {
    const ledger = fakeLedger([call({ z_at_set: 3.99, tilt_ids: ['tilt_1'] })])
    _setCallsIO({ coll: ledger.coll })
    const doc = { id: 'tilt_2', channel_views: [{ channel_id: 'discount_rate', dz: -0.5, set_at: '2026-03-01T00:00:00.000Z', z_at_set: 3.1 }] }
    await syncCallLedger(doc, '2026-03-01T00:00:00.000Z')
    assert.equal(doc.channel_views[0].set_at, SET, 'the date the call was MADE, not restated')
    assert.equal(doc.channel_views[0].z_at_set, 3.99)
    assert.equal(doc.channel_views[0].call_id, 'c1')
    assert.deepEqual(ledger.store.get('c1').tilt_ids, ['tilt_1', 'tilt_2'], 'the call now spans both views')
})

test('a view published with NO calls retires every standing call', async () => {
    // Otherwise a call dropped for months and then restated at the same dz is picked back up on its
    // old clock, as if it had stood the whole time.
    const ledger = fakeLedger([call({ tilt_ids: ['tilt_1'] })])
    _setCallsIO({ coll: ledger.coll })
    const doc = { id: 'tilt_2', tilts: [] }
    await syncCallLedger(doc, '2026-03-01T00:00:00.000Z')
    assert.equal(ledger.store.get('c1').active, false)
    assert.equal(ledger.store.get('c1').superseded_at, '2026-03-01T00:00:00.000Z')
})

test('grading writes the due marks and closes a call at its six-month mark', async () => {
    const ledger = fakeLedger([call({ tilt_ids: [] })])
    _setCallsIO({ coll: ledger.coll, grid: async () => grid(-0.02).map(p => ({ date: new Date(p.t), z_score: p.z })) })
    const n = await gradeChannelCalls(SET_MS + 27 * 7 * DAY)
    assert.equal(n, 3)
    const c = ledger.store.get('c1')
    assert.equal(c.graded, true)
    assert.equal(c.marks[26].beat_base, true)
})

test('a ledger failure never throws out of either hook', async () => {
    _setCallsIO({ coll: async () => { throw new Error('mongo down') } })
    const doc = { id: 't', channel_views: [{ channel_id: 'x', dz: 1 }] }
    assert.equal(await syncCallLedger(doc), doc)
    assert.equal(await gradeChannelCalls(Date.now()), 0)
})

// ── the board read ───────────────────────────────────────────────────────────
test('the board gets each standing call\'s latest mark, and a call with no ledger entry has none', async () => {
    const { callsForBoard } = await import('../../api/strategy/channelCalls.service.js')
    const ledger = [call({ _id: 'c1', marks: { 4: { weeks: 4, beat_base: true }, 13: { weeks: 13, beat_base: false } } })]
    const view = { channel_views: [{ channel_id: 'discount_rate', call_id: 'c1' }, { channel_id: 'energy_cost' }] }
    const out = callsForBoard(view, ledger)
    assert.equal(out.calls.discount_rate.latest_mark.weeks, 13, 'the most recent mark')
    assert.equal(out.calls.energy_cost.latest_mark, null)
    assert.equal(out.record.graded, 0)
})
