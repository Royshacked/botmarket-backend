import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, withFilings, promptFor, mapEvent, schema, SYSTEM, RELATIONS, _setDeps } from '../../services/echoChain.service.js'
import { frame } from '../../services/echoEvents.service.js'

// Echo Step 2 — chain mapping to the simulator doc (docs/design/echo-pipeline.md).

const CSCO = frame({ what_changed: 'Cisco guided next-quarter revenue below estimates', origin: 'Cisco Systems, Inc.', tickers: ['CSCO'],
    effect: 'down', type: 'demand_shock', durability: { kind: 'price_spike', why: 'one quarter' }, date: '2026-11-12', size: 'Day 0 -5.9% vs SPY' }).event
const PROFILES = {
    CSCO: { name: 'Cisco Systems, Inc.', exchange: 'NASDAQ', description: 'Networking.' },
    FN: { name: 'Fabrinet', exchange: 'NYSE', sector: 'Technology' }, JBL: { name: 'Jabil Inc.', exchange: 'NYSE', sector: 'Technology' },
    OLD: { name: 'Gone', exchange: 'NYSE', activelyTrading: false }, TSE: { name: 'Toyo', exchange: 'TSE' },
}
const profileOf = async (t) => PROFILES[t] ?? null
const L = (ticker, extra = {}) => ({ name: ticker, ticker, relation: 'supplier', layer: 2, direction: 'loses', why: `${ticker} builds for Cisco.`, confidence: 'high', ...extra })

test("the doc's layers and losers are in the prompt and the schema", () => {
    for (const w of ['Layer 1', 'Layer 2', 'Layer 3', 'demand_loser', 'supply_loser', 'Substitutes', 'filed outside the event']) assert.ok(SYSTEM.includes(w), w)
    assert.deepEqual(schema().properties.links.items.properties.layer.enum, [1, 2, 3])
    assert.ok(RELATIONS.includes('demand_loser'))
})

test("the prompt: the event as Step 1 recorded it, and the template to start from", () => {
    const p = promptFor(CSCO, { description: 'Networking.', template: { from: 'Cisco Systems 2026-08-13', links: [L('FN')] } })
    assert.match(p, /Event \(2026-11-12, demand shock\): Cisco guided/)
    assert.match(p, /LOWERS demand at the origin\. Size: Day 0 -5\.9% vs SPY\. Durability: price spike — one quarter\./)
    assert.match(p, /A previous map of a demand shock on this origin \(Cisco Systems 2026-08-13\) — start from it:\n- FN FN — supplier, layer 2, loses/)
})

test('resolve: active US listings, the model\'s layer and direction kept; the rest dropped with the reason', async () => {
    const { links, dropped } = await resolve(CSCO, [L('FN', { layer: 3, direction: 'gains' }), L('CSCO'), L('OLD'), L('TSE'), L('NONE'), L('JBL', { relation: 'friend' }), L('FN')], profileOf)
    assert.deepEqual(links.map(l => [l.ticker, l.layer, l.direction, l.sector]), [['FN', 3, 'gains', 'Technology']])
    assert.deepEqual(dropped.map(d => [d.ticker, d.reason]), [['CSCO', 'origin or duplicate'], ['OLD', 'not an active US listing (NYSE)'],
        ['TSE', 'not an active US listing (TSE)'], ['NONE', 'no listing found'], ['JBL', 'relation'], ['FN', 'origin or duplicate']])
})

test("withFilings: evidence, not a gate — named, not named, and unread are three answers", async () => {
    const deps = {
        sleep: async () => {},
        namedIn: async (t, terms) => {
            if (t === 'FN') return { named: true, excerpt: 'Cisco is our largest customer.' }
            if (t === 'CSCO') return { named: terms.includes('Jabil') ? false : null }
            return t === 'XX' ? { named: null } : { named: false }
        },
        customerShare: async (t) => (t === 'FN' ? { share: 0.199, atLeast: false, form: '10-K', date: '2026-08-18', url: 'k', excerpt: 'Cisco … 19.9%' } : { share: null }),
    }
    const out = await withFilings(CSCO, [{ ...L('FN'), name: 'Fabrinet' }, { ...L('JBL'), name: 'Jabil Inc.' }, { ...L('XX'), name: 'Unknown Co' }], deps)
    assert.deepEqual(out[0].filings.namedBy, ['its filings', 'its 10-K customer table'])
    assert.deepEqual(out[0].filings.share, { share: 0.199, atLeast: false, form: '10-K', date: '2026-08-18', url: 'k' })
    assert.equal(out[0].filings.named, true)
    assert.equal(out[1].filings.named, false, 'Jabil: its filings and Cisco\'s searched, neither names the other')
    assert.equal(out[2].filings.named, null, 'nothing readable is unknown, not "not named"')
    assert.equal(out.length, 3, 'every link stays')
})

test('mapEvent: one call, the filings on every link, the map kept as the next template', async () => {
    const tpl = {}
    const db = { collection: () => ({ findOne: async (q) => tpl[q._id] ?? null, updateOne: async (q, u) => { tpl[q._id] = u.$set } }) }
    const calls = []
    _setDeps({
        db, profile: profileOf, sleep: async () => {}, now: () => new Date('2026-11-19T12:00:00Z'), houseLedger: async () => 'house',
        namedIn: async () => ({ named: false }), customerShare: async () => ({ share: null }),
        record: async (...a) => { calls.push(['record', ...a]) },
        call: async (o) => { calls.push(['call', o]); o.onUsage({ input_tokens: 1 }, 'claude-opus-5-5'); return { data: { links: [L('FN'), L('JBL')] }, model: 'claude-opus-5-5', stopReason: 'end_turn' } },
    })
    const r = await mapEvent(CSCO)
    assert.equal(r.ok, true)
    assert.deepEqual(r.map.links.map(l => l.ticker), ['FN', 'JBL'])
    assert.equal(r.map.fromTemplate, null)
    assert.deepEqual(calls.find(c => c[0] === 'record').slice(1, 5), ['house', 'claude-opus-5-5', { input_tokens: 1 }, 'echo'], "the house's map is the house's cost")
    assert.deepEqual(tpl['demand_shock|csco'].links.map(l => l.ticker), ['FN', 'JBL'])
    const second = await mapEvent({ ...CSCO, date: '2027-02-11' }, { userId: 'u1' })
    assert.equal(second.map.fromTemplate, 'Cisco Systems, Inc. 2026-11-12')
    assert.match(calls.filter(c => c[0] === 'call')[1][1].user, /start from it/)
    assert.equal(calls.filter(c => c[0] === 'record')[1][1], 'u1', "a user's map is the user's cost")
})

test('mapEvent refuses an unknown origin before the paid call', async () => {
    let paid = 0
    _setDeps({ profile: async () => null, call: async () => { paid++; return {} } })
    assert.match((await mapEvent(CSCO)).reason, /No listing found for CSCO/)
    assert.equal(paid, 0)
})
