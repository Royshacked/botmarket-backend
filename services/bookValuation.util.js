// Pure helpers for valuing a book the app did NOT build — no I/O, no DB.
//
// Intake for an adopted book (docs/design/adopted-book.md) asks the user for the one number they
// can actually answer — "what does the bank say the account is worth" — and has to turn that into
// the number the virtual-account store needs, which is a different number: `startingBalance`.
//
// The arithmetic is load-bearing because of how the store defines equity:
//   equity = cashBalance + unrealized,  and cash is NEVER debited when a position opens.
// So the balance that makes an adopted account report its real worth is the COST BASIS plus the
// free cash — not the market value. Seeding it with market value double-counts every unrealized
// gain the book is already carrying, which is the single easiest way to get this wrong.
//
// Three callers, hence one module: adoption intake, the drift re-confirm ritual (which re-runs
// exactly this arithmetic when the user re-states their book), and a future broker-read adoption
// where the holdings arrive from an API instead of a paste.

import { toNum } from './format.util.js'

const _round2 = v => Number(Number(v).toFixed(2))

// A human types the account total off a bank screen, so it disagrees with our marks by rounding
// and by seconds of drift. Under a unit of currency that is noise; past it, the numbers genuinely
// do not reconcile and someone has mistyped something.
const CASH_TOLERANCE = 1

/** Multiply, preserving null — `null * 3` is 0, which would read a missing total as an empty account. */
const _mul = (v, by) => (v == null ? null : _round2(v * by))

/**
 * One holding as intake states it. `mark` is the live price where we could resolve one and **null**
 * where the line is unpriceable (a bank mutual fund, a local line, a bond) — a first-class case,
 * not a failure.
 * @typedef {{ symbol:string, quantity:number, avgCost:number, mark?:number|null }} Holding
 */

/** Is this row usable arithmetic at all? Pure. */
function _usable(h) {
    return !!String(h?.symbol ?? '').trim() && toNum(h?.quantity) > 0 && toNum(h?.avgCost) > 0
}

/**
 * Per-row validation, as short codes the caller maps to copy — the same shape the refusal
 * vocabulary uses elsewhere (`bad_price`, `bad_quantity`), so intake can refuse a specific line
 * rather than the whole paste.
 * @returns {string[]} e.g. ['bad_quantity:AAPL']
 */
export function holdingProblems(holdings = []) {
    const problems = []
    const seen = new Set()
    for (const h of (Array.isArray(holdings) ? holdings : [])) {
        const sym = String(h?.symbol ?? '').trim().toUpperCase()
        if (!sym)                     { problems.push('missing_symbol'); continue }
        if (seen.has(sym))              problems.push(`duplicate_symbol:${sym}`)
        seen.add(sym)
        if (!(toNum(h?.quantity) > 0))  problems.push(`bad_quantity:${sym}`)
        if (!(toNum(h?.avgCost)  > 0))  problems.push(`bad_avg_cost:${sym}`)
    }
    return problems
}

/** What the book cost: Σ quantity × avg cost. Unpriceable lines count — a fund we can't mark still cost money. */
export function costBasis(holdings = []) {
    let total = 0
    for (const h of (Array.isArray(holdings) ? holdings : [])) {
        if (!_usable(h)) continue
        total += toNum(h.quantity) * toNum(h.avgCost)
    }
    return _round2(total)
}

/**
 * What the book is worth right now, and which lines we could not price.
 *
 * `value` covers PRICED rows only. It deliberately does not fall back to cost for an unmarked line:
 * a market value that silently contains cost for one holding is a number nobody can interpret, and
 * every consumer (free cash, weights, P&L) would inherit the fiction.
 * @returns {{ value:number, unpriced:string[] }}
 */
export function marketValue(holdings = []) {
    let value = 0
    const unpriced = []
    for (const h of (Array.isArray(holdings) ? holdings : [])) {
        if (!_usable(h)) continue
        const mark = toNum(h.mark)
        if (mark == null || !(mark > 0)) { unpriced.push(String(h.symbol).trim().toUpperCase()); continue }
        value += toNum(h.quantity) * mark
    }
    return { value: _round2(value), unpriced }
}

