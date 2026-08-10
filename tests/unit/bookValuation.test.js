import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    reconcileAccount, costBasis, marketValue, actualWeights, holdingProblems,
} from '../../services/bookValuation.util.js'

// Turning "the bank says it's worth 180,000" into the number the virtual-account store needs.
// The whole file guards one mistake: seeding the account with MARKET VALUE instead of cost basis +
// cash, which double-counts every gain the adopted book already carries.
// See docs/design/adopted-book.md §3.

const AAPL = { symbol: 'AAPL', quantity: 100, avgCost: 150, mark: 200 }   // cost 15,000 → worth 20,000
const MSFT = { symbol: 'MSFT', quantity: 50,  avgCost: 300, mark: 400 }   // cost 15,000 → worth 20,000

test('cost basis is what the book cost, not what it is worth', () => {
    assert.equal(costBasis([AAPL, MSFT]), 30_000)
    assert.equal(marketValue([AAPL, MSFT]).value, 40_000)
})

test('starting balance is cost basis + free cash — never market value', () => {
    // Stated 50,000: 40,000 of holdings, so 10,000 is cash.
    const r = reconcileAccount({ holdings: [AAPL, MSFT], statedTotal: 50_000 })
    assert.deepEqual(r.problems, [])
    assert.equal(r.freeCash, 10_000)
    // 30,000 + 10,000. Equity (= cash + unrealized 10,000) then reports the real 50,000.
    assert.equal(r.startingBalance, 40_000)
})

test('an account value below the holdings refuses rather than inventing negative cash', () => {
    const r = reconcileAccount({ holdings: [AAPL, MSFT], statedTotal: 25_000 })
    assert.ok(r.problems.includes('account_value_below_holdings'))
    assert.equal(r.freeCash, null)
    assert.equal(r.startingBalance, null, 'no balance is produced from numbers we do not trust')
})

test('rounding noise on a hand-typed total is tolerated, not refused', () => {
    // A human reads 39,999.40 off a bank screen against our 40,000 marks.
    const r = reconcileAccount({ holdings: [AAPL, MSFT], statedTotal: 39_999.4 })
    assert.deepEqual(r.problems, [])
    assert.equal(r.freeCash, 0)
    assert.equal(r.startingBalance, 30_000)
})

test('an unpriceable holding stops the cash DERIVATION — the branch, not a dead end', () => {
    const fund = { symbol: 'BANKFUND', quantity: 10, avgCost: 1_000, mark: null }
    const derived = reconcileAccount({ holdings: [AAPL, fund], statedTotal: 40_000 })
    assert.ok(derived.problems.includes('cash_not_derivable_unpriced'))
    assert.deepEqual(derived.unpriced, ['BANKFUND'])
    assert.equal(derived.startingBalance, null)

    // Stating cash directly needs no market value, so the same book commits fine.
    const stated = reconcileAccount({ holdings: [AAPL, fund], freeCash: 5_000 })
    assert.deepEqual(stated.problems, [])
    assert.equal(stated.startingBalance, 15_000 + 10_000 + 5_000, 'the unmarked fund still cost money')
})

test('an unmarked line never falls back to cost inside market value', () => {
    const fund = { symbol: 'BANKFUND', quantity: 10, avgCost: 1_000, mark: null }
    const { value, unpriced } = marketValue([AAPL, fund])
    assert.equal(value, 20_000, 'priced rows only')
    assert.deepEqual(unpriced, ['BANKFUND'])
})

test('weights are a share of what we can price, and name what we cannot', () => {
    const fund = { symbol: 'BANKFUND', quantity: 10, avgCost: 1_000, mark: null }
    const { weights, unpriced } = actualWeights([AAPL, MSFT, fund])
    assert.deepEqual(weights.map(w => w.symbol), ['AAPL', 'MSFT'])
    assert.equal(weights[0].weight, 0.5)
    assert.deepEqual(unpriced, ['BANKFUND'], 'excluded and NAMED — never silently dropped')
})

