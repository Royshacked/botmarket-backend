import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { perShare, splitEffect } from '../../services/corporateActions.service.js'
import {
    restateTrade, restateConditionText, moreShares, restatePaperPosition, restatePaperOrder, restateLedgerRow,
    memoWithSplit, restateOpenTrades, splitDayMs, OPEN_STATUSES,
} from '../../services/tradeSplit.service.js'
import { buildSplitRestated } from '../../services/tradeNotify.service.js'
import { executionReconciler, _setDeps as _setReconcilerDeps, sameOrderPrice } from '../../monitoring/execution.reconciler.js'
import { _tradeIO, _tick, _setSplitSweepIO } from '../../monitoring/splitSweep.service.js'
import { dropCandleCache } from '../../services/price.service.js'

// 2026-11-22 — open trades through a stock split (Roy: restate + flag; a live venue re-reads the broker).

const SNDK = { symbol: 'SNDK', date: '2026-11-20', numerator: 8, denominator: 1, ratio: 8 }
const SLQT = { symbol: 'SLQT', date: '2026-11-17', numerator: 1, denominator: 20, ratio: 0.05 }

test('the arithmetic: prices ÷, shares ×; sub-dollar prices keep 4 places; a reverse split says so the right way round', () => {
    assert.equal(perShare(1428, 8), 178.5)
    assert.equal(perShare(0.37, 8), 0.0463, 'not $0.05')
    assert.equal(perShare(0.36923692, 0.05), 7.38)
    assert.equal(moreShares(5, 8), 40)
    assert.equal(moreShares(90, 0.05), 4.5)
    assert.equal(moreShares(null, 8), null)
    assert.equal(splitEffect(8), 'prices ÷ 8, shares × 8')
    assert.equal(splitEffect(0.05), 'prices × 20, shares ÷ 20')
    assert.equal(splitDayMs('2026-11-20'), Date.parse('2026-11-20T05:00:00Z'))
    assert.deepEqual(OPEN_STATUSES.slice().sort(), ['hit', 'long', 'looking', 'resting', 'short', 'waiting'])
})

test('a condition text: the app\'s own "price touches N" is rewritten; free text with a number is left and flagged', () => {
    assert.deepEqual(restateConditionText('price touches 1428', 8), { text: 'price touches 178.5', free: false })
    assert.deepEqual(restateConditionText('  Price Touches 1400.5 ', 8), { text: 'price touches 175.06', free: false })
    assert.deepEqual(restateConditionText('daily close below 1400', 8), { text: 'daily close below 1400', free: true })
    assert.deepEqual(restateConditionText('RSI turns up', 8), { text: 'RSI turns up', free: false })
})

const idea = () => ({
    id: 'i1', kind: 'idea', userId: 'u1', asset: 'SNDK', direction: 'long', status: 'long', mode: 'paper', savedAt: 1,
    quantity: 5, entryTriggerPrice: 1428, entryOrderType: 'limit',
    entry_condition_tree: { operator: 'AND', children: [{ condition: 'price touches 1428', type: 'touch' }] },
    stop_condition_tree: { operator: 'OR', children: [{ condition: 'price touches 1300', type: 'touch', quantity: 5 }, { condition: 'daily close below 1350', type: 'close' }] },
    entry_conditions: [{ condition: 'price touches 1428', type: 'touch' }],
    additional_entries: [{ condition_tree: { operator: 'AND', children: [{ condition: 'price touches 1350' }] }, quantity: 2 }],
    invalidation: { range: { lower: 1200, upper: 1800, approach: 1250 } },
    pendingOrder: { plan: [{ accountId: 'a', quantity: 5 }] },
    brokerOrders: [{ broker: 'paper', accountId: 'a', orderId: 'o1', positionId: 'p1', quantity: 5 }],
    nativeExit: { stop: [{ level: 1300, quantity: 5 }], tp: [{ level: 1700, quantity: 5 }] },
    exitOrders: [{ broker: 'paper', accountId: 'a', leg: 'stop', type: 'stop', price: 1300, quantity: 5, orderId: 'x1', status: 'working', positionId: 'p1' }],
    research_basis: { coveragePt: 1710, rating: 'buy' },
    allocationRatio: 0.2, basisOffset: 0,
})

