import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitDraft, correctHolding, removeHolding, normalizeHolding, _pastOnly, _setDeps } from '../../api/portfolio/adoptBook.service.js'
import { bornLiveStamp } from '../../api/trade-ideas/tradeIdeas.service.js'

// Adopting a book the app didn't build (docs/design/adopted-book.md). What is pinned here is the
// JUDGMENT: what refuses, what a retry must not do twice, and the order the lifecycle is stamped in.
// Every IO is injected, so none of this needs a DB, a price feed or a model.

const OK_REC = { costBasis: 30_000, marketValue: 40_000, unpriced: [], freeCash: 10_000, startingBalance: 40_000, problems: [] }
const BOUGHT_2020 = 1_600_000_000_000

function draftDoc(over = {}) {
    return {
        draftId: 'd1', userId: 'u1', status: 'draft', bank: 'Bank', currency: 'USD',
        portfolioId: 'portfolio_1', accountId: null, positions: {},
        holdings: [
            { symbol: 'AAPL', quantity: 100, avgCost: 150, mark: 200, direction: 'long', openedAt: BOUGHT_2020, why: 'compounder', asset_class: null },
            { symbol: 'MSFT', quantity: 50,  avgCost: 300, mark: 400, direction: 'long', openedAt: null,        why: null,         asset_class: null },
        ],
        reconciliation: OK_REC,
        mandate: { objective: 'growth', benchmark: 'S&P 500', reviewCadence: 'quarterly' },
        ...over,
    }
}

function stubs(over = {}) {
    const calls = { positions: [], batch: [], captures: [], lifecycle: [], fingerprint: [], status: [], recorded: [], seq: [] }
    const base = {
        store: {
            getDraft:       async () => draftDoc(),
            recordAccount:  async (_d, _u, a) => { calls.recorded.push(['account', a]) },
            recordPosition: async (_d, _u, s, p) => { calls.recorded.push(['position', s, p]) },
            setStatus:      async (_d, _u, st, patch) => { calls.seq.push('status'); calls.status.push([st, patch]) },
            claimDraft:     async () => { calls.seq.push('claim'); return true },
            releaseDraft:   async () => { calls.seq.push('release') },
            deleteDraft:    async () => true,
            listDrafts:     async () => [],
        },
        createAccount:  async () => ({ accountId: 'manual-u1-1' }),
        openPosition:   async (args) => { calls.positions.push(args); return `pos-${args.symbol}` },
        saveBatch:      async (plan, _userId, opts) => {
            calls.seq.push('batch')
            calls.batch.push({ plan, opts })
            return {
                ok: true, failed: [],
                ideas: plan.ideas.map((l, i) => ({
                    id: `e${i}`, asset: l.asset, direction: l.direction, quantity: l.quantity,
                    ordersPlacedAt: l.fill.at,
                    brokerOrders: [{ broker: 'manual', accountId: opts.mainAccountId, positionId: l.fill.positionId, quantity: l.quantity }],
                })),
            }
        },
        legsFor:      async () => [],
        setMandate:   async () => {},
        setLifecycle: async (_p, _u, patch) => { calls.seq.push('lifecycle'); calls.lifecycle.push(patch) },
        fingerprint:  async (_p, _u, reason) => { calls.seq.push('fingerprint'); calls.fingerprint.push(reason) },
        captureOpen:  async (idea, exec) => { calls.captures.push({ asset: idea.asset, exec }) },
        quotes:       async () => new Map(),
        getEntity:    async () => null,
        patchEntity:  async () => {},
        deleteEntity: async () => true,
        getPosition:  async () => null,
        updatePosition: async () => {},
        dropCapture:  async () => true,
    }
    const deps = { ...base, ...over, store: { ...base.store, ...(over.store ?? {}) } }
    return { deps, calls }
}

// ─── Commit ─────────────────────────────────────────────────────────────────────