/**
 * Actual weights, by market value, over the lines we can price.
 *
 * Unpriceable lines are EXCLUDED and named, rather than weighted at cost. A weight is a share of
 * market value; substituting cost for one line leaves every other weight subtly wrong with no way
 * to tell from the output. Excluded-and-named is the honest shape: the caller (Atlas) says "these
 * are the weights of the nine I can price, and here are the three I can't".
 * @returns {{ weights: Array<{symbol:string, weight:number, value:number}>, unpriced:string[] }}
 */
export function actualWeights(holdings = []) {
    const { value: total, unpriced } = marketValue(holdings)
    if (!(total > 0)) return { weights: [], unpriced }

    const weights = []
    for (const h of (Array.isArray(holdings) ? holdings : [])) {
        if (!_usable(h)) continue
        const mark = toNum(h.mark)
        if (mark == null || !(mark > 0)) continue
        const value = toNum(h.quantity) * mark
        weights.push({ symbol: String(h.symbol).trim().toUpperCase(), weight: value / total, value: _round2(value) })
    }
    return { weights, unpriced }
}

/**
 * Turn what the user told us into what the account store needs.
 *
 * TWO INPUT SHAPES, one function, because the unpriceable case is a branch and not a dead end:
 *   • `statedTotal` — "the bank says it's worth 180,000". Free cash is DERIVED
 *     (statedTotal − market value). Only possible when every line can be priced: an unmarked
 *     holding sits inside the stated total but outside our market value, so the subtraction would
 *     quietly hand its whole value to "cash".
 *   • `freeCash` — the user states cash directly. Nothing is derived, so unpriceable lines are
 *     harmless. This is the branch intake MUST take the moment `unpriced` is non-empty.
 *
 * `startingBalance` is returned ONLY on a clean reconciliation. A caller that ignores `problems`
 * therefore cannot open an account on a number we don't trust — the failure mode is a refusal, not
 * a plausible-looking balance.
 *
 * FX. `fxToUsd` is how many USD one unit of the stated currency buys, and it is applied ONLY to the
 * stated figures — the account total and the cash. Marks and therefore cost basis are already in the
 * feed's currency, and spot-converting a cost basis would fold years of currency drift into what then
 * reads as market P&L (see fxRate.service). A rate of 1 (or USD) is the no-op. The rate is PASSED IN,
 * because this module does no IO.
 *
 * @param {{ holdings:Holding[], statedTotal?:number|null, freeCash?:number|null,
 *           fxToUsd?:number|null }} args
 * @returns {{ costBasis:number, marketValue:number, unpriced:string[], freeCash:number|null,
 *             startingBalance:number|null, problems:string[] }}
 */
export function reconcileAccount({ holdings = [], statedTotal = null, freeCash = null, fxToUsd = 1 } = {}) {
    const problems = holdingProblems(holdings)
    const basis    = costBasis(holdings)
    const { value: market, unpriced } = marketValue(holdings)

    // A missing or nonsensical rate is a refusal, never a silent 1 — that would read a book stated in
    // shekels as a book of dollars and open an account four times too large.
    const fx = toNum(fxToUsd)
    if (fx == null || !(fx > 0)) {
        problems.push('no_fx_rate')
        return { costBasis: basis, marketValue: market, unpriced, freeCash: null, startingBalance: null, problems }
    }

    const statedCash = fx === 1 ? toNum(freeCash)   : _mul(toNum(freeCash),   fx)
    const stated     = fx === 1 ? toNum(statedTotal) : _mul(toNum(statedTotal), fx)

    let cash = null
    if (statedCash != null) {
        // Stated directly. Negative cash is a real thing at a bank (margin/overdraft), but it is not
        // something we model, so it is a refusal rather than a silent negative balance.
        if (statedCash < 0) problems.push('negative_cash')
        else cash = _round2(statedCash)
    } else if (stated == null) {
        problems.push('no_account_value')
    } else if (unpriced.length) {
        // The derivation is unavailable, not the intake: ask for cash instead (see above).
        problems.push('cash_not_derivable_unpriced')
    } else {
        const derived = stated - market
        if (derived < -CASH_TOLERANCE) problems.push('account_value_below_holdings')
        else cash = _round2(Math.max(0, derived))
    }

    return {
        costBasis:       basis,
        marketValue:     market,
        unpriced,
        freeCash:        cash,
        // Cost basis + cash, so that equity (= cash + unrealized) reports the book's real worth and
        // `deployable()` reports exactly the cash. Withheld whenever anything above is unresolved.
        startingBalance: (problems.length === 0 && cash != null) ? _round2(basis + cash) : null,
        problems,
    }
}