test('an idea restated: every level ÷, every size ×, the app\'s touch texts rewritten, free text flagged — weights and offsets untouched', () => {
    const { set, flags } = restateTrade(idea(), 8)
    assert.equal(set.quantity, 40)
    assert.equal(set.entryTriggerPrice, 178.5)
    assert.equal(set.entry_condition_tree.children[0].condition, 'price touches 178.5')
    assert.deepEqual(set.stop_condition_tree.children.map(c => [c.condition, c.quantity]), [['price touches 162.5', 40], ['daily close below 1350', undefined]])
    assert.equal(set.entry_conditions[0].condition, 'price touches 178.5')
    assert.deepEqual([set.additional_entries[0].condition_tree.children[0].condition, set.additional_entries[0].quantity], ['price touches 168.75', 16])
    assert.deepEqual(set['invalidation.range'], { lower: 150, upper: 225, approach: 156.25 })
    assert.equal(set['pendingOrder.plan'][0].quantity, 40)
    assert.equal(set.brokerOrders[0].quantity, 40)
    assert.deepEqual(set.nativeExit, { stop: [{ level: 162.5, quantity: 40 }], tp: [{ level: 212.5, quantity: 40 }] })
    assert.deepEqual([set.exitOrders[0].price, set.exitOrders[0].quantity, set.exitOrders[0].orderId], [162.5, 40, 'x1'])
    assert.equal(set['research_basis.coveragePt'], 213.75)
    assert.deepEqual(flags, ['daily close below 1350'])
    for (const k of ['allocationRatio', 'basisOffset', 'research_basis.rating', 'status']) assert.equal(k in set, false, k)
})

const setup = () => ({
    id: 's1', kind: 'setup', userId: 'u1', asset: 'SNDK', direction: 'long', status: 'long', mode: 'live', savedAt: 1,
    thesis: 'buy the 1400 retest', quantity: 4,
    scenarios: [{ id: 'A', entry_legs: [{ price: 1400, about: 1402, quantity: 4, trigger: 'reclaim of 1400', conditions: [{ id: 'c1', text: 'holds 1390 on the 1h' }] }],
        stop_legs: [{ price: 1320, quantity: 4 }], target_legs: [{ price: 1600, quantity: 2 }, { price: 1700, quantity: 2 }],
        quantity: 4, rr: 2.5, validity: { lower: 1300, upper: 1550 }, arm_close: 1410, conditions: [{ id: 'c2', text: 'volume above average' }] }],
    entry_legs: [{ price: 1400, quantity: 4 }], stop_legs: [{ price: 1320, quantity: 4 }], target_legs: [{ price: 1600, quantity: 4 }], validity: { lower: 1300, upper: 1550 },
    alternatives: [{ price: 1350, why: 'deeper' }],
    monitor_state: { memo: 'watching 1400', guards: [{ price: 1390, side: 'below' }], last_assessment: { price: 1420 } },
    position_state: { entry: { legs: [{ price: 1401, quantity: 4 }], fill_price: 1401, size: 4 }, stop: { initial: 1320, current: 1350 }, targets: [{ price: 1600, quantity: 4 }], taken: [{ size: 1 }], metrics: { r: 1.2 },
        pending_action: { proposal: { stop: 1380, size_pct: 50 } } },
    chat_state: { draft: { entry_legs: [{ price: 1400 }], quantity: 4 } },
})