test('commit writes positions at the historical date, then one born-live batch', async () => {
    const { deps, calls } = stubs()
    const restore = _setDeps(deps)
    try {
        const res = await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(res.ok, true)
        assert.equal(res.legs, 2)

        // The REAL open date rides through — an adopted lot is routinely years old.
        const aapl = calls.positions.find(p => p.symbol === 'AAPL')
        assert.equal(aapl.openedAt, BOUGHT_2020)
        assert.equal(aapl.price, 150, 'opened at what the user paid, not at the mark')
        // Unknown purchase date stays null; openManualPosition defaults it to now.
        assert.equal(calls.positions.find(p => p.symbol === 'MSFT').openedAt, null)

        const { plan, opts } = calls.batch[0]
        assert.equal(opts.born, 'live', 'legs are born in position — there is nothing to activate')
        assert.equal(opts.mainAccountId, 'manual-u1-1')
        assert.deepEqual(plan.ideas.map(l => l.asset), ['AAPL', 'MSFT'])
        assert.equal(plan.ideas[0].adopted, true)
        assert.equal(plan.ideas[0].notes, 'compounder', "the user's own reason rides the notes channel")
        assert.equal(plan.ideas[0].fill.positionId, 'pos-AAPL')
        assert.equal(plan.ideas[0].fill.at, BOUGHT_2020)
    } finally { restore() }
})

test('the ledger records what we paid, and the fingerprint is stamped LAST', async () => {
    const { deps, calls } = stubs()
    const restore = _setDeps(deps)
    try {
        await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(calls.captures.length, 2)
        assert.equal(calls.captures.find(c => c.asset === 'MSFT').exec.price, 300)

        // The fingerprint is the "then" baseline every later review diffs against, so it has to read
        // a book that already exists. Ordering is the assertion.
        assert.deepEqual(calls.seq, ['claim', 'batch', 'lifecycle', 'fingerprint', 'status'])
        assert.deepEqual(calls.fingerprint, ['adoption'])
    } finally { restore() }
})

test('the lifecycle carries the mandate cadence, its next review and the spine state', async () => {
    const { deps, calls } = stubs()
    const restore = _setDeps(deps)
    try {
        await commitDraft({ draftId: 'd1', userId: 'u1' })
        const [patch] = calls.lifecycle
        assert.equal(patch.reviewCadence, 'quarterly')
        assert.equal(patch.benchmark, 'S&P 500')
        assert.equal(patch.spine_state, 'adopted')
        assert.ok(patch.nextReviewAt > Date.now(), 'scheduled forward off the shared cadence table')
    } finally { restore() }
})

test('a book with no cadence gets one stated, not Themis\'s weekly fallback', async () => {
    const { deps, calls } = stubs({ store: { getDraft: async () => draftDoc({ mandate: { objective: 'income' } }) } })
    const restore = _setDeps(deps)
    try {
        await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(calls.lifecycle[0].reviewCadence, 'monthly', 'weekly is the wrong clock for buy-and-hold')
    } finally { restore() }
})

test('an unreconciled draft refuses and writes NOTHING', async () => {
    const bad = { ...OK_REC, problems: ['account_value_below_holdings'], startingBalance: null }
    const { deps, calls } = stubs({ store: { getDraft: async () => draftDoc({ reconciliation: bad }) } })
    const restore = _setDeps(deps)
    try {
        const res = await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(res.ok, false)
        assert.equal(res.reason, 'unreconciled')
        assert.deepEqual(res.problems, ['account_value_below_holdings'])
        assert.equal(calls.positions.length, 0)
        assert.equal(calls.batch.length, 0)
    } finally { restore() }
})

test('an already-committed draft cannot be spent twice', async () => {
    const { deps, calls } = stubs({ store: { getDraft: async () => draftDoc({ status: 'committed' }) } })
    const restore = _setDeps(deps)
    try {
        const res = await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(res.reason, 'already_committed')
        assert.equal(calls.batch.length, 0)
    } finally { restore() }
})

