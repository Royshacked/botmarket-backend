import { getDb } from '../providers/mongodb.provider.js'
import { COLLECTION as USERS } from '../api/user/user.model.js'
import { config } from './config.js'

const TOKEN_BUDGET_USD = config.tokenBudgetUsd
export const COLLECTION = 'token_usage'

// Pricing per 1M tokens in USD. cacheRead is 0.1x input; cacheWrite is the 5-minute write
// (1.25x input). A 1-hour write is 2x and is priced from the `cache_creation` breakdown the API
// returns beside the total — see calcCost — so the row carries no separate column for it.
// Opus is $5/$25 as of the 4.7 generation; the old $15/$75 was Opus-3-era and
// overstated every Opus row by 3x while it was in here.
const PRICING = {
    'claude-haiku-4-5-20251001': { input: 1.00,  output: 5.00,  cacheRead: 0.10,  cacheWrite: 1.25  },
    // $2/$10 was announced as introductory through 2026-08-31; Anthropic then made it the standard
    // price (the pricing page, read 2026-09-20). It was carried at $3/$15 until then on purpose —
    // over-reporting is the safe direction for a ceiling — and that reason has expired.
    'claude-sonnet-5':          { input: 2.00,  output: 10.00, cacheRead: 0.20,  cacheWrite: 2.50  },
    'claude-sonnet-4-6':        { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
    'claude-opus-5':            { input: 5.00,  output: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  },
    'claude-opus-4-8':          { input: 5.00,  output: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  },
}
const DEFAULT_PRICING = { input: 3.00, output: 15.00 }

// The 1-hour cache write is 2x input where the 5-minute one is 1.25x — 1.6x the 5-minute rate.
const CACHE_WRITE_1H_OVER_5M = 2 / 1.25

// web_search is billed per SEARCH on top of the tokens: $10 per 1,000 (the pricing page). It rides
// in `usage.server_tool_use.web_search_requests`, not in any token column, so a desk that searched
// on every turn looked exactly as cheap as one that never did until this was read.
export const WEB_SEARCH_USD = 0.01

export function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/** Searches this response ran, off the server-tool counter. 0 when the response had none. */
export function searchesIn(usage) {
    return Number(usage?.server_tool_use?.web_search_requests ?? 0) || 0
}

// Exported for testing.
export function calcCost(model, usage) {
    const p = PRICING[model] ?? DEFAULT_PRICING
    // `cache_creation_input_tokens` is the TOTAL written; `cache_creation` splits it by TTL. The
    // 1-hour share is priced at its own rate; whatever the split does not name is the 5-minute
    // write, which keeps a response without the breakdown (older shapes, the fakes in tests)
    // priced exactly as before.
    const written   = usage.cache_creation_input_tokens ?? 0
    const written1h = Math.min(written, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0)
    const write5m   = p.cacheWrite ?? 0
    return (
        (usage.input_tokens             ?? 0) * p.input             / 1_000_000 +
        (usage.output_tokens            ?? 0) * p.output            / 1_000_000 +
        (usage.cache_read_input_tokens  ?? 0) * (p.cacheRead ?? 0)  / 1_000_000 +
        (written - written1h)                 * write5m             / 1_000_000 +
        written1h                             * write5m * CACHE_WRITE_1H_OVER_5M / 1_000_000 +
        searchesIn(usage)                     * WEB_SEARCH_USD
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
 *
 * @param {{ monitor?: boolean }} [opts]  `monitor: true` for spend a MONITOR incurred rather than a
 *   conversation. It is still counted in every total — it is the user's money — but it is also
 *   accumulated separately, because the spend CEILING must not read it. See `chatSpend`.
 */
export async function recordUsage(userId, model, usage, agent, { monitor = false } = {}) {
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
    const searches   = searchesIn(usage)

    await db.collection(COLLECTION).updateOne(
        { userId, month: key },
        {
            $inc: {
                inputTokens:       input,
                outputTokens:      output,
                cacheReadTokens:   cacheRead,
                cacheWriteTokens:  cacheWrite,
                // Counted, not just priced: a search is the one line item with no token behind it,
                // so without its own counter the reports could not say where the $ went.
                searches,
                totalCost:         cost,
                // A SECOND accumulator, not a second total: monitor spend is inside `totalCost` (the
                // reports show what the user actually cost) and is ALSO summed here so the ceiling
                // can subtract it. An absent field reads as 0, so documents written before this
                // behave exactly as they did — no migration, no month reset.
                ...(monitor ? { monitorCost: cost } : {}),
                [`byModel.${mKey}.inputTokens`]:  input,
                [`byModel.${mKey}.outputTokens`]: output,
                [`byModel.${mKey}.cost`]:         cost,
                // Cache columns are carried per AGENT and not per model, deliberately: the model is
                // a price, the agent is the thing you can actually change.
                [`byAgent.${aKey}.inputTokens`]:      input,
                [`byAgent.${aKey}.outputTokens`]:     output,
                [`byAgent.${aKey}.cacheReadTokens`]:  cacheRead,
                [`byAgent.${aKey}.cacheWriteTokens`]: cacheWrite,
                [`byAgent.${aKey}.searches`]:         searches,
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
 * `exemptFromBudget` is the escape hatch rather than the admin role: whether the house desk's
 * operator should be exempt from a budget is a decision nobody has taken, and reading `role` here
 * would take it by accident. Admin can map onto this whenever it is revisited.
 */
export function ceilingFor(user, configured = config.tokenDegradeUsd) {
    if (user?.exemptFromBudget) return null
    const own = Number(user?.budgetUsd)
    if (Number.isFinite(own)) return own > 0 ? own : null
    return configured
}

/**
 * THE SPEND THE CEILING IS ALLOWED TO READ — everything except what the monitors incurred. Pure.
 *
 * The ceiling degrades a user's CHAT to the cheap model. Monitor spend is not chat: it is the
 * mechanical cost of watching positions the user already opened, it arrives on a clock they do not
 * control, and it is deliberately never blocked (the monitors call the provider directly and bypass
 * resolveAgentStream entirely, so an over-ceiling user still has their live position managed).
 *
 * Leaving it in the comparison made a user's own monitors degrade their conversation — a trader with
 * several armed setups reaching the cheap model faster than one with none, for spending nothing
 * extra on chat. `resolveAgentStream`'s comment said this must not happen and, while monitor spend
 * was unrecorded, it did not. `bookAssessUsage` started recording it and the exemption was never
 * written, so the stated design was quietly inverted.
 *
 * `monitorCost` is absent on every document written before that fix and reads as 0, so historical
 * months compare exactly as they did.
 */
export function chatSpend(doc) {
    return Math.max(0, Number(doc?.totalCost ?? 0) - Number(doc?.monitorCost ?? 0))
}

/**
 * Has this user spent past their ceiling this month? Pure, so the policy is testable without a
 * database and without a model.
 *
 * Takes the CHAT spend (see `chatSpend`), not the month's total.
 *
 * DEGRADE, NOT REFUSE: over the line the chat keeps working on the cheap model. A hard block reads
 * as an outage, and the ceiling is a cost control, not a safety one.
 */
export function overCeiling(spend, ceiling) {
    return ceiling != null && Number(spend ?? 0) >= ceiling
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
        searches:          doc?.searches         ?? 0,
        byModel:           doc?.byModel          ?? {},
        byAgent:           doc?.byAgent          ?? {},
    }
}