test('a setup restated: scenarios, the flat projection, Talos\'s guards, the position — R and percentages untouched; its free texts flagged', () => {
    const { set, flags } = restateTrade(setup(), 8)
    const a = set.scenarios[0]
    assert.deepEqual([a.entry_legs[0].price, a.entry_legs[0].about, a.entry_legs[0].quantity], [175, 175.25, 32])
    assert.deepEqual([a.stop_legs[0].price, a.target_legs.map(t => t.price), a.quantity, a.rr], [165, [200, 212.5], 32, 2.5])
    assert.deepEqual([a.validity, a.arm_close], [{ lower: 162.5, upper: 193.75 }, 176.25])
    assert.equal(a.entry_legs[0].conditions[0].text, 'holds 1390 on the 1h', 'free text is not guessed at')
    assert.deepEqual([set.entry_legs[0].price, set.stop_legs[0].price, set.validity.upper, set.quantity], [175, 165, 193.75, 32])
    assert.equal(set.alternatives[0].price, 168.75)
    assert.deepEqual([set['monitor_state.guards'][0].price, set['monitor_state.last_assessment.price']], [173.75, 177.5])
    assert.deepEqual([set['position_state.entry'].fill_price, set['position_state.entry'].size, set['position_state.entry'].legs[0].price], [175.13, 32, 175.13])
    assert.deepEqual([set['position_state.stop.initial'], set['position_state.stop.current'], set['position_state.targets'][0].price, set['position_state.taken'][0].size], [165, 168.75, 200, 8])
    assert.equal(set['position_state.pending_action.proposal.stop'], 172.5)
    assert.equal('position_state.metrics' in set, false)
    assert.deepEqual([set['chat_state.draft.entry_legs'][0].price, set['chat_state.draft.quantity']], [175, 32])
    assert.deepEqual(flags.sort(), ['holds 1390 on the 1h', 'reclaim of 1400', 'the thesis'].sort())
    assert.match(memoWithSplit('watching 1400', SNDK), /^\[2026-11-20\] SNDK split 8-for-1: .*prices ÷ 8, shares × 8.*\nwatching 1400$/s)
})

test('the paper / manual venue and the ledger: a position, a resting order, an open row', () => {
    const before = splitDayMs('2026-11-20')
    assert.deepEqual(restatePaperPosition({ qty: 5, avgPrice: 1428.1428, currentPrice: 79.24, markedAt: before + 1, direction: 'long' }, 8, before), { qty: 40, avgPrice: 178.52, pnl: -3971.2 })
    assert.deepEqual(restatePaperPosition({ qty: 5, avgPrice: 1428, currentPrice: 1400, markedAt: before - 1, direction: 'short' }, 8, before), { qty: 40, avgPrice: 178.5, currentPrice: 175, pnl: 140 }, 'a pre-split mark is restated too')
    assert.deepEqual(restatePaperPosition({ qty: 90, avgPrice: 0.36923692, currentPrice: 5.01, markedAt: before + 1, direction: 'long' }, 0.05, before), { qty: 4.5, avgPrice: 7.38, pnl: -10.66 }, 'SLQT: the fake gain gone')
    assert.deepEqual(restatePaperOrder({ triggerPrice: 1300, qty: 5 }, 8), { triggerPrice: 162.5, qty: 40 })
    assert.deepEqual(restateLedgerRow({ quantity: 5, entry: { price: 1428.1428, ts: 1 } }, 8), { quantity: 40, 'entry.price': 178.52 })
})

test('the card says what moved, what the broker needed, and every free-text level left — from the trade\'s desk', () => {
    const card = buildSplitRestated(setup(), SNDK, { before: { quantity: 4, entry: 1401, stop: 1350 }, after: { quantity: 32, entry: 175.13, stop: 168.75 }, flags: ['holds 1390 on the 1h'], notes: ['stop moved to 168.75 at the broker'] })
    assert.equal(card.userId, 'u1')
    assert.equal(card.botId, 'mentor')
    assert.equal(card.type, 'split_restated')
    assert.match(card.content, /SNDK split 8-for-1 on 2026-11-20\. Your LONG SNDK setup was restated — prices ÷ 8, shares × 8\. 4 sh, entry 1401, stop 1350 → 32 sh, entry 175\.13, stop 168\.75\./)
    assert.match(card.content, /At the broker: stop moved to 168\.75 at the broker\./)
    assert.match(card.content, /One condition still names a pre-split price — edit it \(prices ÷ 8\): "holds 1390 on the 1h"/)
    const holding = buildSplitRestated({ id: 'h', kind: 'portfolio_item', userId: 'u2', direction: 'long' }, SLQT, { before: { quantity: 90 }, after: { quantity: 4.5 } })
    assert.match(holding.content, /Your LONG SLQT holding was restated — prices × 20, shares ÷ 20\. 90 sh → 4\.5 sh\.$/)
    assert.equal(holding.payload.ideaId, 'h')
})

