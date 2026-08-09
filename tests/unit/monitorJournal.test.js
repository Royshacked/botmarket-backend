import { test } from 'node:test'
import assert from 'node:assert/strict'

import { journalEntry, withJournal, zonesLabel, failNote, verdictFallbackNote, readReason } from '../../monitoring/monitorJournal.js'

// The shared monitor journal. Hermes's copy of this is pinned by hermesMonitor.test.js (the prose
// must not drift for calls); these tests pin that the SAME builder is kind-agnostic, because the
// reason it exists is that Talos's fork had dropped every sentence.

const NOW = Date.parse('2026-07-29T17:49:07.885Z')
const setup = (over = {}) => ({
    kind: 'setup', asset: 'AER', active_from: '2026-07-30T13:30:00.000Z',
    entry_zones: [{ id: 'ez1', lower: 147.28, upper: 148.3 }, { id: 'ez2', lower: 145.35, upper: 147.27 }],
    ...over,
})

test('scheduled: a setup gets the same arithmetic sentence a call gets', () => {
    const e = journalEntry('scheduled', {
        nowMs: NOW, entity: setup(), price: 151.45,
        nextAt: new Date(NOW + 65 * 60_000).toISOString(),
    })
    assert.equal(e.reason, 'scheduled')
    assert.equal(e.price, 151.45)
    assert.match(e.note, /151\.45/)
    assert.match(e.note, /147\.28–148\.3, 145\.35–147\.27/)   // both zones, plural
    assert.match(e.note, /65m/)
    assert.equal(e.next_check_at, new Date(NOW + 65 * 60_000).toISOString())
})

test('scheduled: one zone → singular "zone", and an unparseable next check drops the gap clause', () => {
    const e = journalEntry('scheduled', {
        nowMs: NOW, entity: setup({ entry_zones: [{ lower: 100, upper: 101 }] }), price: 99, nextAt: null,
    })
    assert.match(e.note, /my zone 100–101/)
    assert.doesNotMatch(e.note, /checking back/)
})

