import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEchoHandlers, recordWords, eventLine, linkLine, mapWords } from '../../services/tools/echo.tools.js'
import { isToolError, toolErrorText } from '../../services/toolResult.util.js'

// Echo's tools (docs/design/echo-desk.md §5): the forward test read as the record, never the verdict; the user's own
// events theirs alone; a map's direction said to be the rule's.

const RECORD = { 20: { n: 2, mean: 0.012, positive: 0.5 }, 60: { n: 0 }, 120: { n: 0 }, verdictAt: 30, gradedAt120: 0 }
const link = (ticker, extra = {}) => ({ ticker, name: `${ticker} Inc.`, relation: 'supplier', layer: 2, direction: 'loses',
    why: `${ticker} builds for the origin.`, note: "confidence high; model's direction gains; FMP: x", group: null, spread: {}, ...extra })
const CSCO = { id: 'csco-earnings-2026-11-12', date: '2026-11-12', origin: 'Cisco', tickers: ['CSCO'], effect: 'down', size: 'Day 0 move -5.9% vs SPY',
    status: 'checked', links: 29, flagged: [link('JBL', { group: 'flagged' })], spread: { 20: 0.03 } }
const USER_DOC = { _id: 'ue_1', userId: 'u1', event: { date: '2026-11-19', what_changed: 'GTA 6 released', origin: 'Take-Two', origin_tickers: ['TTWO'], effect: 'up' },
    map: { model: 'claude-opus-5-5', prompt_version: 'user-2026-11-19', links: [{ ...link('AMD'), direction: 'gains', evidence_text: 'AMD makes the console chips.' }], dropped: [{ ticker: 'EA', reason: 'not an active US listing (NASDAQ)' }] } }

test('the record is never called the verdict, and says when the verdict reads', () => {
    const w = recordWords(RECORD)
    assert.match(w, /^So far — 20 sessions: \+1\.2% mean over 2 events, 50% positive\./)
    assert.match(w, /NOT the verdict: the pre-declared rule reads ONCE, on the first 30 events graded at 120 sessions \(0 so far\)/)
    assert.match(recordWords({ ...RECORD, 20: { n: 0 } }), /^Nothing graded yet\./)
})

test('an event line carries where it stands and its lagging links', () => {
    const l = eventLine(CSCO)
    assert.match(l, /^csco-earnings-2026-11-12 — 2026-11-12 · CSCO down/)
    assert.match(l, /checked at day 5, being graded · 29 links · lagging vs stand-ins 20d \+3\.0%/)
    assert.match(l, /lagging at day 5: JBL \(supplier, loses\)/)
})

test('a link line says when the model read it the other way', () => {
    assert.match(linkLine(link('JBL')), /supplier, layer 2, loses \(the model said gains\): JBL builds for the origin\./)
    assert.doesNotMatch(linkLine(link('JBL', { note: "model's direction loses" })), /the model said/)
    assert.match(linkLine(link('JBL', { group: 'flagged', reaction: 0.01, spread: { 20: 0.03 } })), /day 5 LAGGING \(\+1\.0%\), 20d \+3\.0% vs stand-ins/)
})

test('a user map says it is not the forward test, the rule, and what was dropped', () => {
    const w = mapWords({ id: 'ue_1', kind: 'user', event: USER_DOC.event, map: { ...USER_DOC.map, links: USER_DOC.map.links.map(l => ({ ...l, why: l.evidence_text })) } })
    assert.match(w, /not part of the forward test; no market check, no grades/)
    assert.match(w, /Origin: Take-Two \(TTWO\); effect up\./)
    assert.match(w, /suppliers and infrastructure move WITH the origin \(gain\)/)
    assert.match(w, /- AMD \(AMD Inc\.\) — supplier, layer 2, gains: AMD makes the console chips\./)
    assert.match(w, /Dropped \(1\): EA — not an active US listing \(NASDAQ\)/)
})

const events = { listEvents: async () => ({ events: [CSCO], record: RECORD }), getEvent: async (id) => (id === CSCO.id ? { ...CSCO, event: { date: CSCO.date, what_changed: 'Cisco results', origin: 'Cisco', origin_tickers: ['CSCO'], effect: 'down' }, map: { model: 'claude-opus-5-5', promptVersion: '2026-11-19', dropped: [] }, all: [link('JBL', { group: 'flagged' })] } : null) }
const maps = (docs = [USER_DOC]) => ({
    listUserEvents: async (u) => docs.filter(d => d.userId === u),
    getUserEvent: async (id, u) => docs.find(d => d._id === id && d.userId === u) ?? null,
    mapUserEvent: async (args, { userId }) => (args.effect ? { ok: true, doc: { ...USER_DOC, userId } } : { ok: false, reason: 'effect must be up or down' }),
})

test('get_echo_events: the forward test, the record, and only THIS user\'s events', async () => {
    const mine = await makeEchoHandlers({ userId: 'u1', events, maps: maps() }).get_echo_events({})
    assert.match(mine, /FORWARD TEST — 1 events/)
    assert.match(mine, /NOT the verdict/)
    assert.match(mine, /THE USER'S OWN EVENTS \(1\):\nue_1 — 2026-11-19 · GTA 6 released · 1 links/)
    const theirs = await makeEchoHandlers({ userId: 'u2', events, maps: maps() }).get_echo_events({})
    assert.match(theirs, /The user has no events of their own yet\./)
})

test('get_event_map: a forward-test id, a user id, another user\'s id, nothing', async () => {
    const h = makeEchoHandlers({ userId: 'u1', events, maps: maps() })
    assert.match(await h.get_event_map({ id: CSCO.id }), /forward-test event\nEvent \(2026-11-12\): Cisco results\./)
    assert.match(await h.get_event_map({ id: 'ue_1' }), /the user's event/)
    const other = await makeEchoHandlers({ userId: 'u2', events, maps: maps() }).get_event_map({ id: 'ue_1' })
    assert.ok(isToolError(other)); assert.match(toolErrorText(other), /No event ue_1 among the user's events/)
    assert.ok(isToolError(await h.get_event_map({ id: 'nope-earnings-2026-01-01' })))
    assert.ok(isToolError(await h.get_event_map({})))
})

test('map_event: the map in words; a refused frame is an error the model reads; no user, no map', async () => {
    const h = makeEchoHandlers({ userId: 'u1', events, maps: maps() })
    assert.match(await h.map_event({ what_changed: 'GTA 6 released', origin: 'Take-Two', tickers: ['TTWO'], effect: 'up' }), /ue_1 — the user's event/)
    const bad = await h.map_event({ what_changed: 'x', origin: 'y' })
    assert.ok(isToolError(bad)); assert.match(toolErrorText(bad), /up or down/)
    assert.ok(isToolError(await makeEchoHandlers({ userId: null, events, maps: maps() }).map_event({ effect: 'up' })))
})