test('restateOpenTrades: each trade once, a live one re-reads the broker, a failure stops nothing', async () => {
    const claimed = new Set(), cards = [], journal = [], live = []
    const io = {
        findTrades: async () => [idea(), { ...setup(), id: 's1' }, { ...idea(), id: 'bad' }],
        claimTrade: async (id, date, set) => {
            if (id === 'bad') throw new Error('db down')
            if (claimed.has(id)) return false
            claimed.add(id); return true
        },
        journal: async (id, e) => journal.push([id, e.reason]),
        restateVenue: async () => ({ positions: 1, orders: 0 }),
        restateLedger: async () => { throw new Error('ledger down') },
        reconcileLive: async (t) => { live.push([t.id, t.position_state.stop.current]); return { notes: ['stop moved to 168.75 at the broker'] } },
        notify: async (t, s, summary) => cards.push([t.id, summary.flags.length, summary.notes.length, summary.after.quantity]),
        dropCandles: () => { throw new Error('cache') },
    }
    const out = await restateOpenTrades(SNDK, io)
    assert.deepEqual(out.venue, { positions: 1, orders: 0 })
    assert.equal(out.ledger, 0, 'the ledger failed and the trades went on')
    assert.deepEqual(out.trades.map(t => t.id), ['i1', 's1'])
    assert.deepEqual(live, [['s1', 168.75]], 'only the live trade, with its copies already restated')
    assert.deepEqual(cards, [['i1', 1, 0, 40], ['s1', 3, 1, 32]])
    assert.deepEqual(journal, [['i1', 'split_restated'], ['s1', 'split_restated']])
    // Twice is once.
    assert.equal((await restateOpenTrades(SNDK, io)).trades.length, 0)
})

// A fake broker + entity repo for reconcileSplit. `doc` is what the repo's fresh read returns (our restated copies).
function liveHarness({ doc, position = { volume: 40 }, working = [], amendId = null, findThrows = false, listThrows = false }) {
    const calls = []
    let current = structuredClone(doc)
    const restore = _setReconcilerDeps({
        brokerService: {
            findOpenPosition: async (b, u, a, pid) => { if (findThrows) throw new Error('timeout'); return typeof position === 'function' ? position(pid) : position },
            listOrders: async () => { if (listThrows) throw new Error('timeout'); return working },
            amendOrder: async (b, u, a, id, f) => { calls.push(['amend', id, f]); return amendId ? { orderId: amendId } : undefined },
            placeOrder: async (b, u, a, order) => { calls.push(['place', order.quantity, order.positionId ?? null]); return { orderId: 'new' } },
        },
        entityRepo: {
            getById: async () => structuredClone(current),
            setLegQuantity: async (id, p) => calls.push(['leg', p.positionId, p.quantity]),
            setExitOrders: async (id, orders) => { calls.push(['exits', orders.map(o => `${o.orderId}:${o.status}`)]); current = { ...current, exitOrders: orders } },
            patch: async (id, f) => calls.push(['patch', f.brokerOrders.map(b => b.orderId)]),
        },
    })
    return { calls, restore }
}
const LIVE = () => ({
    id: 'L', userId: 'u', asset: 'SNDK', direction: 'long', mode: 'live', basisOffset: 0, entryTriggerPrice: null, quantity: 40,
    brokerOrders: [{ broker: 'ctrader', accountId: 'A', orderId: 'e0', positionId: 'P', quantity: 32 }],
    exitOrders: [
        { broker: 'ctrader', accountId: 'A', leg: 'stop', type: 'stop', price: 162.5, quantity: 40, orderId: 'kept', status: 'working', positionId: 'P' },
        { broker: 'ctrader', accountId: 'A', leg: 'tp', type: 'limit', price: 212.5, quantity: 20, orderId: 'old', status: 'working', positionId: 'P' },
        { broker: 'ctrader', accountId: 'A', leg: 'tp', type: 'limit', price: 225, quantity: 20, orderId: 'gone', status: 'working', positionId: 'P' },
    ],
})