test('an empty book refuses — the arithmetic allows it, the judgment does not', async () => {
    const { deps } = stubs({ store: { getDraft: async () => draftDoc({ holdings: [] }) } })
    const restore = _setDeps(deps)
    try {
        assert.equal((await commitDraft({ draftId: 'd1', userId: 'u1' })).reason, 'no_holdings')
    } finally { restore() }
})

test('a retry reuses a position recorded by the interrupted attempt', async () => {
    // The window the entity check cannot close: the position was written, its entity was not.
    const { deps, calls } = stubs({ store: { getDraft: async () => draftDoc({ positions: { AAPL: 'pos-old' } }) } })
    const restore = _setDeps(deps)
    try {
        await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.deepEqual(calls.positions.map(p => p.symbol), ['MSFT'], 'AAPL is NOT opened a second time')
        assert.equal(calls.batch[0].plan.ideas.find(l => l.asset === 'AAPL').fill.positionId, 'pos-old')
    } finally { restore() }
})

test('a retry reuses the account the interrupted attempt opened', async () => {
    let created = 0
    const { deps } = stubs({
        createAccount: async () => { created++; return { accountId: 'x' } },
        store: { getDraft: async () => draftDoc({ accountId: 'manual-u1-1' }) },
    })
    const restore = _setDeps(deps)
    try {
        await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(created, 0, 'a second account would split the book in two')
    } finally { restore() }
})

test('a leg that already exists is skipped entirely — the entity collection is the truth', async () => {
    const { deps, calls } = stubs({ legsFor: async () => [{ asset: 'aapl' }] })   // case-insensitive
    const restore = _setDeps(deps)
    try {
        const res = await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(res.ok, true)
        assert.deepEqual(calls.positions.map(p => p.symbol), ['MSFT'])
        assert.deepEqual(calls.batch[0].plan.ideas.map(l => l.asset), ['MSFT'])
    } finally { restore() }
})

test('a half-written book is NOT a success, and stays resumable', async () => {
    const { deps, calls } = stubs({
        saveBatch: async (plan) => ({ ok: true, ideas: [], failed: [{ asset: plan.ideas[0].asset, reason: 'no_venue' }] }),
    })
    const restore = _setDeps(deps)
    try {
        const res = await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(res.ok, false)
        assert.equal(res.reason, 'partial_write')
        assert.deepEqual(res.failed, [{ asset: 'AAPL', reason: 'no_venue' }])
        assert.equal(calls.fingerprint.length, 0, 'no baseline for a book that is not whole')
        assert.equal(calls.status.length, 0, 'the draft stays open so the same call can finish it')
    } finally { restore() }
})

test('a position that fails to open is reported, not silently dropped', async () => {
    const { deps, calls } = stubs({
        openPosition: async (args) => {
            if (args.symbol === 'MSFT') throw new Error('store down')
            return `pos-${args.symbol}`
        },
    })
    const restore = _setDeps(deps)
    try {
        const res = await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(res.reason, 'partial_write')
        assert.ok(res.failed.some(f => f.asset === 'MSFT' && f.reason === 'position_failed'))
        assert.deepEqual(calls.batch[0].plan.ideas.map(l => l.asset), ['AAPL'], 'the healthy leg still lands')
    } finally { restore() }
})

test('a second commit of the same draft is refused while the first is in flight', async () => {
    const { deps, calls } = stubs({ store: { claimDraft: async () => false } })
    const restore = _setDeps(deps)
    try {
        const res = await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(res.reason, 'in_progress')
        assert.equal(calls.positions.length, 0, 'a double-clicked commit must not open a twin position')
    } finally { restore() }
})

test('a refusal never takes the claim — a bad draft must not be locked', async () => {
    const bad = { ...OK_REC, problems: ['negative_cash'], startingBalance: null }
    let claimed = false
    const { deps } = stubs({
        store: { getDraft: async () => draftDoc({ reconciliation: bad }), claimDraft: async () => { claimed = true; return true } },
    })
    const restore = _setDeps(deps)
    try {
        await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(claimed, false, 'validation happens before the claim is taken')
    } finally { restore() }
})

