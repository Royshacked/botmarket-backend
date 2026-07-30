/**
 * The OBJECTIVE — what the user said they want, captured once at intake by Axl and read by
 * whichever desk they land at.
 *
 * This exists because the route hop only ever carried a desk and a ticker: "5% in the next week,
 * risking no more than 2%" died at the handoff and the desk re-asked for all of it. The objective
 * is the artifact that survives the hop (and a page refresh), so the user states their goal ONCE.
 *
 * Two rules the shape enforces, both of them load-bearing:
 *
 *   1. RISK IS USER-STATED, NEVER INFERRED. A 5% target implies nothing about drawdown tolerance —
 *      symmetric risk/reward is a house convention, not a derivation. `risk` stays null when the
 *      user hasn't said, and the absence travels to the desk as an explicit "ask before sizing"
 *      rather than being quietly filled in with the target's number.
 *
 *   2. `horizon.until` IS STAMPED IN CODE. The model is given `days` and the deadline is computed
 *      here — the same lesson as the scan→Kairos time gate, where a model asked to emit a date it
 *      only knows from a one-shot seed loses it.
 *
 * Storing the objective is not authoring a trade: it records what the user said about their own
 * goal, which keeps Axl inside its read-only boundary. Every judgment about whether the goal is
 * achievable, and every level and size that follows, still belongs to a desk.
 */

import { randomUUID } from 'crypto'
import { getDb } from '../../providers/mongodb.provider.js'

export const COLLECTION = 'objectives'

// 'open' is the only status getOpenObjective will hand to a desk. The other three are terminal and
// exist so the trail stays readable: superseded (the user restated the goal), routed (they reached
// a desk), expired (the deadline passed untouched).
export const STATUSES = ['open', 'routed', 'expired', 'superseded']
export const SCOPES = ['single', 'basket']

const MAX_HORIZON_DAYS = 365

export function todayISO(now = new Date()) {
    return now.toISOString().slice(0, 10)
}

/** `days` from today, as a plain YYYY-MM-DD — lexicographically comparable, which is all expiry needs. */
export function addDaysISO(days, now = new Date()) {
    const d = new Date(now.getTime())
    d.setUTCDate(d.getUTCDate() + days)
    return todayISO(d)
}

// A finite positive number or null. Rejects NaN, Infinity, '', booleans and numeric strings — the
// model emits JSON, so a string here means it guessed at the shape and the value is not trustworthy.
function posNum(v) {
    return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : null
}

/**
 * Normalize + validate the fields Axl captured into a storable objective.
 * Pure and throwing: the caller decides whether a bad objective is a tool error or a 400.
 *
 * @throws {Error} when the goal is not actually stated (no target, or no horizon)
 */
export function buildObjectiveDoc(userId, fields = {}, now = new Date()) {
    if (!userId) throw new Error('objective: userId is required')

    const { target = {}, horizon = {}, risk = {}, scope, symbol } = fields ?? {}

    const pct = posNum(target?.pct)
    const amount = posNum(target?.amount)
    if (pct == null && amount == null) {
        throw new Error('objective: target needs a pct or an amount')
    }

    const days = Number.isInteger(horizon?.days) ? horizon.days : null
    if (days == null || days < 1 || days > MAX_HORIZON_DAYS) {
        throw new Error(`objective: horizon.days must be a whole number of days between 1 and ${MAX_HORIZON_DAYS}`)
    }

    const ts = now.getTime()
    return {
        id: randomUUID(),
        userId,
        // pct and amount are kept side by side rather than converted: "5%" and "$2,000" are
        // different statements, and which one the user made is worth preserving for the desk.
        target: { pct, amount, currency: typeof target?.currency === 'string' ? target.currency.toUpperCase() : null },
        horizon: { days, until: addDaysISO(days, now) },
        // Null is a real answer here — see rule 1 above. Never derived from target.
        risk: { maxDrawdownPct: posNum(risk?.maxDrawdownPct), amount: posNum(risk?.amount) },
        scope: SCOPES.includes(scope) ? scope : null,
        symbol: sanitizeObjectiveSymbol(symbol),
        status: 'open',
        routedTo: null,
        routedAt: null,
        createdAt: ts,
        updatedAt: ts,
    }
}

/**
 * A plausible ticker, or null. Same shape as the route tag's symbol gate (see agentUtils'
 * sanitizeSymbol) — a hallucinated company name must not become the name a desk works on.
 */
export function sanitizeObjectiveSymbol(raw) {
    if (typeof raw !== 'string') return null
    const symbol = raw.trim().toUpperCase()
    return /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(symbol) ? symbol : null
}

/**
 * The client-facing view of an objective: what the user stated, and nothing about how we store it.
 * Used to show the captured goal back to them — an id alone renders nothing, and a chip reading
 * "5% by 2026-08-06" is the only way they can tell we understood, or correct us if we didn't.
 */
export function toObjectiveSummary(doc) {
    if (!doc) return null
    const { id, target, horizon, risk, scope, symbol } = doc
    return { id, target, horizon, risk, scope, symbol }
}

export async function ensureObjectiveIndexes() {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).createIndex({ id: 1 }, { unique: true })
        // The only hot read: "this user's open objective", newest first.
        await db.collection(COLLECTION).createIndex({ userId: 1, status: 1, createdAt: -1 })
    } catch (err) {
        console.warn('[objectives] ensureObjectiveIndexes failed:', err.message)
    }
}
