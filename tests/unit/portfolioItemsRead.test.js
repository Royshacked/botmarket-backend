import { test } from 'node:test'
import assert from 'node:assert/strict'

import { listPortfolioItems } from '../../services/portfolioState.service.js'

// A portfolio is not a document — it exists as the items carrying its id — so listPortfolioItems IS
// the book's get-by-id, and it is the one place ownership is enforced on those rows. Both callers
// come through it: the state computation (a narrow projection, recomputed per turn) and a client
// opening the book for review (whole documents).

function fakeDb(rows = [{ id: 'a', asset: 'NVDA' }]) {
    const seen = {}
    return {
        seen,
        collection: () => ({
            find(filter) {
                seen.filter = filter
                return {
                    project(projection) {
                        seen.projection = projection
                        return { toArray: async () => rows }
                    },
                }
            },
        }),
    }
}

test('scopes the query to BOTH the book and the owner', async () => {
    const db = fakeDb()
    await listPortfolioItems('portfolio_1', 'user_1', { db })
    assert.deepEqual(db.seen.filter, { portfolioId: 'portfolio_1', userId: 'user_1' })
})

// The whole document by default: a client opening a book for review needs conditions, quantities and
// accounts, not the slice the state computation happens to want. Getting this wrong is invisible —
// the review reads fine, and only the ACCEPT fails, on fields that were never sent.
test('returns whole documents by default, minus the Mongo _id', async () => {
    const db = fakeDb()
    await listPortfolioItems('portfolio_1', 'user_1', { db })
    assert.deepEqual(db.seen.projection, { _id: 0 })
})

test('a caller may narrow the cut without forking the query', async () => {
    const db = fakeDb()
    await listPortfolioItems('portfolio_1', 'user_1', { projection: { id: 1, asset: 1 }, db })
    assert.deepEqual(db.seen.projection, { id: 1, asset: 1 })
})

// An empty book is a real answer (an emptied book, an adoption not yet committed), not a failure.
// The caller decides what it means — what must never happen is it being indistinguishable from
// "we didn't look", which is exactly how a review came to be authored against no holdings at all.
test('an empty book reads as an empty list, not as an error', async () => {
    const db = fakeDb([])
    assert.deepEqual(await listPortfolioItems('portfolio_1', 'user_1', { db }), [])
})