test('the live re-read: a broker-restated order kept, an old-price one amended (its new id kept), a cancelled one re-placed', async () => {
    const h = liveHarness({ doc: LIVE(), working: [{ orderId: 'kept', price: 162.5 }, { orderId: 'old', price: 1700 }], amendId: 'old2' })
    try {
        const { notes } = await executionReconciler.reconcileSplit(LIVE())
        assert.deepEqual(h.calls, [['leg', 'P', 40], ['amend', 'old', { limitPrice: 212.5 }], ['place', 20, 'P'], ['exits', ['kept:working', 'old2:working', 'new:working']]])
        assert.deepEqual(notes, ['the broker holds 40 shares', 'tp moved to 212.5 at the broker', 'tp was gone at the broker — re-placed at 225'])
        assert.equal(sameOrderPrice(162.51, 162.5), true)
        assert.equal(sameOrderPrice(1300, 162.5), false)
    } finally { h.restore() }
})

test('the live re-read works on a FRESH read under the lock — a fill recorded meanwhile is not written over', async () => {
    const fresh = LIVE()
    fresh.exitOrders[0] = { ...fresh.exitOrders[0], status: 'filled' }   // the stop filled while the split was being restated
    const h = liveHarness({ doc: fresh, working: [{ orderId: 'old', price: 1700 }] })
    try {
        await executionReconciler.reconcileSplit(LIVE())   // the caller's copy still says 'working'
        const exits = h.calls.find(c => c[0] === 'exits')[1]
        assert.equal(exits[0], 'kept:filled', 'the fill stands')
        assert.equal(h.calls.some(c => c[0] === 'place' && c[1] === 40), false, 'the filled stop is not re-placed')
    } finally { h.restore() }
})

test('a position GONE at the broker: its missing exits are cancelled, nothing is placed', async () => {
    const h = liveHarness({ doc: LIVE(), position: null, working: [{ orderId: 'kept', price: 162.5 }] })
    try {
        const { notes } = await executionReconciler.reconcileSplit(LIVE())
        assert.equal(h.calls.some(c => c[0] === 'place' || c[0] === 'amend'), false)
        assert.deepEqual(h.calls.find(c => c[0] === 'exits')[1], ['kept:working', 'old:cancelled', 'gone:cancelled'])
        assert.deepEqual(notes, ['the position is closed at the broker'])
    } finally { h.restore() }
})

test('a position the broker cannot read: amends only, nothing placed; orders unreadable: nothing at all', async () => {
    const h = liveHarness({ doc: LIVE(), findThrows: true, working: [{ orderId: 'old', price: 1700 }] })
    try {
        const { notes } = await executionReconciler.reconcileSplit(LIVE())
        assert.equal(h.calls.some(c => c[0] === 'place'), false)
        assert.deepEqual(h.calls.filter(c => c[0] === 'amend').map(c => c[1]), ['old'])
        assert.match(notes.join(' | '), /position could not be read.*tp at 225 is not at the broker and the position could not be read — check it/)
    } finally { h.restore() }
    const h2 = liveHarness({ doc: LIVE(), listThrows: true })
    try {
        const { notes } = await executionReconciler.reconcileSplit(LIVE())
        assert.deepEqual(h2.calls, [['leg', 'P', 40]])
        assert.match(notes.at(-1), /orders could not be read at the broker.*check them/)
    } finally { h2.restore() }
})

test('two positions in one account: each position\'s exits sized by ITS position, never the other\'s', async () => {
    const doc = {
        ...LIVE(),
        brokerOrders: [{ broker: 'ctrader', accountId: 'A', positionId: 'P1', quantity: 100 }, { broker: 'ctrader', accountId: 'A', positionId: 'P2', quantity: 50 }],
        exitOrders: [
            { broker: 'ctrader', accountId: 'A', leg: 'stop', type: 'stop', price: 10, quantity: 100, orderId: 's1', status: 'working', positionId: 'P1' },
            { broker: 'ctrader', accountId: 'A', leg: 'stop', type: 'stop', price: 10, quantity: 50, orderId: 's2', status: 'working', positionId: 'P2' },
        ],
    }
    const h = liveHarness({ doc, position: (pid) => ({ volume: pid === 'P1' ? 100 : 50 }), working: [] })
    try {
        await executionReconciler.reconcileSplit(doc)
        assert.deepEqual(h.calls.filter(c => c[0] === 'place'), [['place', 100, 'P1'], ['place', 50, 'P2']])
    } finally { h.restore() }
})