test('a partial write hands the claim straight back, so a retry is not made to wait', async () => {
    const { deps, calls } = stubs({
        saveBatch: async (plan) => ({ ok: true, ideas: [], failed: [{ asset: plan.ideas[0].asset, reason: 'no_venue' }] }),
    })
    const restore = _setDeps(deps)
    try {
        await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.ok(calls.seq.includes('release'), 'every step is idempotent — retrying at once is correct')
    } finally { restore() }
})

test('a resumed commit still captures the ledger for legs written by the earlier attempt', async () => {
    // The lost-row case: attempt 1 wrote AAPL's entity then died before its capture. The retry skips
    // the leg (it exists), so capturing only what THIS pass wrote would lose that row for good.
    const existingLeg = {
        id: 'e-old', asset: 'AAPL', direction: 'long', quantity: 100, ordersPlacedAt: BOUGHT_2020,
        brokerOrders: [{ broker: 'manual', accountId: 'manual-u1-1', positionId: 'pos-old', quantity: 100 }],
    }
    const { deps, calls } = stubs({
        legsFor: async () => [existingLeg],
        saveBatch: async (plan, _u, opts) => ({
            ok: true, failed: [],
            ideas: plan.ideas.map((l, i) => ({
                id: `e${i}`, asset: l.asset, direction: l.direction, quantity: l.quantity, ordersPlacedAt: l.fill.at,
                brokerOrders: [{ broker: 'manual', accountId: opts.mainAccountId, positionId: l.fill.positionId, quantity: l.quantity }],
            })),
        }),
    })
    const restore = _setDeps(deps)
    try {
        const res = await commitDraft({ draftId: 'd1', userId: 'u1' })
        assert.equal(res.ok, true)
        const captured = calls.captures.map(c => c.asset).sort()
        assert.deepEqual(captured, ['AAPL'], 'the pre-existing leg is re-captured (an idempotent upsert)')
        assert.equal(res.legs, 1, 'reports the BOOK, not just this pass')
    } finally { restore() }
})

// ─── Born-live stamps (the shared writer's one parameter) ────────────────────────

test('bornLiveStamp puts a leg in position with the entry already placed', () => {
    const s = bornLiveStamp({ direction: 'long', fill: { broker: 'manual', accountId: 'a1', positionId: 'p1', quantity: 100, at: BOUGHT_2020 } })
    assert.equal(s.status, 'long')
    assert.equal(s.ordersPlacedAt, BOUGHT_2020, 'the double-place guard, dated when it really happened')
    assert.equal(s.activatedAt, BOUGHT_2020)
    assert.equal(s.orderState, 'placed')
    assert.equal(s.immediate, undefined)
    // No broker order ever existed, so the position is the record on both ids.
    assert.deepEqual(s.brokerOrders, [{ broker: 'manual', accountId: 'a1', orderId: 'p1', positionId: 'p1', quantity: 100 }])
})

test('bornLiveStamp respects a short book', () => {
    const s = bornLiveStamp({ direction: 'short', fill: { broker: 'manual', accountId: 'a1', positionId: 'p1', quantity: 5, at: 1 } })
    assert.equal(s.status, 'short')
})

// ─── Repair ─────────────────────────────────────────────────────────────────────

const ADOPTED_LEG = {
    id: 'e1', userId: 'u1', asset: 'AAPL', status: 'long', quantity: 100, adopted: true,
    brokerOrders: [{ broker: 'manual', accountId: 'manual-u1-1', positionId: 'pos-1', quantity: 100 }],
}

test('correcting a holding moves no money — it was a typo, not a trade', async () => {
    const posSets = [], legSets = []
    const { deps } = stubs({
        getEntity:      async () => ADOPTED_LEG,
        updatePosition: async (_u, id, set) => posSets.push([id, set]),
        patchEntity:    async (_id, set) => legSets.push(set),
    })
    const restore = _setDeps(deps)
    try {
        const res = await correctHolding({ id: 'e1', userId: 'u1', quantity: 80, avgCost: 155 })
        assert.equal(res.ok, true)
        assert.deepEqual(posSets, [['pos-1', { qty: 80, avgPrice: 155 }]])
        assert.equal(legSets[0].quantity, 80)
        assert.equal(legSets[0].brokerOrders[0].quantity, 80, 'the link tracks the corrected size')
        // Nothing here banks P&L or touches cash — that is what makes it a correction and not a trim.
    } finally { restore() }
})

