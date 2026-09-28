/**
 * THE SUMMARY — what this trade pays, and what it costs, before the user presses Generate.
 *
 * The last thing said before a real order is authored, and the one place a trader decides with
 * their gut rather than their chart: 2.4R is an abstraction, "$740 if it works, $310 if it doesn't,
 * which is 1.2% of your account" is a decision (docs/design/mentor-flow-intent.md #12).
 *
 * THE ARITHMETIC IS THE SERVER'S. The model narrates these numbers; it never derives them. A model
 * that is roughly right about R:R is wrong about money on a live account, and the user has no way
 * to tell the difference between a computed figure and a fluent one.
 *
 * Pure. No clock, no I/O.
 */

import { computeRR, stopEdge, targetLevels, legPrice } from './setup.schema.js'
import { riskPerUnit, resolveSize } from './positionSize.util.js'

const num = (v) => (v === null || v === '' || v === undefined ? NaN : Number(v))
const round2 = (n) => Math.round(n * 100) / 100
const pctOf = (cash, balance) => (Number.isFinite(cash) && balance > 0 ? round2(cash / balance * 100) : null)

/**
 * The entry this summary is measured from, and whether it is a REAL level or a stand-in.
 *
 * A non-price entry ("RSI below 30, in at market") has no authored fill, so the figures are an
 * estimate off the live price and are labelled as one — Roy's call at step 6: show the estimate,
 * mark it, and recompute for real at fire. Pretending an estimate is a plan is the failure; having
 * no number at all is just unhelpful.
 */
export function summaryEntry(setup, livePrice = null) {
    const authored = legPrice(setup?.entry_legs?.[0])
    if (Number.isFinite(authored)) return { entry: authored, estimated: false }
    const live = num(livePrice)
    return Number.isFinite(live) && live > 0 ? { entry: live, estimated: true } : { entry: null, estimated: true }
}

/**
 * What the target ladder pays at the size the user actually chose.
 *
 * The ladder is used leg by leg ONLY when its legs add up to that size. When they do not — the
 * plan was drawn at 100 and the user sized 125, or half the legs carry no quantity — the whole
 * position is priced to the NEAREST target instead.
 *
 * That is deliberately the pessimistic reading, and it is the same rule `rr` already follows: a
 * mismatched ladder means some of the position has no authored exit, and the two ways to guess
 * (scale the legs up, or leave the remainder unsold) both invent a plan the user never agreed to.
 * Pricing it all to the first target understates the good case and can never flatter the trade,
 * which is the direction to be wrong in.
 */
export function expectedGain(setup, quantity, entry, multiplier = 1) {
    const isLong = setup?.direction === 'long'
    const legs   = targetLevels(setup)
    const qty    = num(quantity)
    const e      = num(entry)
    const m      = num(multiplier) || 1
    if (!legs.length || !(qty > 0) || !Number.isFinite(e)) return null

    const sized   = legs.filter(l => num(l.quantity) > 0)
    const covered = sized.reduce((a, l) => a + num(l.quantity), 0)
    const plan    = sized.length === legs.length && Math.abs(covered - qty) < 1e-9
        ? sized
        : [{ target: legs[0].target, quantity: qty }]

    let gain = 0
    for (const leg of plan) {
        const t = num(leg.target)
        const q = num(leg.quantity)
        if (!Number.isFinite(t) || !(q > 0)) continue
        gain += (isLong ? t - e : e - t) * q * m
    }
    return gain > 0 ? round2(gain) : null
}

/**
 * The summary line for ONE trade: R:R, and the two outcomes in cash and as a share of the account.
 *
 * `quantity` is the user's, from the sizing stage. Without it there is no money in this at all —
 * which is exactly why sizing comes first and cannot be waived.
 */
export function summarizeTrade(setup, { quantity = null, balance = null, livePrice = null, multiplier = 1 } = {}) {
    const { entry, estimated } = summaryEntry(setup, livePrice)
    const stop = stopEdge(setup)
    const qty  = num(quantity ?? setup?.scenarios?.[0]?.quantity)
    const bal  = num(balance)
    const per  = riskPerUnit(entry, stop, multiplier)

    const loss = per != null && qty > 0 ? round2(qty * per) : null
    const gain = expectedGain(setup, qty, entry, multiplier)

    return {
        rr: computeRR(setup, Number.isFinite(entry) ? entry : null),
        entry: Number.isFinite(entry) ? entry : null,
        // The whole point of the flag: everything below is provisional when it is true, and the
        // real figures are computed at fire off the actual fill.
        estimated,
        quantity: qty > 0 ? qty : null,
        gainCash: gain,
        gainPct:  pctOf(gain, bal),
        lossCash: loss,
        lossPct:  pctOf(loss, bal),
    }
}

/**
 * Apply the user's sizing answer to a plan — the server's half of the sizing stage.
 *
 * Resolved PER SCENARIO, and that is not an optimisation: two ways into the same trade have
 * different stops, so the same "risk $500" is a different number of shares in each. Sizing them
 * together would put the user on more risk in whichever premise has the wider stop, which is the
 * one they were least sure about.
 *
 * Returns quantities and problems; writes nothing. The caller applies them.
 */
export function applySizing(setup, sizing, { balance = null, multiplier = 1 } = {}) {
    const unit  = sizing?.unit
    const value = sizing?.value
    const list  = setup?.scenarios ?? []
    if (!unit || !list.length) return { quantities: [], problems: [] }

    const quantities = []
    const problems   = []
    for (const sc of list) {
        const view = { direction: setup.direction, ...sc }
        const out  = resolveSize({
            unit, value, multiplier, balance,
            entry: legPrice(sc.entry_legs?.[0]),
            stop:  stopEdge(view),
        })
        if (out.problem) problems.push(`${sc.id ?? 'the premise'}: ${out.problem}`)
        else quantities.push({ id: sc.id ?? null, ...out })
    }
    return { quantities, problems }
}

/**
 * The batch line: what is at risk across every name in one build (#15, step 5.3).
 *
 * Per-trade sizing stays the user's — this is a REMARK, never a veto. But "1% each" across six
 * correlated names is 6% on one idea, and nobody sees that while sizing them one at a time.
 */
export function summarizeBatch(summaries, balance = null) {
    const rows = (summaries ?? []).filter(s => Number.isFinite(s?.lossCash))
    if (!rows.length) return null
    const risk = round2(rows.reduce((a, s) => a + s.lossCash, 0))
    const gain = rows.some(s => Number.isFinite(s.gainCash))
        ? round2(rows.reduce((a, s) => a + (s.gainCash ?? 0), 0))
        : null
    return {
        trades:    rows.length,
        riskCash:  risk,
        riskPct:   pctOf(risk, num(balance)),
        gainCash:  gain,
        gainPct:   pctOf(gain, num(balance)),
        estimated: rows.some(s => s.estimated),
    }
}
