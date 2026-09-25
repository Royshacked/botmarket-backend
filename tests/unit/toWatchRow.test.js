import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    callToWatchRow, setupToWatchRow, portfolioToWatchRow, scanToWatchRow, coverageToWatchRow,
} from '../../services/entity/toWatchRow.js'
import { normalizeLeg } from '../../services/setup.schema.js'

// The reporting-tier projection: any owner-scoped artifact → one watch-list row.
//
// Two properties earn this file. TRIMMING is a correctness guard, not a cost saving — a call doc
// carries `chat_state`, an entire past conversation, and putting that in an agent's context lets a
// stale transcript be quoted back as current fact. And STATUS STAYS THE KIND'S OWN WORD, because
// flattening five vocabularies onto one enum means maintaining a translation table that lies.

const call = {
    id: 'c1', asset: 'NVDA', bias: 'long', status: 'looking', savedAt: 1000,
    thesis: 'reclaim of the range high', rr: 2.4, conviction: 'high', valid_until: '2026-08-30', mode: 'discretionary',
    // A call is a FROZEN Kairos document and still carries the band shape — nothing authors one,
    // so `callToWatchRow` is the last reader of `lower`/`upper` in the app.
    entry_zones: [{ id: 'z1', lower: 170, upper: 172 }, { id: 'z2', lower: 166, upper: 168 }],
    // Everything below must NOT survive the projection.
    chat_state: { messages: [{ role: 'user', content: 'a whole past conversation' }] },
    reference_levels: [{ px: 180 }], patterns: ['bull flag'],
    monitor_state: { timeline: [{ at: 1, memo: 'checked' }], check_count: 9 },
}

test('a call keeps what a reader needs and drops the bulk', () => {
    const row = callToWatchRow(call)
    assert.equal(row.kind, 'call')
    assert.equal(row.symbol, 'NVDA')
    assert.equal(row.direction, 'long', "bias is the call's word for direction")
    assert.equal(row.status, 'looking')
    assert.equal(row.detail.rr, 2.4)
    assert.equal(row.detail.nearestEntry, 170, "an archived band, read at the edge price reaches")
    assert.equal(row.detail.entryLegs, 2, 'the count, not the levels themselves')
})

test('a stale transcript never rides along — this is the correctness one', () => {
    // If chat_state reached an agent it could be read back as something the user said just now.
    const serialized = JSON.stringify(callToWatchRow(call))
    assert.doesNotMatch(serialized, /a whole past conversation/)
    assert.doesNotMatch(serialized, /chat_state/)
    assert.doesNotMatch(serialized, /timeline/)
    assert.doesNotMatch(serialized, /bull flag/)
})

test('every row carries id + kind, so detail is a targeted read rather than a re-list', () => {
    const row = callToWatchRow(call)
    assert.equal(row.id, 'c1')
    assert.ok(row.kind)
})

test('a title is one capped line, never a whole thesis', () => {
    const long = callToWatchRow({ ...call, thesis: 'x'.repeat(400) })
    assert.ok(long.title.length <= 120)
    assert.match(long.title, /…$/)
})

test('no thesis falls back to something readable rather than empty', () => {
    assert.equal(callToWatchRow({ ...call, thesis: null }).title, 'long NVDA')
})

test('a setup carries its own stop and target, which a call leaves to its tree', () => {
    const row = setupToWatchRow({
        id: 's1', asset: 'SPY', direction: 'long', status: 'waiting', savedAt: 2000,
        entry_legs: [{ price: 502 }], stop_legs: [{ price: 495 }], target_legs: [{ price: 522 }],
        rr: 3, timeframe: '4h',
    })
    assert.equal(row.detail.stop, 495)
    assert.equal(row.detail.firstTp, 522)
    assert.equal(row.detail.timeframe, '4h')
})

// A setup can hold rival premises — a false break at one level and a break-and-go at another. One
// set of levels would hide the second one entirely, and the user would never learn they have two
// ways in (or that one of them has already died).
test('a row shows every scenario, and says which one is armed', () => {
    const row = setupToWatchRow({
        id: 's1', asset: 'NVDA', direction: 'long', status: 'looking', savedAt: 2000,
        armed_scenario_id: 's2',
        entry_legs: [{ price: 244.9 }], stop_legs: [{ price: 241.8 }], rr: 2.4,
        scenarios: [
            { id: 's1', name: 'false break', entry_legs: [{ price: 238.6 }],
              stop_legs: [{ price: 234.8 }], target_legs: [{ price: 246 }], quantity: 100, rr: 1.95 },
            { id: 's2', name: 'break and go', entry_legs: [{ price: 244.9 }],
              stop_legs: [{ price: 241.8 }], target_legs: [{ price: 252 }], quantity: 60, rr: 2.4 },
        ],
        monitor_state: { scenarios: { s1: { invalidation_status: 'fired' } } },
    })
    assert.equal(row.detail.scenarios.length, 2)
    assert.deepEqual(row.detail.scenarios.map(s => s.name), ['false break', 'break and go'])
    assert.deepEqual(row.detail.scenarios.map(s => s.armed), [false, true])
    assert.equal(row.detail.scenarios[0].invalidation, 'fired', 'a dead premise must not read as live')
    assert.equal(row.detail.scenarios[1].entry, 244.9)
    assert.deepEqual(row.detail.scenarios.map(s => s.quantity), [100, 60], 'never added together')
    // The flat levels stay the ARMED premise's — one answer for "where is my NVDA setup".
    assert.equal(row.detail.nearestEntry, 244.9)
    assert.equal(row.detail.rr, 2.4)
})

