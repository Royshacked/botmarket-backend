import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, tick, _setDeps } from '../../services/echoPipeline.service.js'
import { _tick as loopTick } from '../../monitoring/echoPipeline.monitor.service.js'

// Echo's pipeline (docs/design/echo-pipeline.md): framed → mapped → scored → (day-5 close) → checked → watching.

function deps({ map = { ok: true, map: { links: [1] } }, score = { ok: true, scores: { links: [] } }, check = { ok: true, check: { links: [] } }, open = [] } = {}) {
    const writes = []
    const calls = []
    return {
        writes, calls,
        events: { advance: async (id, status, patch) => { writes.push([id, status, patch]) }, listOpen: async () => open },
        map: async (ev, o) => { calls.push(['map', o]); return map },
        score: async () => { calls.push(['score']); return score },
        check: async () => { calls.push(['check']); return check },
    }
}

test('run: a framed event walks every step it can, writing each part', async () => {
    const d = deps(); _setDeps(d)
    const r = await run({ _id: 'e1', kind: 'user', userId: 'u1', status: 'framed' })
    assert.deepEqual(r, { status: 'watching' })
    assert.deepEqual(d.writes.map(w => w[1]), ['mapped', 'scored', 'watching'])
    assert.deepEqual(d.calls[0], ['map', { userId: 'u1' }], "a user's event is billed to them")
    assert.ok(d.writes[0][2].map && d.writes[1][2].scores && d.writes[2][2].check)
})

test('run: the check waits for the day-5 close — no error, the event stays scored', async () => {
    const d = deps({ check: { ok: false, wait: true, reason: 'the day-5 close is not in yet' } }); _setDeps(d)
    const r = await run({ _id: 'e2', kind: 'house', status: 'mapped', map: {} })
    assert.deepEqual(r, { status: 'scored', stoppedAt: 'check', reason: 'the day-5 close is not in yet', wait: true })
    assert.deepEqual(d.writes.at(-1).slice(1), ['scored', { lastError: null, waiting: 'the day-5 close is not in yet' }])
})

test('run: a failed step leaves the event where it was, with the reason', async () => {
    const d = deps({ map: { ok: false, reason: 'The model could not be reached — try again.' } }); _setDeps(d)
    const r = await run({ _id: 'e3', kind: 'house', status: 'framed' })
    assert.equal(r.status, 'framed'); assert.equal(r.stoppedAt, 'map')
    assert.equal(d.writes[0][1], 'framed')
    assert.match(d.writes[0][2].lastError.reason, /could not be reached/)
    assert.equal(d.calls.length, 1, 'no score without a map')
})

test('run: a step that throws is caught and recorded', async () => {
    const d = deps(); d.score = async () => { throw new Error('boom') }; _setDeps(d)
    const r = await run({ _id: 'e4', kind: 'house', status: 'mapped', map: {} })
    assert.equal(r.stoppedAt, 'mapped'); assert.equal(r.reason, 'boom')
})

test('tick: every open event, one at a time; the loop is opt-in', async () => {
    const d = deps({ open: [{ _id: 'a', kind: 'house', status: 'scored' }, { _id: 'b', kind: 'house', status: 'scored' }] }); _setDeps(d)
    const r = await tick()
    assert.deepEqual(r.ran.map(x => [x.id, x.status]), [['a', 'watching'], ['b', 'watching']])
    assert.deepEqual(await loopTick({ on: () => false, tick: async () => { throw new Error('must not run') } }), { off: true })
})