test('a resting entry at the old price is amended, and its link takes the id the broker answers with', async () => {
    const doc = { ...LIVE(), entryTriggerPrice: 178.5, entryOrderType: 'limit', exitOrders: [], brokerOrders: [{ broker: 'ctrader', accountId: 'A', orderId: 'entry', positionId: null, quantity: 40 }] }
    const h = liveHarness({ doc, working: [{ orderId: 'entry', price: 1428 }], amendId: 'entry2' })
    try {
        const r = await executionReconciler.reconcileSplit(doc)
        assert.deepEqual(h.calls, [['amend', 'entry', { limitPrice: 178.5 }], ['patch', ['entry2']]])
        assert.deepEqual(r.notes, ['the entry order moved to 178.5'])
    } finally { h.restore() }
})

test('the sweep over a db: only names something is open on, every row once, trades saved after the split left alone', async () => {
    const { db, rows } = memDb()
    const before = splitDayMs('2026-11-20')
    rows('entities').push({ ...idea(), savedAt: before - 1000 }, { ...idea(), id: 'after', savedAt: before + 1000 }, { ...idea(), id: 'shut', status: 'closed', savedAt: 1 })
    rows('paperPositions').push(
        { positionId: 'p1', symbol: 'SNDK', status: 'open', qty: 5, avgPrice: 1428.1428, currentPrice: 79.24, markedAt: before + 5, openedAt: before - 10, direction: 'long' },
        { positionId: 'p2', symbol: 'SNDK', status: 'open', qty: 40, avgPrice: 100, openedAt: before + 10, direction: 'long' },
    )
    rows('paperOrders').push({ orderId: 'o9', symbol: 'SNDK', status: 'working', triggerPrice: 1300, qty: 5, createdAt: before - 10 })
    rows('trades').push({ tradeId: 't1', symbol: 'SNDK', status: 'open', quantity: 5, entry: { price: 1428, ts: before - 10 } })
    const cards = []
    _setSplitSweepIO({ db: async () => db, splits: async () => [SNDK, { ...SNDK, symbol: 'ZZZZ' }] })
    // The sweep's own IO over this db, its card and journal kept off the real transports.
    const io = { ..._tradeIO(db), notify: async (t) => cards.push(t.id), journal: async () => {} }
    const { restateOpenTrades: run } = await import('../../services/tradeSplit.service.js')
    const res = await run(SNDK, io)
    assert.deepEqual([res.trades.map(t => t.id), res.venue, res.ledger], [['i1'], { positions: 1, orders: 1 }, 1])
    const e = rows('entities')
    assert.deepEqual([e[0].quantity, e[0].split_through, e[1].quantity, e[2].quantity], [40, '2026-11-20', 5, 5])
    assert.deepEqual([rows('paperPositions')[0].qty, rows('paperPositions')[0].avgPrice, rows('paperPositions')[1].qty], [40, 178.52, 40])
    assert.deepEqual([rows('paperOrders')[0].triggerPrice, rows('paperOrders')[0].qty], [162.5, 40])
    assert.deepEqual([rows('trades')[0].quantity, rows('trades')[0].entry.price], [40, 178.5])
    assert.deepEqual(cards, ['i1'])
    const again = await run(SNDK, io)
    assert.deepEqual([again.trades.length, again.venue, again.ledger], [0, { positions: 0, orders: 0 }, 0], 'twice is once')
    // _tick: ZZZZ has nothing open → never restated; SNDK has nothing left to do.
    const tick = await _tick()
    assert.deepEqual([tick.splits, tick.restated], [2, []])
})

test('a split drops the name\'s cached candles, and only that name\'s', () => {
    assert.equal(typeof dropCandleCache('SNDK'), 'number')
})

// ── code review 2026-11-22 ──

