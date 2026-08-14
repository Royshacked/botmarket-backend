import { test } from 'node:test'
import assert from 'node:assert/strict'

import { listWatchedItems, WORKSPACE_SCOPED_KINDS } from '../../services/watchlist.service.js'
import { formatWatchedItems } from '../../services/tools/userData.tools.js'

// THE BUG THIS FILE EXISTS FOR
// "What am I watching?" answered with every workspace at once. A user standing in paper was handed
// their live calls and manual setups in the same list, undifferentiated — and once the venue block
// started telling every desk "CURRENT WORKSPACE: PAPER, my positions means the paper account", the
// two surfaces actively contradicted each other.
//
// THE LINE: a call, a setup and a book bind to an ACCOUNT, so each is real money or simulated money
// and never both. Scans and coverage are research — they bind to no account, there is nothing to
// scope them by, and they are shared across all three workspaces by decision.

const call    = (over = {}) => ({ id: 'c1', asset: 'NVDA', status: 'waiting', broker: 'paper', savedAt: 5, ...over })
const setup   = (over = {}) => ({ id: 's1', asset: 'TSLA', status: 'waiting', mode: 'live', savedAt: 4, ...over })
const book    = (over = {}) => ({ portfolioId: 'p1', name: 'Core', holdings: 3, savedAt: 3, statuses: {}, symbols: ['AAPL'], modes: ['paper'], ...over })
const scanDoc = (over = {}) => ({ id: 'sc1', createdAt: 2, candidates: [], ...over })
const covDoc  = (over = {}) => ({ id: 'cov1', symbol: 'MU', status: 'active', updated_at: '2026-08-01T00:00:00Z', ...over })

const deps = (over = {}) => ({
    calls:      async () => [call()],
    setups:     async () => [setup()],
    portfolios: async () => [book()],
    scans:      async () => [scanDoc()],
    coverage:   async () => [covDoc()],
    now: 1000,
    ...over,
})

test('only the three account-bound kinds are scoped', () => {
    assert.deepEqual(WORKSPACE_SCOPED_KINDS, ['call', 'setup', 'portfolio'])
})

test('in paper: the paper call and paper book stay, the live setup goes', async () => {
    const { counts } = await listWatchedItems('u1', { workspace: 'paper' }, deps())
    assert.equal(counts.call, 1)
    assert.equal(counts.setup, 0, 'a live setup is not part of the paper book')
    assert.equal(counts.portfolio, 1)
})

test('in live: the live setup stays, the paper call and paper book go', async () => {
    const { counts } = await listWatchedItems('u1', { workspace: 'live' }, deps())
    assert.equal(counts.call, 0)
    assert.equal(counts.setup, 1)
    assert.equal(counts.portfolio, 0)
})

test('scans and coverage survive EVERY workspace — they are shared by decision', async () => {
    for (const workspace of ['live', 'paper', 'manual']) {
        const { counts } = await listWatchedItems('u1', { workspace }, deps())
        assert.equal(counts.scan, 1, `scan in ${workspace}`)
        assert.equal(counts.coverage, 1, `coverage in ${workspace}`)
    }
})

test('no workspace asked for means no scoping — the old behaviour, untouched', async () => {
    // Every caller that has not been taught to pass one keeps getting the complete list.
    const { counts } = await listWatchedItems('u1', {}, deps())
    assert.equal(counts.call, 1)
    assert.equal(counts.setup, 1)
    assert.equal(counts.portfolio, 1)
})

test('a legacy call with no broker is scoped by its account id', async () => {
    // The fallback ideas already had and calls never did: before this, a document with no `broker`
    // was simply assumed paper by the list that showed it.
    const d = deps({ calls: async () => [call({ broker: undefined, accountId: 'manual-u1-abc' })] })
    assert.equal((await listWatchedItems('u1', { workspace: 'manual' }, d)).counts.call, 1)
    assert.equal((await listWatchedItems('u1', { workspace: 'paper' }, d)).counts.call, 0)
})

test('a MIXED book shows in every workspace it holds something in', async () => {
    // Appending to one portfolioId across a workspace switch makes a mixed book. Listing it in only
    // one workspace would make the other half unreachable — worse than showing it twice, because the
    // user has no surface on which to notice the missing legs.
    const d = deps({ portfolios: async () => [book({ modes: ['paper', 'live'] })] })
    assert.equal((await listWatchedItems('u1', { workspace: 'paper' }, d)).counts.portfolio, 1)
    assert.equal((await listWatchedItems('u1', { workspace: 'live' }, d)).counts.portfolio, 1)
    assert.equal((await listWatchedItems('u1', { workspace: 'manual' }, d)).counts.portfolio, 0)
})

// ─── what the model is told ───────────────────────────────────────────────────

test('the empty answer NAMES the workspace — "nothing" and "nothing in paper" differ', () => {
    // The dangerous sentence. A user with three live setups told flatly "you have nothing" has been
    // told something false about their own book.
    const out = formatWatchedItems({ items: [], counts: {}, workspace: 'paper' })
    assert.match(out, /Nothing in the PAPER workspace/)
    assert.match(out, /scans and coverage are shared across all workspaces/)
})

test('a populated answer says which book it is counting', () => {
    const out = formatWatchedItems({ items: [{ kind: 'call', symbol: 'NVDA' }], counts: { call: 1 }, workspace: 'manual' })
    assert.match(out, /In the app right now in the MANUAL workspace/)
})

test('with no workspace the wording is exactly what it always was', () => {
    assert.match(formatWatchedItems({ items: [], counts: {} }), /Nothing in the app yet/)
})

test('a failed read still outranks the workspace framing', () => {
    // "Could not check" must never be dressed up as "nothing here" — with or without a workspace.
    const out = formatWatchedItems({ items: [], counts: {}, unavailable: ['setup'], workspace: 'paper' })
    assert.match(out, /Could not read: setup/)
    assert.doesNotMatch(out, /Nothing/)
})
