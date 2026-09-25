import { test } from 'node:test'
import assert from 'node:assert/strict'

import { journalEntry, failNote, verdictFallbackNote } from '../../monitoring/monitorJournal.js'

// The monitor journal row (docs/design/talos-per-candle.md): one per read, plus the events code
// writes on a trade. What a row says is what the read LOOKED AT, DECIDED and is WAITING FOR.

const NOW = Date.parse('2026-07-29T17:49:07.885Z')
const setup = (over = {}) => ({
    kind: 'setup', asset: 'AER', active_from: '2026-07-30T13:30:00.000Z',
    entry_legs: [{ id: 'ez1', price: 148.3 }, { id: 'ez2', price: 147.27 }],
    ...over,
})

test('a read row carries what it checked, what it pulled, what it decided and what it waits for', () => {
    const armed = [{ price: 318, direction: 'above', means: 'entry' }]
    const e = journalEntry('candle', {
        nowMs: NOW, entity: setup(), price: 312.4, rung: '15min', armed,
        nextAt: new Date(NOW + 15 * 60_000).toISOString(),
        raw: { verdict: 'wait', read: 'Tagged it, but the candle is still open.', warning: 'No close above 312 yet.',
               conditions: [{ id: 'c1', met: 'no', note: 'still inside' }] },
        tools: ['get_chart', 'get_indicators'],
    })
    assert.equal(e.at, '2026-07-29T17:49:07.885Z')
    assert.equal(e.reason, 'candle')
    assert.equal(e.rung, '15min')
    assert.equal(e.verdict, 'wait')
    assert.equal(e.note, 'Tagged it, but the candle is still open.')
    assert.equal(e.warning, 'No close above 312 yet.')
    assert.deepEqual(e.conditions, [{ id: 'c1', met: 'no', note: 'still inside' }])
    assert.deepEqual(e.tools, ['get_chart', 'get_indicators'])
    assert.deepEqual(e.armed, armed, 'the set armed NOW, not the one just replaced')
    assert.equal(e.next_check_at, new Date(NOW + 15 * 60_000).toISOString())
})

test('a guard wake carries WHICH guard fired and when it was armed', () => {
    // The audit trail: a reader can see the line was drawn deliberately hours earlier rather than
    // stumbled into, and what replaced it.
    const e = journalEntry('guard', {
        nowMs: NOW, entity: setup(), price: 312.4, nextAt: null,
        woke: { price: 312, direction: 'above', means: 'entry', armed_at: '2026-08-22T08:20:00.000Z', at: '2026-08-22T11:00:00.000Z' },
        raw: { verdict: 'wait', read: 'Tagged it.' },
    })
    assert.deepEqual(e.fired, { price: 312, direction: 'above', means: 'entry', armed_at: '2026-08-22T08:20:00.000Z' })
})

test('a row OMITS what it has nothing to say about rather than nulling it', () => {
    const e = journalEntry('candle', { nowMs: NOW, entity: setup(), price: 151, nextAt: null, raw: { verdict: 'wait', read: 'x' } })
    for (const k of ['fired', 'armed', 'tools', 'conditions', 'warning', 'proposal', 'rung', 'leg_id']) {
        assert.equal(k in e, false, k)
    }
})

test('armed falls back to what the entity carries when the read did not pass a set', () => {
    const guards = [{ price: 300, direction: 'below', means: 'invalidation' }]
    const e = journalEntry('candle', { nowMs: NOW, entity: setup({ monitor_state: { guards } }), raw: { verdict: 'wait', read: 'x' } })
    assert.deepEqual(e.armed, guards)
})

test('pre_active is named by the entity, and says which KIND when there is no asset', () => {
    const pre = journalEntry('pre_active', { nowMs: NOW, entity: setup(), nextAt: null })
    assert.match(pre.note, /AER/)
    assert.match(pre.note, /2026-07-30T13:30/)

    const bare = journalEntry('pre_active', { nowMs: NOW, nextAt: null })
    assert.match(bare.note, /this setup/)
    assert.doesNotMatch(bare.note, /undefined/)
})

test('failed: honest retry note by failure kind, no verdict, and the tools it did spend', () => {
    const io = journalEntry('candle', { nowMs: NOW, entity: setup(), price: 148, failed: true, rung: '1hr' })
    assert.match(io.note, /didn't complete — retrying at the next close/i)
    assert.equal(io.verdict, null)
    assert.equal(io.rung, '1hr')

    const bad = journalEntry('candle', { nowMs: NOW, entity: setup(), price: 148, failed: true, failReason: 'truncated', tools: ['get_chart'] })
    assert.match(bad.note, /came back malformed/i)
    assert.deepEqual(bad.tools, ['get_chart'], 'a failed read still cost what it pulled')

    assert.match(failNote('reassess', 'AER', null), /Went to reassess AER/)
})

test('a runaway read is described honestly, not as a broken reply', () => {
    const note = failNote('read', 'NVDA', 'runaway')
    assert.match(note, /kept digging/)
    assert.notEqual(note, failNote('read', 'NVDA', 'io'))
    assert.notEqual(note, failNote('read', 'NVDA', 'malformed'))
})

test('the model read becomes the note, with the leg and verdict alongside', () => {
    const e = journalEntry('guard', {
        nowMs: NOW, entity: setup(), price: 147.9, leg: setup().entry_legs[0],
        raw: { verdict: 'stand_aside', read: 'At the level but the tape is risk-off.' },
    })
    assert.equal(e.verdict, 'stand_aside')
    assert.equal(e.note, 'At the level but the tape is risk-off.')
    assert.equal(e.leg_id, 'ez1')
})

test('no read → the verdict speaks for itself, for every verdict on either menu', () => {
    const e = journalEntry('expiry_review', { nowMs: NOW, entity: setup(), raw: { verdict: 'let_expire' } })
    assert.match(e.note, /Nothing materialized/)
    assert.equal(verdictFallbackNote('enter'), 'This finally looks ready — proposing an entry.')
    for (const v of ['hold', 'move_stop', 'take_partial', 'exit_now', 'add_leg', 'wait', 'stand_aside', 'edit']) {
        assert.ok(verdictFallbackNote(v).length > 10, v)
    }
    // An off-menu verdict must still produce a readable line rather than an empty bubble.
    assert.ok(journalEntry('candle', { nowMs: NOW, entity: setup(), raw: { verdict: 'YOLO' } }).note.length)
})

test('an in-position row carries the proposal the card was built from', () => {
    const e = journalEntry('candle', {
        nowMs: NOW, entity: setup(), price: 160,
        raw: { verdict: 'take_partial', read: 'Momentum faded into the target.', proposal: { leg: 't2', quantity: 5, size_pct: 50 } },
    })
    assert.deepEqual(e.proposal, { leg: 't2', quantity: 5, size_pct: 50 })
})

// ─── exit ─────────────────────────────────────────────────────────────────────

test('exit says what happened, and does not promise a next check', () => {
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
    const e = journalEntry('exit', { nowMs: NOW, entity: setup(), closedReason: 'manual' })
    assert.equal(e.price, null)
    assert.doesNotMatch(e.note, /null|undefined|NaN/)
    assert.match(e.note, /closed by hand/)
})

test('an unknown closedReason is still reported, not swallowed', () => {
    const e = journalEntry('exit', { nowMs: NOW, entity: setup(), closedReason: 'liquidation' })
    assert.match(e.note, /liquidation/)
})
