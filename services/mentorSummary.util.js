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

import { computeRR, stopEdge, targetLevels, legPrice, legReference } from './setup.schema.js'
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
    const leg      = setup?.entry_legs?.[0]
    const authored = legPrice(leg)
    if (Number.isFinite(authored)) return { entry: authored, estimated: false }
    // A trigger entry's own rough fill comes first: Mentor had a quote when it authored the plan,
    // and that is a better stand-in than whatever the price happens to be on this turn.
    const about = legReference(leg)
    if (about != null) return { entry: about, estimated: true }
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
export function applySizing(setup, sizing, { balance = null, multiplier = null } = {}) {
    const unit  = sizing?.unit
    const value = sizing?.value
    const list  = setup?.scenarios ?? []
    if (!unit || !list.length) return { quantities: [], problems: [] }

    // WHOSE MULTIPLIER. Stated with the size if the instrument has one; otherwise 1 is only safe
    // where a unit IS the price — shares, ETFs and crypto. On a future or an FX contract, assuming
    // 1 silently sizes the position by the contract value: a $500 budget on ES becomes 125
    // contracts risking $25,000. So it is refused instead, by name, and asked for.
    const m = Number(sizing?.multiplier ?? multiplier)
    const contractual = setup?.asset_class === 'futures' || setup?.asset_class === 'forex'
    if (contractual && !(Number.isFinite(m) && m > 0)) {
        return { quantities: [], problems: [`this is a ${setup.asset_class} contract — tell me its point/contract value and I will size it; assuming 1 would size the position by the contract instead of the risk`] }
    }
    const mult = Number.isFinite(m) && m > 0 ? m : 1

    const quantities = []
    const problems   = []
    for (const sc of list) {
        const view = { direction: setup.direction, ...sc }
        const out  = resolveSize({
            unit, value, balance, multiplier: mult,
            // legReference, not legPrice: a trigger entry has no order price but does carry a
            // rough fill, and without it "risk 1%" would be refused on a perfectly good plan.
            entry: legReference(sc.entry_legs?.[0]),
            stop:  stopEdge(view),
        })
        if (out.problem) problems.push(`${sc.id ?? 'the premise'}: ${out.problem}`)
        else quantities.push({ id: sc.id ?? null, ...out })
    }
    return { quantities, problems }
}

/**
 * The share each entry leg takes of its premise, from the entries gate — or null when this is not
 * a scale-in and the legs are not meant to be split at all.
 *
 * Matched by POSITION, because that is the only correspondence the two shapes have: the gate's
 * options for a trade are authored in the order the legs are.
 */
function sharesFor(entries, scenario, legs) {
    const trade = (entries?.trades ?? []).find(t => t.id === (scenario?.trade_id ?? t.id))
    if (trade?.semantics !== 'scale_in') return null
    const shares = (trade.options ?? []).slice(0, legs.length).map(o => Number(o.share))
    if (shares.length !== legs.length || shares.some(n => !Number.isFinite(n) || n <= 0)) return null
    return Math.abs(shares.reduce((a, b) => a + b, 0) - 100) < 0.01 ? shares : null
}

/**
 * Size a whole plan: the user's answer resolved per scenario (applySizing), then laid onto every
 * entry leg. Returns a NEW plan with the quantities on it, plus the problems — the input is not
 * touched.
 *
 * ONE implementation for both callers: the turn that re-derives the size after the model has
 * written (a stop that moved is a different share count for the same risk), and the sizing TOOL the
 * model calls mid-turn so it can read the figures out instead of promising them for next turn. Two
 * copies of this would be two answers to "how many shares", and the user would see both.
 *
 * EVERY LEG GETS A SIZE, or the setup can never be ready — `setupReadiness` requires one per leg.
 * One leg takes the whole position; a scale-in ladder splits by the shares the entries stage
 * authored; two legs with no shares are two rival premises filed in one scenario, and refused.
 */
export function sizePlan(plan, sizing, { balance = null, entries = null } = {}) {
    if (!plan) return { plan, quantities: [], problems: [] }
    const next = { ...plan, scenarios: (plan.scenarios ?? []).map(sc => ({ ...sc, entry_legs: (sc.entry_legs ?? []).map(l => ({ ...l })) })) }
    const { quantities, problems } = applySizing(next, sizing, { balance, multiplier: sizing?.multiplier })
    for (const q of quantities) {
        const sc = next.scenarios.find(x => x.id === q.id) ?? next.scenarios[0]
        if (!sc) continue
        sc.quantity = q.quantity
        const legs   = sc.entry_legs
        const shares = sharesFor(entries, sc, legs)
        if (legs.length === 1) legs[0].quantity = q.quantity
        else if (shares) legs.forEach((l, i) => { l.quantity = Math.floor(q.quantity * shares[i] / 100) })
        else if (legs.length > 1) {
            problems.push(`${sc.id}: ${legs.length} entry legs with no shares between them. Two ALTERNATIVE ways in belong in two scenarios, each sized off its own stop — legs of one scenario are a scale-in and must carry shares that add to 100.`)
        }
    }
    return { plan: next, quantities, problems }
}

/**
 * Does this position FIT the money the account can deploy — and if not, the largest that does.
 *
 * A remark, never a cap: on a margin account a position larger than free cash is ordinary, and only
 * the user knows which kind of account this is. But "the position would cost $36,667 and RAZ TEST
 * has $22,624" was arithmetic the model did by itself in Marce's PACB build (2026-10-01); it is
 * money on the user's account, so it is computed here, beside every other figure.
 *
 * Returns null when it fits or cannot be judged (no balance reported, no notional). ZERO IS A
 * BALANCE — an account with nothing free fits nothing, and saying "cannot judge" about it would hide
 * the one fact the user most needs. Pure.
 */
export function cashFit(sized, { entry, stop, balance, multiplier = 1 } = {}) {
    const bal = num(balance)
    if (!Number.isFinite(bal) || bal < 0 || !(num(sized?.notional) > bal)) return null
    const most = bal > 0
        ? resolveSize({ unit: 'size_cash', value: bal, entry, stop, balance: bal, multiplier })
        : { quantity: null, riskCash: null }
    return {
        available: round2(bal),
        notional:  sized.notional,
        maxQuantity: most.quantity,
        maxRiskCash: most.riskCash,
    }
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