test('no account value stated at all is a problem, not a zero', () => {
    const r = reconcileAccount({ holdings: [AAPL] })
    assert.ok(r.problems.includes('no_account_value'))
    assert.equal(r.startingBalance, null)
})

test('negative stated cash refuses — we do not model a margin account', () => {
    const r = reconcileAccount({ holdings: [AAPL], freeCash: -500 })
    assert.ok(r.problems.includes('negative_cash'))
    assert.equal(r.startingBalance, null)
})

test('per-row problems name the row, so the grid can point at it', () => {
    const problems = holdingProblems([
        { symbol: 'AAPL', quantity: 0,  avgCost: 150 },
        { symbol: 'MSFT', quantity: 10, avgCost: 0 },
        { symbol: '',     quantity: 10, avgCost: 10 },
        { symbol: 'AAPL', quantity: 10, avgCost: 10 },
    ])
    assert.ok(problems.includes('bad_quantity:AAPL'))
    assert.ok(problems.includes('bad_avg_cost:MSFT'))
    assert.ok(problems.includes('missing_symbol'))
    assert.ok(problems.includes('duplicate_symbol:AAPL'), 'the same name twice is a paste error')
})

test('a bad row cannot produce a starting balance even when the total reconciles', () => {
    const r = reconcileAccount({ holdings: [{ symbol: 'AAPL', quantity: -5, avgCost: 150, mark: 200 }], statedTotal: 1_000 })
    assert.ok(r.problems.some(p => p.startsWith('bad_quantity')))
    assert.equal(r.startingBalance, null)
})

// ── FX: the stated figures convert, the cost basis deliberately does not ────────

test('a stated total in another currency converts at spot', () => {
    // ₪180,000 at 0.27 = $48,600, of which $40,000 is holdings → $8,600 cash.
    const r = reconcileAccount({ holdings: [AAPL, MSFT], statedTotal: 180_000, fxToUsd: 0.27 })
    assert.deepEqual(r.problems, [])
    assert.equal(r.freeCash, 8_600)
    assert.equal(r.startingBalance, 38_600)
    // The cost basis is NOT touched by the rate: marks already come back in the feed's currency, and
    // spot-converting a basis bought years ago would fold FX drift into what reads as market P&L.
    assert.equal(r.costBasis, 30_000)
})

test('stated cash converts too', () => {
    const r = reconcileAccount({ holdings: [AAPL], freeCash: 10_000, fxToUsd: 0.27 })
    assert.equal(r.freeCash, 2_700)
    assert.equal(r.startingBalance, 15_000 + 2_700)
})

test('a missing rate refuses — never a silent 1', () => {
    // Reading a shekel book as dollars would open an account nearly four times too large.
    const r = reconcileAccount({ holdings: [AAPL], statedTotal: 180_000, fxToUsd: null })
    assert.deepEqual(r.problems, ['no_fx_rate'])
    assert.equal(r.startingBalance, null)
    assert.equal(r.freeCash, null)
    assert.deepEqual(reconcileAccount({ holdings: [AAPL], statedTotal: 1, fxToUsd: 0 }).problems, ['no_fx_rate'])
})

test('a rate cannot fabricate a total that was never stated', () => {
    // null * rate is 0 in JS, which would read a missing total as an empty account.
    const r = reconcileAccount({ holdings: [AAPL], fxToUsd: 0.27 })
    assert.ok(r.problems.includes('no_account_value'))
    assert.equal(r.startingBalance, null)
})

test('an empty book values at zero without throwing', () => {
    const r = reconcileAccount({ holdings: [], statedTotal: 1_000 })
    assert.equal(r.costBasis, 0)
    assert.equal(r.marketValue, 0)
    assert.equal(r.freeCash, 1_000)
    // Refusing an empty book is the CALLER's judgment (adoptBook does), not the arithmetic's.
    assert.equal(r.startingBalance, 1_000)
})
