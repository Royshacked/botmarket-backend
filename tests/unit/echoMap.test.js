import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SYSTEM, PROMPT_VERSION, ENGINE_PROMPT_VERSION, schema, directionFor, frameEvent, promptFor, resolve, mapUserEvent, listUserEvents,
    getUserEvent, _setDeps, COLLECTION, MAX_LINKS } from '../../services/echoMap.service.js'
import { _structuredRequest } from '../../providers/anthropic.provider.js'

// Echo's chain map for an event the user names (docs/design/echo-desk.md §3–4): the engine's mapper, ported.

const here = path.dirname(fileURLToPath(import.meta.url))
const ENGINE = path.resolve(here, '../../../aether-engine/src/aether_engine/echo/llm_map.py')

test('the system prompt is the engine\'s, word for word (when the engine is checked out beside)', { skip: !existsSync(ENGINE) && 'no engine checkout' }, () => {
    const py = readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n')
    const body = /SYSTEM = """([\s\S]*?)"""/.exec(py)[1].replace(/\\\n/g, '')
    assert.equal(SYSTEM, body)
    assert.equal(/PROMPT_VERSION = "([^"]+)"/.exec(py)[1], ENGINE_PROMPT_VERSION, 'the port copies the engine\'s current prompt version')
    assert.equal(PROMPT_VERSION, `user-${ENGINE_PROMPT_VERSION}`, 'a user map is never the forward test\'s arm')
})

test('the direction is the backtest\'s rule, both ways', () => {
    assert.equal(directionFor('supplier', 'up'), 'gains')
    assert.equal(directionFor('infrastructure', 'down'), 'loses')
    assert.equal(directionFor('substitute', 'up'), 'loses')
    assert.equal(directionFor('substitute', 'down'), 'gains')
    assert.equal(directionFor('peer', 'up'), 'unclear')
    assert.equal(directionFor('customer', 'down'), 'unclear')
    assert.equal(directionFor('supplier', 'sideways'), 'unclear')
})

test('framing: "GTA 6 is out" with an origin, and a demand with none', () => {
    const gta = frameEvent({ what_changed: 'GTA 6 released', origin: 'Take-Two Interactive', tickers: ['ttwo'], effect: 'up' }, '2026-11-19')
    assert.deepEqual(gta, { ok: true, event: { what_changed: 'GTA 6 released', origin: 'Take-Two Interactive', origin_tickers: ['TTWO'],
        effect: 'up', date: '2026-11-19', horizon: null } })
    const heat = frameEvent({ what_changed: 'Record European heatwave', origin: 'European air-conditioning demand', effect: 'up', date: '2026-07-01', horizon: 'Swing' })
    assert.equal(heat.ok, true)
    assert.deepEqual(heat.event.origin_tickers, [])
    assert.equal(heat.event.horizon, 'swing')
    assert.equal(frameEvent({ what_changed: 'BRK.B buys', origin: 'x', tickers: 'BRK.B', effect: 'down' }, 'd').event?.origin_tickers?.[0] ?? null, null,
        'a bad default date is refused, not stored')
})

test('framing refuses what it cannot map, and says why', () => {
    assert.match(frameEvent({ origin: 'x', effect: 'up' }).reason, /what_changed/)
    assert.match(frameEvent({ what_changed: 'x', effect: 'up' }).reason, /origin/)
    assert.match(frameEvent({ what_changed: 'x', origin: 'y', effect: 'both' }).reason, /up or down/)
    assert.match(frameEvent({ what_changed: 'x', origin: 'y', effect: 'up', tickers: ['not a ticker!'] }).reason, /not a ticker/)
    assert.match(frameEvent({ what_changed: 'x', origin: 'y', effect: 'up', date: '19/11/2026' }).reason, /YYYY-MM-DD/)
})