test('days are New York days: the evening before a split is still before it; DST is honoured', async () => {
    const { etDay, etMidnightMs, splitsAfter, _setCorporateActionsIO, recentSplits } = await import('../../services/corporateActions.service.js')
    assert.equal(etDay(Date.parse('2026-11-20T01:30:00Z')), '2026-11-19', '20:30 ET on the 19th')
    assert.equal(etMidnightMs('2026-11-20'), Date.parse('2026-11-20T05:00:00Z'), 'EST')
    assert.equal(etMidnightMs('2026-07-01'), Date.parse('2026-07-01T04:00:00Z'), 'EDT')
    // 20:00 ET the evening before: tomorrow's split is not yet "today".
    _setCorporateActionsIO({ now: () => Date.parse('2026-11-20T01:00:00Z'), calendar: async () => [{ symbol: 'SNDK', date: '2026-11-20', numerator: 8, denominator: 1 }] })
    assert.deepEqual(await recentSplits(), [])
    _setCorporateActionsIO({ now: () => Date.parse('2026-11-20T05:30:00Z') })
    assert.deepEqual((await recentSplits()).map(s => s.date), ['2026-11-20'])
    _setCorporateActionsIO({ calendar: async () => [], now: () => Date.now() })
    assert.equal(splitsAfter([{ symbol: 'X', date: '2026-11-20', numerator: 2, denominator: 1 }], 'X', '2026-11-19', '2026-11-20').length, 1)
})

test('a call made the evening before a split is pre-split; a coverage target set then is caught', async () => {
    const { splitAdjustedCall } = await import('../../services/prometheusCalls.service.js')
    const call = { id: 'c', made_at: '2026-11-20T01:30:00.000Z', pt: 1710, entry: { day: '2026-11-20', price: 104 }, done: false }
    assert.deepEqual(splitAdjustedCall(call, { date: '2026-11-20', ratio: 8 }), { splits_applied: ['2026-11-20'], pt: 213.75 }, 'its entry is the split day close, post-split')
    const { _catchSplits } = await import('../../monitoring/coverage.monitor.service.js')
    const asked = []
    await _catchSplits({ id: 'k', symbol: 'SNDK', price_target: { value: 1710, set_at: '2026-11-20T01:30:00.000Z' } }, { getSplits: async (s, since) => { asked.push(since); return [] }, applySplit: async () => ({}) })
    assert.deepEqual(asked, ['2026-11-19'])
})

test('estimates: only a per-share key is restated, word by word, nested too; a growth % never; an EV/sales metric never', async () => {
    const { perShareKey, splitAdjustment } = await import('../../api/analyst/coverage.service.js')
    for (const k of ['eps', 'eps_fy1', 'EPS_NTM', 'dps_fy2', 'bvps', 'fcf_per_share', 'book_value_per_share']) assert.equal(perShareKey(k), true, k)
    for (const k of ['eps_growth_pct', 'eps_cagr', 'eps_yoy', 'eps_surprise_pct', 'revenue_fy1', 'reps', 'steps', 'deps', 'eps_revisions', 'payout_ratio']) assert.equal(perShareKey(k), false, k)
    const set = splitAdjustment({
        estimates: { ours: { eps_fy1: 6.25, eps_growth_pct: 24, fy2026: { eps: 8, revenue: 1000 }, eps: { low: 5, high: 7 } } },
        risk_reward: { base: { value: 800, multiple: 4, forward_metric: 200 }, bull: { value: 1000, multiple: 10, forward_metric: 100 } },
    }, 8)
    assert.equal(set['estimates.ours.eps_fy1'], 0.7813)
    assert.equal('estimates.ours.eps_growth_pct' in set, false)
    assert.equal(set['estimates.ours.fy2026.eps'], 1)
    assert.equal('estimates.ours.fy2026.revenue' in set, false)
    assert.deepEqual([set['estimates.ours.eps.low'], set['estimates.ours.eps.high']], [0.625, 0.875])
    assert.equal(set['risk_reward.base.forward_metric'], 25, '4 × 200 = 800: per share')
    assert.equal(set['risk_reward.bull.value'], 125)
    assert.equal('risk_reward.bull.forward_metric' in set, true, '10 × 100 = 1000: per share')
    const evs = splitAdjustment({ risk_reward: { base: { value: 80, multiple: 3, forward_metric: 5000 } } }, 8)
    assert.deepEqual([evs['risk_reward.base.value'], 'risk_reward.base.forward_metric' in evs], [10, false], 'revenue is not per share')
})

