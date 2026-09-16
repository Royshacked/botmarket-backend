import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preflightEntry, _isStructuredOnly } from '../../monitoring/preflightEntry.js'

// The arm-time "is the entry level ALREADY held?" check — §8 kept it in monitoring/ because it runs
// the evaluator stack. Two things are unit-testable without a broker: the scope predicate that
// decides whether it acts at all, and its NEVER-THROWS contract (it runs inside a user's arm, so a
// provider hiccup must return not-satisfied, not fail the status change).

test('_isStructuredOnly: a pure structured tree yes; anything else no', () => {
    const leaf = c => ({ condition: c, type: 'structured' })
    assert.equal(_isStructuredOnly(leaf('close > 100')), true)
    assert.equal(_isStructuredOnly({ operator: 'AND', children: [leaf('a'), leaf('b')] }), true)
    // A single non-structured leaf anywhere disqualifies the tree.
    for (const type of ['touch', 'chart', 'news', 'time', 'volume']) {
        assert.equal(_isStructuredOnly({ operator: 'AND', children: [leaf('a'), { condition: 'x', type }] }), false, type)
    }
    assert.equal(_isStructuredOnly(null), false)
    assert.equal(_isStructuredOnly({ operator: 'AND', children: [] }), false)
})

test('a leaf with no explicit type defaults to structured, and counts as structured-only', () => {
    assert.equal(_isStructuredOnly({ condition: 'close > 100' }), true)
})

test('preflightEntry: a non-structured or absent tree is skipped — not satisfied, no fetch', async () => {
    assert.deepEqual(await preflightEntry({ id: 'i1', asset: 'AAPL' }), { alreadySatisfied: false })
    assert.deepEqual(
        await preflightEntry({ id: 'i1', asset: 'AAPL', entry_condition_tree: { condition: 'x', type: 'chart' } }),
        { alreadySatisfied: false },
    )
})

test('preflightEntry NEVER throws — a broken idea returns not-satisfied', async () => {
    // A structured tree with no asset/candles drives the real fetch path to failure; the contract is
    // that the arm still proceeds, so the answer is not-satisfied rather than a throw.
    const res = await preflightEntry({ id: 'i1', entry_condition_tree: { condition: 'close > 100', type: 'structured' } })
    assert.equal(res.alreadySatisfied, false)
})
