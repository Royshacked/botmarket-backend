import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shapeSummary, shapeEvent, listEvents, getEvent, EVENT_ID, _setDeps } from '../../services/echo.service.js'

// Echo, read (docs/design/echo-pipeline.md "The app"): the pipeline's events shaped for the Hotlist and the desk.

import { ID, DOC } from '../fixtures/echoEvent.fixture.js'

test('the event id is the pipeline\'s', () => {
    assert.ok(EVENT_ID.test(ID))
    assert.ok(!EVENT_ID.test('csco-earnings-2026-11-12'), 'the old forward-test ids are not read any more')
})

test('a summary: the top scores and the flags', () => {
    const s = shapeSummary(DOC)
    assert.equal(s.links, 3); assert.equal(s.high, 1, 'Vertiv, 9 of 12')
    assert.deepEqual(s.flagged, [{ ticker: 'FN', flag: 'overreacted_loser', total: undefined }])
    assert.deepEqual(s.top, [{ ticker: 'PLUS', total: 6 }, { ticker: 'FN', total: 5 }, { ticker: 'VRT', total: 9 }])
    assert.deepEqual(s.graded, [5])
    assert.equal(s.mine, false)
})

test('an event whole: every link with its map line, score, check and grades — flags first, then by score', () => {
    const e = shapeEvent(DOC)
    assert.deepEqual(e.links.map(l => l.ticker), ['FN', 'VRT', 'PLUS'])
    assert.equal(e.links[0].flag, 'overreacted_loser')
    assert.equal(e.links[0].filings.share.share, 0.199)
    assert.equal(e.links[0].grades[5], 0.04)
    assert.equal(e.links[1].high, true)
    assert.equal(e.links[2].check.signedMove, undefined)
    assert.equal(e.event.durability.why, 'one quarter')
    assert.equal(e.checked.yardstick.median, 0.03)
    assert.equal(e.map.dropped.length, 1)
    assert.equal(e.triggers.length, 1)
})

test('list and get: the house\'s for everyone, a user\'s for them; the validation report alongside', async () => {
    const asked = []
    _setDeps({
        events: { list: async (q) => { asked.push(q); return [DOC] }, listGraded: async () => [DOC], get: async (id, u) => (id === ID ? { ...DOC, asked: u } : null) },
        report: (docs) => ({ events: docs.length, horizons: {}, factors: {}, walkForward: { ready: false, note: 'x' } }),
    })
    const r = await listEvents('u1')
    assert.equal(asked[0].userId, 'u1')
    assert.equal(r.report.events, 1)
    assert.equal(r.events[0].id, ID)
    assert.equal((await getEvent(ID, 'u1')).id, ID)
    assert.equal(await getEvent('not-an-id', 'u1'), null)
})