test('a draft set-price is never taken, with or without a price read', async () => {
    const { withTargetRef } = await import('../../api/analyst/coverage.service.js')
    assert.deepEqual(withTargetRef({ value: 60, set_at: 'b', ref_price: 50, sigma_pct: 9 }, { set_at: 'a', ref_price: 40 }, null), { value: 60, set_at: 'b' })
    assert.deepEqual(withTargetRef({ value: 60, set_at: 'a', ref_price: 50 }, { set_at: 'a', ref_price: 40 }, null), { value: 60, set_at: 'a', ref_price: 40 }, 'reaffirmed: the stored one')
})

test('an idea saved before `kind` existed is found and restated too', async () => {
    const { db, rows } = memDb()
    const before = splitDayMs('2026-11-20')
    const legacy = { ...idea(), id: 'legacy', savedAt: before - 1 }
    delete legacy.kind
    rows('entities').push(legacy)
    const found = await _tradeIO(db).findTrades('SNDK', before, '2026-11-20')
    assert.deepEqual(found.map(t => t.id), ['legacy'])
})

test('an edit catches up first: a split the trade has not been through is restated, once', async () => {
    const { db, rows } = memDb()
    const before = splitDayMs('2026-11-20')
    rows('entities').push({ ...idea(), id: 'e1', savedAt: before - 1000, mode: 'paper' }, { ...idea(), id: 'e2', savedAt: before + 1000 })
    const { _setCorporateActionsIO } = await import('../../services/corporateActions.service.js')
    _setCorporateActionsIO({ now: () => before + 3_600_000, calendar: async () => [{ symbol: 'SNDK', date: '2026-11-20', numerator: 8, denominator: 1 }] })
    _setSplitSweepIO({ db: async () => db, notify: async () => null })
    const { ensureRestated } = await import('../../monitoring/splitSweep.service.js')
    try {
        const first = await ensureRestated('e1')
        assert.deepEqual([first.doc.quantity, first.doc.split_through, first.splits.map(s => s.ratio)], [40, '2026-11-20', [8]])
        const again = await ensureRestated('e1')
        assert.deepEqual([again.doc.quantity, again.splits], [40, []], 'once')
        const later = await ensureRestated('e2')
        assert.deepEqual([later.doc.quantity, later.splits], [5, []], 'saved after the split: post-split already')
        assert.deepEqual(await ensureRestated('nope'), { doc: null, splits: [] })
    } finally { _setCorporateActionsIO({ calendar: async () => [], now: () => Date.now() }) }
})

test('a manage proposal made before the split is restated with its trade; one made after it is not', async () => {
    const { restateProposal } = await import('../../services/tradeSplit.service.js')
    const s = [{ date: '2026-11-20', ratio: 8 }]
    assert.deepEqual(restateProposal({ new_stop: 1380, size_pct: 50 }, s, Date.parse('2026-11-19T15:00:00Z')), { new_stop: 172.5, size_pct: 50 })
    assert.deepEqual(restateProposal({ new_stop: 172.5 }, s, Date.parse('2026-11-20T15:00:00Z')), { new_stop: 172.5 })
    assert.deepEqual(restateProposal({ new_stop: 1380, quantity: 5 }, s, null), { new_stop: 172.5, quantity: 40 }, 'no time: it rode an unrestated trade')
    assert.deepEqual(restateProposal({ new_stop: 1380 }, []), { new_stop: 1380 })
})

test('applyManage catches the trade up before the broker', async () => {
    const { applyManage } = await import('../../services/positionManage.service.js')
    const seen = []
    const fresh = { ...setup(), id: 's1', broker: 'manual', status: 'long' }
    const res = await applyManage({
        entity: { ...fresh, quantity: 4 }, holder: { ...fresh, quantity: 4 }, verb: 'move_stop', proposal: { new_stop: 1380 }, userId: 'u1',
        proposedAtMs: Date.parse('2026-11-19T15:00:00Z'),
        deps: { ensureRestated: async (id) => { seen.push(id); return { doc: { ...fresh, quantity: 32 }, splits: [{ date: '2026-11-20', ratio: 8 }] } } },
    })
    assert.deepEqual(seen, ['s1'])
    assert.equal(res.selfExecuted, true, 'a manual venue: the executor does nothing past the catch-up')
})
