/**
 * The intake tool — how Axl records what the user is actually here for.
 *
 * A TOOL rather than an emit tag, deliberately. Tags are one-way: the model throws a string over
 * the wall and never learns whether it landed. Intake needs the opposite — a typed schema so the
 * provider rejects a half-stated goal before it reaches us, and a return value carrying the
 * computed deadline so the reply can read the goal back to the user in their own terms ("5% by
 * August 6th") instead of guessing at the date arithmetic.
 *
 * Args are FLAT (target_pct, horizon_days, …) rather than the nested shape we store. Models fill
 * flat schemas more reliably, and the nesting is our storage concern, not theirs — the mapping
 * happens here, in one place.
 */

import { createObjective } from './objective.service.js'
import { toObjectiveSummary } from '../api/objectives/objective.model.js'
import { makeToolHandler } from './agentUtils.js'

const LOG = '[objectiveTools]'

/**
 * Per-request handler, bound to a userId — the same shape as makeTradingContextHandlers.
 * @param {string|null} userId
 * @param {object} deps  { db, now } — the storage seam, so a test of the mapping needs no database
 */
export function makeObjectiveHandlers(userId = null, deps = {}) {
    return {
        save_objective: makeToolHandler('save_objective',
            async (args = {}) => {
                if (!userId) return { saved: false, reason: 'no signed-in user' }

                const saved = await createObjective(userId, {
                    target: {
                        pct: args.target_pct,
                        amount: args.target_amount,
                        currency: args.target_currency,
                    },
                    horizon: { days: args.horizon_days },
                    // Passed through exactly as given. An absent risk stays absent — see the rule
                    // in objective.model.js: a target implies nothing about drawdown tolerance.
                    risk: {
                        maxDrawdownPct: args.risk_max_drawdown_pct,
                        amount: args.risk_amount,
                    },
                    scope: args.scope,
                    symbol: args.symbol,
                }, deps)

                return {
                    saved: true,
                    id: saved.id,
                    // The deadline we computed, so the reply can state it rather than do the maths.
                    deadline: saved.horizon.until,
                    horizon_days: saved.horizon.days,
                    target: saved.target,
                    risk_stated: saved.risk.maxDrawdownPct != null || saved.risk.amount != null,
                    scope: saved.scope,
                    symbol: saved.symbol,
                    // The same goal in the shape the client renders. Nested so the flat fields above
                    // stay the ones the model reads when it writes the confirmation back to the user.
                    objective: toObjectiveSummary(saved),
                }
            },
            // buildObjectiveDoc throws when the goal isn't actually stated. Handing the model the
            // reason lets it ask for the missing half instead of silently dropping the intake.
            (err) => `Could not save the objective: ${err.message}`, LOG),
    }
}

/**
 * The tool DESCRIPTION — the instruction the model actually reads.
 * Spread into an agent's toolsFor({...}) spec.
 */
export const OBJECTIVE_TOOL_SPEC = {
    save_objective: `Record what the user is trying to achieve — their return target, the time they have in mind, the risk they said they'll accept, and whether it should come from one position or several. Call this ONCE you have the goal and before you hand them to a desk, so they don't get asked for all of it again. You need at least a target (percent or cash) and a horizon in days; the deadline date is computed for you. Only ever pass a risk number the user actually stated — never infer one from the target, and never supply a default. Saving this is not placing or planning a trade: it records what they told you.`,
}