test('closed / pre_active: named by the entity, and pre_active says which KIND when there is no asset', () => {
    const closed = journalEntry('market_closed', { nowMs: NOW, entity: setup(), nextAt: null })
    assert.match(closed.note, /Market's closed for AER/)
    assert.equal(closed.price, null)

    const pre = journalEntry('pre_active', { nowMs: NOW, entity: setup(), nextAt: null })
    assert.match(pre.note, /AER/)
    assert.match(pre.note, /2026-07-30T13:30/)

    // No entity at all → the generic noun, never "undefined".
    const bare = journalEntry('pre_active', { nowMs: NOW, nextAt: null })
    assert.match(bare.note, /this call/)
    assert.doesNotMatch(bare.note, /undefined/)
})

test('failed: honest retry note by failure kind, no verdict', () => {
    const io = journalEntry('zone_trip', { nowMs: NOW, entity: setup(), price: 148, failed: true })
    assert.match(io.note, /didn't complete — retrying/i)
    assert.equal(io.verdict, null)

    const bad = journalEntry('zone_trip', { nowMs: NOW, entity: setup(), price: 148, failed: true, failReason: 'truncated' })
    assert.match(bad.note, /came back malformed/i)

    // The verb is the caller's — Hermes reassesses in position, Talos reads.
    assert.match(failNote('reassess', 'AER', null), /Went to reassess AER/)
})

test('assessment: the model read becomes the note, with the zone and verdict alongside', () => {
    const e = journalEntry('zone_trip', {
        nowMs: NOW, entity: setup(), price: 147.9, zone: setup().entry_zones[0],
        raw: { verdict: 'stand_aside', read: 'In the zone but the tape is risk-off.' },
    })
    assert.equal(e.verdict, 'stand_aside')
    assert.equal(e.note, 'In the zone but the tape is risk-off.')
    assert.equal(e.zone_id, 'ez1')
    assert.equal(e.axes, undefined, 'a monitor with no axes writes no axes key')
})

test('assessment: no read → the verdict speaks for itself', () => {
    const e = journalEntry('expiry_review', { nowMs: NOW, entity: setup(), raw: { verdict: 'let_expire' } })
    assert.match(e.note, /Nothing materialized/)
    assert.equal(verdictFallbackNote('enter'), 'This finally looks ready — proposing an entry.')
    // An off-menu verdict must still produce a readable line rather than an empty bubble.
    assert.ok(journalEntry('zone_trip', { nowMs: NOW, entity: setup(), raw: { verdict: 'YOLO' } }).note.length)
})

test('assessment: axes ride along when the monitor has them (Hermes)', () => {
    const e = journalEntry('zone_trip', {
        nowMs: NOW, entity: setup(), raw: { verdict: 'wait', read: 'coiling' },
        axes: { market: { score: 'neutral' }, patterns_seen: [] }, fetched: 'chart 15min',
    })
    assert.equal(e.axes.market.score, 'neutral')
    assert.equal(e.fetched, 'chart 15min')
})

test('zonesLabel: joins bands, flags multi, and survives a zoneless entity', () => {
    assert.equal(zonesLabel(setup()).multi, true)
    assert.equal(zonesLabel({ entry_zones: [] }).text, '(no zones)')
    assert.equal(zonesLabel(null).text, '(no zones)')
})

test('withJournal: appends under the cap, and a wake with no entry writes no $push', () => {
    const entry = journalEntry('market_closed', { nowMs: NOW, entity: setup() })
    const u = withJournal({ status: 'looking' }, entry, 50)
    assert.deepEqual(u.$set, { status: 'looking' })
    assert.deepEqual(u.$push['monitor_state.timeline'], { $each: [entry], $slice: -50 })

    assert.equal(withJournal({ status: 'looking' }, null).$push, undefined)
})

test('a runaway read is described honestly, not as a broken reply', () => {
    // 'runaway' means the model kept calling tools and never decided — a different failure from a
    // malformed reply or a dead provider, and the journal is the only place it surfaces.
    const note = failNote('read', 'NVDA', 'runaway')
    assert.match(note, /kept digging/)
    assert.notEqual(note, failNote('read', 'NVDA', 'io'))
    assert.notEqual(note, failNote('read', 'NVDA', 'malformed'))
})

// ─── exit vs market_closed: two opposite events that used to share a word ──────
// `closed` meant "the MARKET is shut, I'm holding off", and read to every human as "the POSITION
// closed". The ambiguity survived long enough to mislead a reader of the docs, so the market one is
// now spelled out and `exit` is the position one.

test('exit says what happened, and does not promise a next check', () => {
    // It is the LAST line on the timeline. A next_check_at would advertise a wake that never comes.
    const e = journalEntry('exit', {
        nowMs: NOW, entity: setup(), price: 151.45, closedReason: 'stop', pnl: -212.5,
    })
    assert.equal(e.reason, 'exit')
    assert.equal(e.price, 151.45)
    assert.equal(e.next_check_at, null)
    assert.match(e.note, /AER/)
    assert.match(e.note, /151\.45/)
    assert.match(e.note, /stop hit/, 'the closedReason is spoken, not echoed as a slug')
    assert.match(e.note, /-212\.5/, 'the number the user actually wants')
})

test('exit degrades rather than printing holes', () => {
    // The reconciler can close without a price or a pnl (a broker close with no fill detail).
    const e = journalEntry('exit', { nowMs: NOW, entity: setup(), closedReason: 'manual' })
    assert.equal(e.price, null)
    assert.doesNotMatch(e.note, /null|undefined|NaN/)
    assert.match(e.note, /closed by hand/)
})

test('an unknown closedReason is still reported, not swallowed', () => {
    const e = journalEntry('exit', { nowMs: NOW, entity: setup(), closedReason: 'liquidation' })
    assert.match(e.note, /liquidation/)
})

test('market_closed keeps the holding sentence, under its new name', () => {
    const e = journalEntry('market_closed', { nowMs: NOW, entity: setup(), nextAt: null })
    assert.equal(e.reason, 'market_closed')
    assert.match(e.note, /Market's closed for AER/)
})

test('journals written before the rename still read as the market being shut', () => {
    // Read-side only. Old entries age out of the cap on their own; until they do they must not
    // suddenly render as a position close, which is the opposite event.
    assert.equal(readReason('closed'), 'market_closed')
    assert.equal(readReason('exit'), 'exit', 'anything current passes through untouched')
    assert.equal(readReason('zone_trip'), 'zone_trip')
})
