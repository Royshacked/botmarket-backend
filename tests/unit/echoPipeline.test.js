import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, tick, nextClose, MAX_ATTEMPTS, _setDeps } from '../../services/echoPipeline.service.js'
import { _tick as loopTick, _reset as resetLoop } from '../../monitoring/echoPipeline.monitor.service.js'

// Echo's pipeline (docs/design/echo-pipeline.md): framed → mapped → scored → (day-5 close) → watching — one run at a time
// per event, a failure backing off and giving up, a wait sleeping until the next close.

const NOW = new Date('2026-11-19T15:00:00Z')   // a Thursday
function deps({ map = { ok: true, map: { links: [1] } }, score = { ok: true, scores: { links: [] } }, check = { ok: true, check: { links: [] } }, open = [], watching = [], gradable = [], claimed = true } = {}) {
    const writes = []
    const calls = []
    return {
        writes, calls, now: () => NOW,
        events: {
            advance: async (id, status, patch = {}) => { writes.push([id, status, patch]) },
            claim: async (id) => (claimed ? { _id: id } : null),
            listOpen: async () => open, listWatching: async () => watching, listGradable: async () => gradable,
        },
        watch: async (ev) => { calls.push(['watch', ev._id]); return { id: ev._id, triggers: 0, expired: false } },
        grade: async (ev) => { calls.push(['grade', ev._id]); return { graded: [5] } },
        map: async (ev, o) => { calls.push(['map', o]); return map },
        score: async () => { calls.push(['score']); return score },
        check: async () => { calls.push(['check']); return check },
    }
}

test("run: the house's framed event walks every step it can, writing each part", async () => {
    const d = deps(); _setDeps(d)
    const r = await run({ _id: 'e1', kind: 'house', status: 'framed' })
    assert.deepEqual(r, { status: 'watching' })
    assert.deepEqual(d.writes.map(w => w[1]), ['mapped', 'scored', 'watching'])
    assert.deepEqual(d.calls[0], ['map', { userId: null }])
    assert.ok(d.writes[0][2].map && d.writes[1][2].scores && d.writes[2][2].check)
    assert.equal(d.writes[0][2].attempts, 0)
})

test("run: a user's own event (the filter did not take it) is checked at day 5 and stops — no watch", async () => {
    const d = deps(); _setDeps(d)
    const r = await run({ _id: 'u1e', kind: 'user', userId: 'u1', status: 'scored', map: {}, scores: {} })
    assert.equal(r.status, 'expired')
    assert.match(d.writes.at(-1)[2].expiredBecause, /checked at day 5, no watch/)
})

test('run: a run already holding the event is left alone (chat and the tick never map one twice)', async () => {
    const d = deps({ claimed: false }); _setDeps(d)
    const r = await run({ _id: 'e0', kind: 'house', status: 'framed' })
    assert.equal(r.stoppedAt, 'claim')
    assert.equal(d.calls.length, 0, 'no paid call')
})

test('run: the check waits for the day-5 close — no error, asleep until the next close', async () => {
    const d = deps({ check: { ok: false, wait: true, reason: 'the day-5 close is not in yet' } }); _setDeps(d)
    const r = await run({ _id: 'e2', kind: 'house', status: 'mapped', map: {} })
    assert.deepEqual(r, { status: 'scored', stoppedAt: 'check', reason: 'the day-5 close is not in yet', wait: true })
    const last = d.writes.at(-1)
    assert.equal(last[1], 'scored')
    assert.equal(last[2].lastError, null); assert.equal(last[2].waiting, 'the day-5 close is not in yet')
    assert.equal(last[2].nextRunAt, '2026-11-19T21:45:00.000Z')
})

test('run: a failed step backs off — 1, 2, 4, 8 hours — and gives up after the fifth (no paid call every hour for ever)', async () => {
    const d = deps({ score: { ok: false, reason: 'No scores came back (max_tokens) — try again.' } }); _setDeps(d)
    const r1 = await run({ _id: 'e3', kind: 'house', status: 'mapped', map: {}, attempts: 0 })
    assert.equal(r1.stoppedAt, 'score')
    assert.equal(d.writes.at(-1)[2].attempts, 1)
    assert.equal(d.writes.at(-1)[2].nextRunAt, '2026-11-19T16:00:00.000Z', 'an hour on')
    await run({ _id: 'e3', kind: 'house', status: 'mapped', map: {}, attempts: 3 })
    assert.equal(d.writes.at(-1)[2].nextRunAt, '2026-11-19T23:00:00.000Z', 'the fourth failure: eight hours on')
    const last = await run({ _id: 'e3', kind: 'house', status: 'mapped', map: {}, attempts: MAX_ATTEMPTS - 1 })
    assert.equal(last.gaveUp, true)
    assert.equal(d.writes.at(-1)[2].gaveUp, true)
})

test('run: a step that throws is caught and recorded, and backs off', async () => {
    const d = deps(); d.score = async () => { throw new Error('boom') }; _setDeps(d)
    const r = await run({ _id: 'e4', kind: 'house', status: 'mapped', map: {} })
    assert.equal(r.stoppedAt, 'mapped'); assert.equal(r.reason, 'boom')
    assert.equal(d.writes.at(-1)[2].attempts, 1)
})

test('the next close: 21:45 UTC on a weekday', () => {
    assert.equal(nextClose(new Date('2026-11-19T15:00:00Z')).toISOString(), '2026-11-19T21:45:00.000Z')
    assert.equal(nextClose(new Date('2026-11-20T22:00:00Z')).toISOString(), '2026-11-23T21:45:00.000Z', 'Friday night → Monday')
})

test('tick: every open event, one at a time; the loop is opt-in', async () => {
    const d = deps({ open: [{ _id: 'a', kind: 'house', status: 'scored' }, { _id: 'b', kind: 'house', status: 'scored' }] }); _setDeps(d)
    const r = await tick()
    assert.deepEqual(r.ran.map(x => [x.id, x.status]), [['a', 'watching'], ['b', 'watching']])
    assert.deepEqual(await loopTick({ on: () => false, tick: async () => { throw new Error('must not run') } }), { off: true })
})

test('tick: the wave watch on watched events, once a day each', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const d = deps({ watching: [{ _id: 'w1', status: 'watching' }, { _id: 'w2', status: 'watching', watchedAt: recent }] }); _setDeps(d)
    const r = await tick()
    assert.deepEqual(r.watched.map(w => w.id), ['w1'], 'w2 was watched two hours ago')
})

test('tick: the grades that came due, once a day an event — expired ones too', async () => {
    const d = deps({ gradable: [{ _id: 'g1', status: 'expired' }, { _id: 'g2', status: 'watching', gradedAt: new Date().toISOString() }] }); _setDeps(d)
    const r = await tick()
    assert.deepEqual(r.graded, [{ id: 'g1', horizons: [5] }])
})

test('the loop: the intake every 3 hours, the steps every hour', async () => {
    resetLoop()
    let t = 0, intakes = 0
    const loopDeps = { on: () => true, now: () => t, intake: async () => { intakes++; return { events: [] } }, tick: async () => ({ ran: [] }) }
    await loopTick(loopDeps); t += 60 * 60 * 1000
    await loopTick(loopDeps); t += 2 * 60 * 60 * 1000
    await loopTick(loopDeps)
    assert.equal(intakes, 2, 'at boot, then three hours later')
    loopDeps.intake = async () => { throw new Error('sources down') }
    t += 3 * 60 * 60 * 1000
    assert.deepEqual(await loopTick(loopDeps), { intake: null, ran: [] }, 'a failed intake does not stop the steps')
})
