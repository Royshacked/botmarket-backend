import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frame, passesFilter, create, get, advance, list, _setDeps } from '../../services/echoEvents.service.js'

// Echo's event (docs/design/echo-pipeline.md Step 1): the doc's fields, its filter, one collection for house and user.

const GTA = { what_changed: 'GTA 6 released', origin: 'Take-Two', tickers: ['ttwo'], effect: 'up', type: 'demand_shock',
    durability: { kind: 'price_spike', why: 'a launch: one season of sales' }, date: '2026-11-19', terms: ['Take-Two', 'Rockstar'],
    filter: { surprise: true, large: true, lasting: false, why: 'a dated launch, known for years' } }

test('frame: the doc fields, tidied', () => {
    const r = frame(GTA)
    assert.equal(r.ok, true)
    assert.deepEqual(r.event.originTickers, ['TTWO'])
    assert.deepEqual(r.event.durability, { kind: 'price_spike', why: 'a launch: one season of sales' })
    assert.equal(r.event.timing, 'after_close', 'unknown timing counts from the next open — never before the news')
    assert.deepEqual(r.event.terms, ['Take-Two', 'Rockstar'])
    assert.equal(r.event.filter.lasting, false)
})

test('frame refuses what the doc requires, and says which field', () => {
    assert.match(frame({ ...GTA, what_changed: '' }).reason, /what_changed/)
    assert.match(frame({ ...GTA, effect: 'sideways' }).reason, /up, down or mixed/)
    assert.match(frame({ ...GTA, type: 'rumour' }).reason, /type must be one of/)
    assert.match(frame({ ...GTA, durability: 'forever' }).reason, /durability must be one of/)
    assert.match(frame({ ...GTA, tickers: ['not a ticker'] }).reason, /not a ticker/)
    assert.match(frame({ ...GTA, date: '19/11/2026' }).reason, /YYYY-MM-DD/)
    assert.equal(frame({ ...GTA, effect: 'mixed', type: 'geopolitical', tickers: [] }).ok, true, 'a country, a mixed effect')
})

test("the filter: a surprise, large AND lasting — the doc's three, all yes", () => {
    assert.equal(passesFilter(frame(GTA).event), false)
    assert.equal(passesFilter(frame({ ...GTA, filter: { surprise: true, large: true, lasting: true } }).event), true)
    assert.equal(passesFilter({}), false)
})

function fakeDb() {
    const docs = []
    return { docs, collection: () => ({
        insertOne: async (d) => { docs.push(d) },
        findOne: async (q) => docs.find(d => d._id === q._id) ?? null,
        updateOne: async (q, u) => { Object.assign(docs.find(d => d._id === q._id), u.$set) },
        find: (q) => {
            const ok = (d) => q.$or.some(c => Object.entries(c).every(([k, v]) => d[k] === v)) && (!q.status || (q.status.$in ? q.status.$in.includes(d.status) : d.status === q.status))
            let out = docs.filter(ok)
            const c = { sort: () => c, limit: (n) => { out = out.slice(0, n); return c }, toArray: async () => out }
            return c
        },
    }) }
}

test("store: the house's for everyone, a user's for them only; each step moves the status", async () => {
    const db = fakeDb()
    let n = 0
    _setDeps({ db, id: () => `ev_${++n}`, now: () => new Date('2026-11-19T12:00:00Z') })
    const house = await create(frame({ ...GTA, origin: 'Cisco' }).event, { source: 'earnings' })
    const mine = await create(frame(GTA).event, { userId: 'u1' })
    assert.equal(house.kind, 'house'); assert.equal(mine.kind, 'user'); assert.equal(mine.status, 'framed')
    assert.ok(await get('ev_2', 'u1'))
    assert.equal(await get('ev_2', 'u2'), null, "another user's event is not theirs to read")
    assert.ok(await get('ev_1', null), "the house's is everyone's")
    await advance('ev_2', 'mapped', { map: { links: [] } })
    assert.equal(db.docs[1].status, 'mapped')
    await assert.rejects(advance('ev_2', 'done'), /unknown status/)
    assert.deepEqual((await list({ userId: 'u2' })).map(d => d._id), ['ev_1'])
    assert.deepEqual((await list({ userId: 'u1' })).map(d => d._id).sort(), ['ev_1', 'ev_2'])
})
