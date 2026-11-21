import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeItemStatusHandlers, formatSetupStatus, formatBookStatus, readLine } from '../../services/tools/itemStatus.tools.js'

// The monitors' view of one of the user's items (docs/design/axl-one-voice.md §6, Roy 2026-11-21): the LAST read, never a
// fresh one ("check my trade — give the last read").

const SETUP = { id: 'set_1', asset: 'NVDA', direction: 'long', status: 'active', mode: 'paper', orderState: 'awaiting_confirm', monitor_state: { next_check_at: '2026-11-21T15:00:00Z' } }
const READ = { at: '2026-11-21T14:00:00Z', reason: 'candle', rung: '1h', price: 181.2, verdict: 'wait', note: 'Still below the reclaim line; the thesis holds.', conditions: [{ id: 'reclaim', met: false, note: 'close above 182' }], armed: 'a close above 182 on the hour' }

test('a setup: the order state, the next check, the monitor\'s reads in its own words — said as the LAST read', () => {
    const text = formatSetupStatus(SETUP, [READ])
    assert.match(text, /THE TRADE MONITOR ON NVDA long \[setup:set_1\] — status active · paper/)
    assert.match(text, /order: an entry is waiting for the USER to confirm it/)
    assert.match(text, /next check: 2026-11-21 15:00Z/)
    assert.match(text, /2026-11-21 14:00Z candle \(1h\) at 181\.2 — wait: Still below the reclaim line/)
    assert.match(text, /✗ close above 182/)
    assert.match(text, /waiting for: a close above 182 on the hour/)
    assert.match(text, /The LAST read, not a fresh one/)
    assert.match(formatSetupStatus({ ...SETUP, orderState: null }, []), /no read yet/)
    assert.doesNotMatch(readLine({ at: READ.at, note: 'x' }), /warning|waiting for|proposed/)
})

test('a book: the review schedule, one waiting, what the monitor flagged, what the last conversation concluded', () => {
    const text = formatBookStatus({ portfolioId: 'pf_1', portfolioName: 'Growth', reviewCadence: 'monthly', lastReviewAt: Date.parse('2026-10-21T00:00:00Z'), nextReviewAt: Date.parse('2026-11-20T00:00:00Z'), notifiedAt: Date.parse('2026-11-20T09:00:00Z'), themis: { last_checked: Date.parse('2026-11-21T21:00:00Z'), last_event_sig: 'drawdown:NVDA' } }, { summary: 'Trimmed NVDA to 8%, kept the rest.' })
    assert.match(text, /THE PORTFOLIO MONITOR ON "Growth" \[book:pf_1\]/)
    assert.match(text, /reviews: monthly · last 2026-10-21 00:00Z · next 2026-11-20 00:00Z \(DUE\)/)
    assert.match(text, /a review is WAITING on the user/)
    assert.match(text, /it flagged: drawdown:NVDA/)
    assert.match(text, /concluded: Trimmed NVDA to 8%/)
})

test('the handler: owner-checked through each item\'s service; another\'s item or a bad kind is refused', async () => {
    const asked = []
    const h = makeItemStatusHandlers('u1', {
        setup: async (id, userId) => { asked.push(['setup', id, userId]); return id === 'set_1' ? { ok: true, doc: SETUP } : { ok: false, reason: 'not_found' } },
        reads: async () => [READ],
        book: async (id, userId) => { asked.push(['book', id, userId]); return id === 'pf_1' ? { portfolioName: 'Growth' } : null },
        context: async () => null,
    })
    assert.match(await h.get_item_status({ kind: 'setup', id: 'set_1' }), /THE TRADE MONITOR ON NVDA/)
    assert.match(await h.get_item_status({ kind: 'setup', id: 'set_other' }), /No such setup of yours/)
    assert.match(await h.get_item_status({ kind: 'book', id: 'pf_1' }), /THE PORTFOLIO MONITOR ON "Growth" \[book:pf_1\]/)
    assert.match(await h.get_item_status({ kind: 'coverage', id: 'x' }), /kind must be "setup" or "book"/)
    assert.deepEqual(asked.map(a => a[2]), ['u1', 'u1', 'u1'], 'every read is the user\'s')
})