test('the prompt: an origin with tickers, a demand without', () => {
    const p = promptFor({ date: '2026-11-19', what_changed: 'GTA 6 released', origin: 'Take-Two', origin_tickers: ['TTWO'], effect: 'up' }, 'A video game publisher.')
    assert.match(p, /^Event \(2026-11-19\): GTA 6 released\.\n\nOrigin: Take-Two \(TTWO\)\. The event raises demand at the origin\.\n\nAbout the origin: A video game publisher\.\n\nMap the chain this event runs through — up to 30 links/)
    const q = promptFor({ date: 'd', what_changed: 'w', origin: 'AC demand', origin_tickers: [], effect: 'down' })
    assert.match(q, /Origin: AC demand — no single listed company; this is the demand the event moves\. The event lowers it\./)
    assert.doesNotMatch(q, /About the origin/)
})

test('the request: streamed beta, server-side fallback, the schema as the output format', () => {
    const r = _structuredRequest({ model: 'claude-opus-5-5', systemPrompt: 's', user: 'u', schema: schema(), effort: 'high', maxTokens: 64000 })
    assert.deepEqual(r.betas, ['server-side-fallback-2026-07-01'])
    assert.equal(r.fallbacks, 'default')
    assert.equal(r.max_tokens, 64000)
    assert.deepEqual(r.output_config, { effort: 'high', format: { type: 'json_schema', schema: schema() } })
})

const EV = { date: '2026-11-19', what_changed: 'GTA 6 released', origin: 'Take-Two', origin_tickers: ['TTWO'], effect: 'up' }
const PROFILES = {
    AMD:  { name: 'Advanced Micro Devices', exchange: 'NASDAQ', activelyTrading: true },
    SONY: { name: 'Sony Group', exchange: 'NYSE', activelyTrading: true },
    EA:   { name: 'Electronic Arts', exchange: 'NASDAQ', activelyTrading: true },
    NTDOY:{ name: 'Nintendo', exchange: 'OTC', activelyTrading: true },
    GONE: { name: 'Gone Inc', exchange: 'NYSE', activelyTrading: false },
}
const profileOf = async (t) => PROFILES[t] ?? null
const raw = (ticker, relation, direction = 'gains') => ({ name: ticker, ticker, relation, direction, why: `${ticker} link`, confidence: 'high' })

