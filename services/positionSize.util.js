/**
 * POSITION SIZE — the five ways a trader says how big, resolved to one number.
 *
 * A trader does not think in share counts. One says "risk 1%", another "risk $500", another "put
 * $10k in", another "300 shares", and they are all describing the same position from a different
 * side. Mentor can see the account and the stop, so all five resolve — and asking a user to convert
 * their own habit into share counts is asking them to do arithmetic to talk to a desk
 * (docs/design/mentor-flow-intent.md #11).
 *
 * WHY THIS IS CODE AND NOT PROMPT: it is money arithmetic on a real account. A model that is
 * roughly right about a share count is wrong about how much the user is risking, and neither the
 * card nor the broker would say so. The model asks which unit and reads the answer out; the number
 * is computed here (step 6 of the design).
 *
 * Pure. No clock, no I/O.
 */

/** The five units, in the order a trader is most likely to think in them. */
export const SIZE_UNITS = ['risk_cash', 'risk_pct', 'size_cash', 'size_pct', 'shares']

const num = (v) => (v === null || v === '' || v === undefined ? NaN : Number(v))
const round2 = (n) => Math.round(n * 100) / 100

/**
 * What ONE unit of this instrument risks between entry and stop. The multiplier is the contract or
 * point value: for shares it is 1, for futures and FX it is not, and a risk budget divided by a raw
 * price difference on a contract is off by that factor — which is the whole position.
 */
export function riskPerUnit(entry, stop, multiplier = 1) {
    const e = num(entry), s = num(stop), m = num(multiplier) || 1
    if (!Number.isFinite(e) || !Number.isFinite(s)) return null
    const d = Math.abs(e - s) * m
    return d > 0 ? d : null
}

/**
 * Resolve any of the five units to a quantity, and say what that quantity MEANS in the other four.
 *
 * Returns `{ quantity, riskCash, riskPct, notional, notionalPct, unit, problem }`. A `problem` is
 * returned rather than thrown, and the quantity is null beside it: the caller is a conversation,
 * and "I cannot size that yet, here is why" is a sentence Mentor can say.
 */
export function resolveSize({ unit, value, entry, stop, balance = null, multiplier = 1 }) {
    const none = (problem) => ({ quantity: null, riskCash: null, riskPct: null, notional: null, notionalPct: null, unit, problem })

    if (!SIZE_UNITS.includes(unit)) return none(`unknown sizing unit: ${unit}`)
    const v = num(value)
    if (!Number.isFinite(v) || v <= 0) return none('the size has to be a positive number')

    const e   = num(entry)
    const m   = num(multiplier) || 1
    const bal = num(balance)
    const per = riskPerUnit(entry, stop, m)

    // Anything expressed as a PERCENT needs the account, and a percent of an unknown balance is a
    // number nobody should act on. Say so instead of guessing an equity figure — and say WHICH of
    // the two things is wrong, because they have different fixes.
    if ((unit === 'risk_pct' || unit === 'size_pct') && bal === 0) {
        return none('the marked account has a zero balance — nothing can be sized against it. Mark an account with money in it (the bank icon), or tell me a cash amount and I will size that')
    }
    if ((unit === 'risk_pct' || unit === 'size_pct') && !(bal > 0)) {
        return none('that is a percentage of an account balance I cannot see — give me a cash amount, or mark an account that reports its balance')
    }
    // Anything expressed as RISK needs a stop that is a different price from the entry.
    if ((unit === 'risk_cash' || unit === 'risk_pct') && per == null) {
        return none('sizing by risk needs an entry and a stop that are different prices')
    }
    if ((unit === 'size_cash' || unit === 'size_pct') && !(e > 0)) {
        return none('sizing by position value needs an entry price')
    }

    let quantity
    switch (unit) {
        case 'risk_cash': quantity = Math.floor(v / per); break
        case 'risk_pct':  quantity = Math.floor((bal * v / 100) / per); break
        case 'size_cash': quantity = Math.floor(v / (e * m)); break
        case 'size_pct':  quantity = Math.floor((bal * v / 100) / (e * m)); break
        case 'shares':    quantity = Math.floor(v); break
    }

    // A budget smaller than one unit is not a rounding problem, it is a trade the user cannot take
    // at this stop — and floor() would otherwise hand back a silent zero.
    if (!(quantity > 0)) {
        return none(per != null && unit.startsWith('risk')
            ? `that budget is smaller than the risk on a single unit (${round2(per)} per unit at this stop)`
            : 'that works out to less than one unit')
    }

    const riskCash = per != null ? round2(quantity * per) : null
    const notional = e > 0 ? round2(quantity * e * m) : null
    return {
        quantity,
        riskCash,
        riskPct:     riskCash != null && bal > 0 ? round2(riskCash / bal * 100) : null,
        notional,
        notionalPct: notional != null && bal > 0 ? round2(notional / bal * 100) : null,
        unit,
        problem: null,
    }
}
