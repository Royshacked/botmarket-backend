import { getDb } from '../providers/mongodb.provider.js'
import { COLLECTION as USERS } from '../api/user/user.model.js'
import { config } from './config.js'

const TOKEN_BUDGET_USD = config.tokenBudgetUsd
export const COLLECTION = 'token_usage'

// Pricing per 1M tokens in USD. cacheRead is 0.1x input, cacheWrite 1.25x input
// (the 5-minute TTL premium — we never set ttl:'1h', which would be 2x).
// Opus is $5/$25 as of the 4.7 generation; the old $15/$75 was Opus-3-era and
// overstated every Opus row by 3x while it was in here.
const PRICING = {
    'claude-haiku-4-5-20251001': { input: 1.00,  output: 5.00,  cacheRead: 0.10,  cacheWrite: 1.25  },
    // Sonnet 5 is $2/$10 introductory through 2026-08-31, then $3/$15. Priced at the STANDARD
    // rate on purpose: over-reporting spend is the safe direction for a budget ceiling, and it
    // needs no calendar reminder to stay correct.
    'claude-sonnet-5':          { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
    'claude-sonnet-4-6':        { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
    'claude-opus-5':            { input: 5.00,  output: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  },
    'claude-opus-4-8':          { input: 5.00,  output: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  },
}
const DEFAULT_PRICING = { input: 3.00, output: 15.00 }

export function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

// Exported for testing.
export function calcCost(model, usage) {
    const p = PRICING[model] ?? DEFAULT_PRICING
    return (
        (usage.input_tokens                  ?? 0) * p.input              / 1_000_000 +
        (usage.output_tokens                 ?? 0) * p.output             / 1_000_000 +
        (usage.cache_read_input_tokens       ?? 0) * (p.cacheRead  ?? 0) / 1_000_000 +
        (usage.cache_creation_input_tokens   ?? 0) * (p.cacheWrite ?? 0) / 1_000_000
    )
}

/**
 * A Mongo-safe field segment. Field PATHS are dot-delimited, so any dot in a key would silently
 * nest a subdocument instead of naming one counter — which is why `byModel` has always replaced
 * them. Same rule, one helper, now that a second dimension needs it.
 */
const _fieldKey = v => String(v ?? 'unknown').replace(/[.$]/g, '_')

/**
 * @param {string} [agent]  which desk spent this — the missing dimension. The month totals say
 *   caching pays (reads/writes ≈ 3.7 in Aug 2026) but not WHERE the uncached quarter is being
 *   spent, and that is the whole question: a desk whose volatile system tail sits ahead of the
 *   history breakpoint re-reads its own conversation at full price every turn, and it is
 *   indistinguishable from ordinary first-turn cost until it is counted per desk.
 *   `turns` rides along so a desk's cost can be read per call, not just in total — a big prompt
 *   used rarely and a small one used constantly look identical in a token count alone.
 */
export async function recordUsage(userId, model, usage, agent) {
    if (!userId || !usage) return
    const db      = await getDb()
    const key     = monthKey()
    const cost    = calcCost(model, usage)
    const mKey    = _fieldKey(model)
    const aKey    = _fieldKey(agent)

    const input      = usage.input_tokens                ?? 0
    const output     = usage.output_tokens               ?? 0
    const cacheRead  = usage.cache_read_input_tokens     ?? 0
    const cacheWrite = usage.cache_creation_input_tokens ?? 0

    await db.collection(COLLECTION).updateOne(
        { userId, month: key },
        {
            $inc: {
                inputTokens:       input,
                outputTokens:      output,
                cacheReadTokens:   cacheRead,
                cacheWriteTokens:  cacheWrite,
                totalCost:         cost,
                [`byModel.${mKey}.inputTokens`]:  input,
                [`byModel.${mKey}.outputTokens`]: output,
                [`byModel.${mKey}.cost`]:         cost,
                // Cache columns are carried per AGENT and not per model, deliberately: the model is
                // a price, the agent is the thing you can actually change.
                [`byAgent.${aKey}.inputTokens`]:      input,
                [`byAgent.${aKey}.outputTokens`]:     output,
                [`byAgent.${aKey}.cacheReadTokens`]:  cacheRead,
                [`byAgent.${aKey}.cacheWriteTokens`]: cacheWrite,
                [`byAgent.${aKey}.cost`]:             cost,
                [`byAgent.${aKey}.turns`]:            1,
            },
            $setOnInsert: { userId, month: key },
        },
        { upsert: true }
    )
}

/**
 * Count ONE user turn for a desk.
 *
 * Deliberately NOT folded into recordUsage. That one is driven by `onUsage`, which the provider
 * fires once per API call — and a tool loop makes many calls per turn — so `byAgent.*.turns` counts
 * round-trips to the model, not people talking. Read alone it cannot tell a verbose desk from a
 * tool-heavy one, and those want opposite fixes: prose instructions vs fewer tool rounds.
 *
 * `turns / userTurns` is the tool-rounds-per-turn ratio. It is the number the uncached-prompt share
 * turns on, because every tool result lands AFTER the history breakpoint by design (see
 * anthropic.provider `_stampHistoryCache`) and is re-sent, uncached, on each following round.
 */
export async function recordTurn(userId, agent) {
    if (!userId) return null
    const db   = await getDb()
    const key  = monthKey()
    const aKey = _fieldKey(agent)

    // Returns the post-increment doc so the caller gets this month's spend from the write it was
    // making anyway — the degrade check costs no extra round trip.
    const doc = await db.collection(COLLECTION).findOneAndUpdate(
        { userId, month: key },
        {
            $inc:         { [`byAgent.${aKey}.userTurns`]: 1 },
            $setOnInsert: { userId, month: key },
        },
        { upsert: true, returnDocument: 'after' }
    )
    return doc ?? null
}

/**
 * This user's ceiling, read from their account. One small indexed lookup per turn; a TTL cache
 * would be the obvious optimisation if it ever shows up in a profile, but a ceiling that changes
 * rarely and is read cheaply is not worth stale reads yet.
 */
export async function userCeiling(userId) {
    const db   = await getDb()
    const user = await db.collection(USERS).findOne(
        { id: userId }, { projection: { budgetUsd: 1, exemptFromBudget: 1, _id: 0 } })
    return ceilingFor(user)
}

/**
 * The spend ceiling for one user, USD, or `null` for no ceiling. Pure.
 *
 * `exemptFromBudget` is the escape hatch rather than `isAdmin`, which auth.middleware force-sets to
 * false on every request by design — reading it here would mean silently re-enabling a flag that was
 * deliberately switched off. Admin can map onto this whenever that decision is revisited.
 */
export function ceilingFor(user, configured = config.tokenDegradeUsd) {
    if (user?.exemptFromBudget) return null
    const own = Number(user?.budgetUsd)
    if (Number.isFinite(own)) return own > 0 ? own : null
    return configured
}

/**
 * Has this user spent past their ceiling this month? Pure, so the policy is testable without a
 * database and without a model.
 *
 * DEGRADE, NOT REFUSE: over the line the chat keeps working on the cheap model. A hard block reads
 * as an outage, and the ceiling is a cost control, not a safety one.
 */
export function overCeiling(totalCost, ceiling) {
    return ceiling != null && Number(totalCost ?? 0) >= ceiling
}

export async function getMonthlyUsage(userId, month = monthKey()) {
    const db  = await getDb()
    const doc = await db.collection(COLLECTION).findOne({ userId, month })

    const totalCost = doc?.totalCost ?? 0
    return {
        month,
        totalCost:    +totalCost.toFixed(4),
        budgetUsd:    TOKEN_BUDGET_USD,
        percentUsed:  +(Math.min(100, (totalCost / TOKEN_BUDGET_USD) * 100)).toFixed(1),
        inputTokens:       doc?.inputTokens      ?? 0,
        outputTokens:      doc?.outputTokens     ?? 0,
        cacheReadTokens:   doc?.cacheReadTokens  ?? 0,
        cacheWriteTokens:  doc?.cacheWriteTokens ?? 0,
        byModel:           doc?.byModel          ?? {},
        byAgent:           doc?.byAgent          ?? {},
    }
}
