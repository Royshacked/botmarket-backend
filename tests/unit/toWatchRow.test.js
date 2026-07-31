import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    callToWatchRow, setupToWatchRow, portfolioToWatchRow, scanToWatchRow, coverageToWatchRow,
} from '../../services/entity/toWatchRow.js'
import { normalizeZone } from '../../services/setup.schema.js'

// The reporting-tier projection: any owner-scoped artifact → one watch-list row.
//
// Two properties earn this file. TRIMMING is a correctness guard, not a cost saving — a call doc
// carries `chat_state`, an entire past conversation, and putting that in an agent's context lets a
// stale transcript be quoted back as current fact. And STATUS STAYS THE KIND'S OWN WORD, because
// flattening five vocabularies onto one enum means maintaining a translation table that lies.

const call = {
    id: 'c1', asset: 'NVDA', bias: 'long', status: 'looking', savedAt: 1000,
    thesis: 'reclaim of the range high', rr: 2.4, conviction: 'high', valid_until: '2026-08-30', mode: 'discretionary',
    entry_zones: [{ id: 'z1', lower: 170, upper: 172 }, { id: 'z2', lower: 165, upper: 166 }],
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
    assert.deepEqual(row.detail.nearestEntry, { low: 170, high: 172 })
    assert.equal(row.detail.entryZones, 2, 'the count, not the zones themselves')
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
        entry_zones: [{ lower: 500, upper: 502 }], stop_zones: [{ lower: 495, upper: 495 }], tp_zones: [{ lower: 520, upper: 522 }],
        rr: 3, timeframe: '4h',
    })
    assert.deepEqual(row.detail.stop, { low: 495, high: 495 })
    assert.deepEqual(row.detail.firstTp, { low: 520, high: 522 })
    assert.equal(row.detail.timeframe, '4h')
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

// REGRESSION. _firstZone read `low`/`high`, but a zone's edges are `lower`/`upper` — the spelling
// BOTH normalizers emit (setup.schema.normalizeZone, kairos.service.normalizeZones). Every level on
// every setup and call row was therefore null, including the agent-facing watch list, where they
// went missing rather than reading wrong. The fixtures above used to say low/high as well, so the
// test agreed with the bug and only production data disagreed — hence the shape is asserted here
// against the normalizer's own output rather than a hand-written literal.
test('zone bounds are read from the shape the normalizers actually emit', () => {
    const zone = normalizeZone({ lower: 188, upper: 190.5 }, 0, 'ez')
    assert.deepEqual(zone.lower, 188)   // guard: if the normalizer ever renames its edges, this fails first

    const setup = setupToWatchRow({ id: 's', asset: 'NVDA', direction: 'long', entry_zones: [zone] })
    assert.deepEqual(setup.detail.nearestEntry, { low: 188, high: 190.5 })

    const call = callToWatchRow({ id: 'c', asset: 'NVDA', bias: 'long', entry_zones: [zone] })
    assert.deepEqual(call.detail.nearestEntry, { low: 188, high: 190.5 })
})

test('missing zones degrade to null, not to a half-built object', () => {
    const row = callToWatchRow({ id: 'c', asset: 'X', entry_zones: [] })
    assert.equal(row.detail.nearestEntry, null)
    assert.equal(row.detail.entryZones, 0)
    assert.equal(callToWatchRow({ id: 'c', asset: 'X', entry_zones: [{ id: 'z' }] }).detail.nearestEntry, null)
})