test('correction refuses a holding the app actually decided', async () => {
    const { deps } = stubs({ getEntity: async () => ({ ...ADOPTED_LEG, adopted: undefined }) })
    const restore = _setDeps(deps)
    try {
        assert.equal((await correctHolding({ id: 'e1', userId: 'u1', quantity: 80 })).reason, 'not_adopted')
    } finally { restore() }
})

test('correction refuses another user, and refuses saying nothing', async () => {
    const { deps } = stubs({ getEntity: async () => ADOPTED_LEG })
    const restore = _setDeps(deps)
    try {
        assert.equal((await correctHolding({ id: 'e1', userId: 'someone-else' })).reason, 'forbidden')
        assert.equal((await correctHolding({ id: 'e1', userId: 'u1' })).reason, 'nothing_to_correct')
        assert.equal((await correctHolding({ id: 'e1', userId: 'u1', quantity: -4 })).reason, 'bad_quantity')
    } finally { restore() }
})

test('removing a holding marks the position removed — never closed', async () => {
    const posSets = []
    let deleted = false, dropped = null
    const { deps } = stubs({
        getEntity:      async () => ADOPTED_LEG,
        updatePosition: async (_u, id, set) => posSets.push([id, set]),
        deleteEntity:   async () => { deleted = true; return true },
        dropCapture:    async (args) => { dropped = args; return true },
    })
    const restore = _setDeps(deps)
    try {
        const res = await removeHolding({ id: 'e1', userId: 'u1' })
        assert.equal(res.ok, true)
        assert.equal(posSets[0][1].status, 'removed', 'a close would book P&L for a sale that never happened')
        assert.equal(posSets[0][1].realizedPnl, undefined)
        assert.equal(deleted, true)
        // Otherwise an `open` trade for a position that no longer exists reads as a live holding.
        assert.deepEqual(dropped, { accountId: 'manual-u1-1', positionId: 'pos-1' })
    } finally { restore() }
})

test('removal refuses anything the app placed itself', async () => {
    const { deps } = stubs({ getEntity: async () => ({ ...ADOPTED_LEG, adopted: false }) })
    const restore = _setDeps(deps)
    try {
        assert.equal((await removeHolding({ id: 'e1', userId: 'u1' })).reason, 'not_adopted')
    } finally { restore() }
})

// ─── Intake coercion ────────────────────────────────────────────────────────────

test('normalizeHolding accepts what a paste actually looks like', () => {
    const h = normalizeHolding({ ticker: ' aapl ', quantity: '100', avg_cost: '150.25', why: '  compounder ' })
    assert.equal(h.symbol, 'AAPL')
    assert.equal(h.quantity, 100)
    assert.equal(h.avgCost, 150.25)
    assert.equal(h.why, 'compounder')
    assert.equal(h.direction, 'long', 'long-only v1, but the field is real')
    assert.equal(h.openedAt, null)
})

test('normalizeHolding leaves junk as null for the grid to flag', () => {
    const h = normalizeHolding({ symbol: 'MSFT', quantity: 'abc', avgCost: '' })
    assert.equal(h.quantity, null)
    assert.equal(h.avgCost, null)
})

test('a purchase date can only be in the past', () => {
    // A mistyped year would otherwise open a position in the future: a negative holding period, and a
    // fill dated after the trade row that records it.
    const now = 1_700_000_000_000
    assert.equal(_pastOnly(now + 86_400_000, now), now, 'clamped, not rejected — the rest of the line is fine')
    assert.equal(_pastOnly(BOUGHT_2020, now), BOUGHT_2020)
    assert.equal(_pastOnly(null, now), null)
})