test('a scenario-less document still projects a row', () => {
    const row = setupToWatchRow({ id: 's1', asset: 'SPY', direction: 'long', entry_legs: [{ price: 502 }] })
    assert.deepEqual(row.detail.scenarios, [])
    assert.equal(row.detail.nearestEntry, 502)
})

test('a book reports null status — it has none of its own — and counts what is in it', () => {
    const row = portfolioToWatchRow({
        portfolioId: 'p1', name: 'Growth', holdings: 3, savedAt: 3000,
        statuses: { long: 2, waiting: 1 }, symbols: ['NVDA', 'MSFT'],
    })
    assert.equal(row.kind, 'portfolio')
    assert.equal(row.status, null, 'inventing a status word for a book would be a lie')
    assert.equal(row.symbol, null, 'a book is not one name')
    assert.deepEqual(row.detail.byStatus, { long: 2, waiting: 1 })
    assert.deepEqual(row.detail.symbols, ['NVDA', 'MSFT'])
})

test('a scan has no symbol and no status — staleness lives in detail, undressed', () => {
    const row = scanToWatchRow({
        id: 'scan_1', thesis: 'AI infra laggards', period: { label: 'August' }, savedAt: 4000,
        stale: true, profile: 'trading', candidates: [{ ticker: 'A' }, { ticker: 'B' }],
        chat: [{ role: 'user', content: 'transcript that must not travel' }],
    })
    assert.equal(row.symbol, null)
    assert.equal(row.status, null)
    assert.equal(row.detail.stale, true)
    assert.equal(row.detail.candidates, 2, 'the count, not the candidates')
    assert.doesNotMatch(JSON.stringify(row), /transcript that must not travel/)
})

test("coverage keeps its OWN status vocabulary, not the execution ladder", () => {
    const row = coverageToWatchRow({
        id: 'cov_1', symbol: 'AVGO', status: 'thesis_broken', rating: 'hold',
        price_target: { value: 210 }, gap: { pct: -8.2, consensus_pt: 229 },
        updated_at: '2026-07-20T10:00:00.000Z', thesis: 'margin compression',
    })
    assert.equal(row.status, 'thesis_broken')
    assert.equal(row.detail.ourPT, 210)
    assert.equal(row.detail.gapPct, -8.2)
    assert.equal(row.detail.streetPT, 229)
})

test('an ISO timestamp becomes ms, so kinds sort against each other correctly', () => {
    // Coverage stores ISO strings; entities store ms epochs. A mixed list sorted on raw values
    // would put every coverage row either first or last.
    const cov = coverageToWatchRow({ id: 'c', symbol: 'X', updated_at: '2026-07-20T10:00:00.000Z' })
    assert.equal(typeof cov.updatedAt, 'number')
    assert.equal(cov.updatedAt, Date.parse('2026-07-20T10:00:00.000Z'))
})

test('a doc with no id is dropped rather than becoming an unaddressable row', () => {
    assert.equal(callToWatchRow({ asset: 'NVDA' }), null)
    assert.equal(callToWatchRow(null), null)
    assert.equal(portfolioToWatchRow({ name: 'no id' }), null)
})

// REGRESSION, and it is the reason this test reads the NORMALIZER rather than a literal. `_firstZone`
// read `low`/`high` while a zone's edges were `lower`/`upper`, so every level on every setup and call
// row was null — including the agent-facing watch list, where they went missing rather than reading
// wrong. The fixtures said low/high too, so the test agreed with the bug and only production data
// disagreed. Same guard, new shape: if the normaliser ever renames `price`, this fails first.
test('a level is read from the shape the normaliser actually emits', () => {
    const leg = normalizeLeg({ price: 190.5 }, 0, 'ez')
    assert.equal(leg.price, 190.5)

    const setup = setupToWatchRow({ id: 's', asset: 'NVDA', direction: 'long', entry_legs: [leg] })
    assert.equal(setup.detail.nearestEntry, 190.5, 'one number, not a pair the caller has to collapse')
})

test('missing levels degrade to null, not to a half-built object', () => {
    const row = callToWatchRow({ id: 'c', asset: 'X', entry_zones: [] })
    assert.equal(row.detail.nearestEntry, null)
    assert.equal(row.detail.entryLegs, 0)
    assert.equal(callToWatchRow({ id: 'c', asset: 'X', entry_zones: [{ id: 'z' }] }).detail.nearestEntry, null)
    assert.equal(setupToWatchRow({ id: 's', asset: 'X', entry_legs: [{ id: 'z' }] }).detail.nearestEntry, null)
})