test('resolve: US listings kept with the rule\'s direction; the rest dropped with the reason', async () => {
    const { links, dropped } = await resolve(EV, [
        raw('AMD', 'supplier', 'loses'), raw('SONY', 'customer'), raw('EA', 'substitute', 'gains'), raw('ttwo', 'peer'),
        raw('AMD', 'supplier'), raw('NTDOY', 'peer'), raw('GONE', 'supplier'), raw('ZZZZ', 'supplier'), raw('X', 'friend'), { ...raw('', 'supplier') },
    ], profileOf, '2026-11-19', 'claude-opus-5-5')
    assert.deepEqual(links.map(l => [l.ticker, l.relation, l.direction, l.layer]), [
        ['AMD', 'supplier', 'gains', 2], ['SONY', 'customer', 'unclear', 1], ['EA', 'substitute', 'loses', 1]])
    assert.match(links[0].note, /model's direction loses; FMP: Advanced Micro Devices/)
    assert.equal(links[0].evidence_ref, `claude-opus-5-5 · prompt ${PROMPT_VERSION}`)
    assert.deepEqual(dropped.map(d => d.reason), ['origin or duplicate', 'origin or duplicate', 'not an active US listing (OTC)',
        'not an active US listing (NYSE)', 'no FMP profile', 'relation', 'no ticker'])
})

test('resolve: at most MAX_LINKS read', async () => {
    const many = Array.from({ length: MAX_LINKS + 5 }, (_, i) => raw(`T${i}`, 'supplier'))
    const { links } = await resolve(EV, many, async () => ({ name: 'x', exchange: 'NYSE' }), 'd')
    assert.equal(links.length, MAX_LINKS)
})

function fakeDb() {
    const rows = []
    return { rows, collection(name) {
        assert.equal(name, COLLECTION)
        return {
            async insertOne(d) { rows.push(d) },
            find(q) { let out = rows.filter(r => r.userId === q.userId); const c = { sort() { out = [...out].reverse(); return c }, limit() { return c }, async toArray() { return out } }; return c },
            async findOne(q) { return rows.find(r => r._id === q._id && r.userId === q.userId) ?? null },
        }
    } }
}

test('mapUserEvent: one call, the served model stored and costed, the map saved under the user', async () => {
    const db = fakeDb(), calls = [], usage = []
    _setDeps({
        db, now: () => new Date('2026-11-19T12:00:00Z'), id: () => 'ue_1',
        profile: async (t) => (t === 'TTWO' ? { name: 'Take-Two', exchange: 'NASDAQ', description: 'Publisher of GTA.' } : PROFILES[t] ?? null),
        call: async (args) => { calls.push(args); args.onUsage({ input_tokens: 10 }, 'claude-opus-5-5'); return { data: { links: [raw('AMD', 'supplier'), raw('EA', 'substitute')] }, model: 'claude-opus-5-5', stopReason: 'end_turn' } },
        record: async (...a) => { usage.push(a) },
    })
    const r = await mapUserEvent({ what_changed: 'GTA 6 released', origin: 'Take-Two', tickers: ['TTWO'], effect: 'up' }, { userId: 'u1' })
    assert.equal(r.ok, true)
    assert.equal(calls.length, 1)
    assert.match(calls[0].user, /About the origin: Publisher of GTA\./)
    assert.equal(calls[0].systemPrompt, SYSTEM)
    assert.deepEqual(usage[0].slice(0, 2), ['u1', 'claude-opus-5-5'])
    assert.equal(usage[0][3], 'echo')
    assert.equal(db.rows.length, 1)
    assert.deepEqual(db.rows[0].map.links.map(l => [l.ticker, l.direction]), [['AMD', 'gains'], ['EA', 'loses']])
    assert.equal(db.rows[0].kind, 'user')
    assert.equal(db.rows[0].event.date, '2026-11-19', 'no date → today')
    assert.equal((await getUserEvent('ue_1', 'u1'))._id, 'ue_1')
    assert.equal(await getUserEvent('ue_1', 'someone-else'), null, 'another user\'s event is not found')
    assert.equal((await listUserEvents('u1')).length, 1)
})

test('mapUserEvent: a refused frame, a failed call, no answer — nothing stored, a reason given', async () => {
    const db = fakeDb()
    _setDeps({ db, profile: async () => null, record: async () => {} })
    assert.match((await mapUserEvent({ origin: 'x', effect: 'up' }, { userId: 'u1' })).reason, /what_changed/)
    _setDeps({ call: async () => { throw new Error('overloaded') } })
    assert.match((await mapUserEvent({ what_changed: 'w', origin: 'o', effect: 'up' }, { userId: 'u1' })).reason, /could not be reached/)
    _setDeps({ call: async () => ({ data: null, model: 'm', stopReason: 'max_tokens' }) })
    assert.match((await mapUserEvent({ what_changed: 'w', origin: 'o', effect: 'up' }, { userId: 'u1' })).reason, /max_tokens/)
    assert.equal((await mapUserEvent({ what_changed: 'w', origin: 'o', effect: 'up' }, {})).reason, 'no user')
    assert.equal(db.rows.length, 0)
})

test('an empty map is an answer, and is stored', async () => {
    const db = fakeDb()
    _setDeps({ db, profile: async () => null, record: async () => {}, call: async () => ({ data: { links: [] }, model: 'm', stopReason: 'end_turn' }) })
    const r = await mapUserEvent({ what_changed: 'w', origin: 'o', effect: 'down' }, { userId: 'u1' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.doc.map.links, [])
})
