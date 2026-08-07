/**
 * `set_experience_level` — how Axl records who it is talking to.
 *
 * The asymmetry is NOT enforced here. It lives in experience.service.js's `maySet`, and this tool
 * simply reports what the service decided. That matters: a guard in a tool handler is still a guard
 * a future caller can route around, whereas one in the service holds for every path. What this
 * layer adds is telling the MODEL why it was refused, so it asks the user instead of retrying.
 *
 * `source` is the model's own account of what happened — did the user say this, or did you conclude
 * it? A model could in principle mislabel an inference as a declaration to get past the guard. That
 * is accepted rather than defended against: the consequence is a voice change the user can reverse
 * in one sentence, and hardening it would cost more than the failure does.
 */

import { makeToolHandler } from '../agentUtils.js'
import { setExperienceLevel } from '../experience.service.js'

const LOG = '[experienceTools]'

export function makeExperienceHandlers(userId = null, deps = {}) {
    const { set = setExperienceLevel } = deps
    return {
        set_experience_level: makeToolHandler('set_experience_level',
            async ({ level, source } = {}) => {
                const wanted = level === 'unset' ? null : level
                const result = await set(userId, wanted, source)
                if (!result.ok) {
                    // A refusal, not a failure. The model gets the reason so it can do the right
                    // thing next — which for an inferred "experienced" is to let the user say it.
                    return { saved: false, reason: result.reason }
                }
                return {
                    saved: true,
                    level: result.level,
                    // The whole justification for inferring at all: the user is TOLD. Repeated here
                    // so the reply that follows the tool call doesn't quietly skip it.
                    remember: result.level === 'beginner' && source === 'inferred'
                        ? 'Tell the user, in one short line, that you will keep things plain and that they can ask you to stop any time. Do not make a production of it.'
                        : null,
                }
            },
            (err) => `Could not record the experience level: ${err.message}`, LOG),
    }
}

export const EXPERIENCE_TOOL_SPEC = {
    set_experience_level: `Record how much trading experience this user has, so every desk knows how to talk to them. Set 'beginner' when it is clear from how they write — they ask what a basic term means, describe a goal with no mechanics, or say outright they are new. Set 'experienced' ONLY when they tell you so themselves ("talk to me normally", "I've traded for years"); you may not conclude it from jargon, and the attempt will be refused. Use 'unset' if they ask you to forget it. Pass source 'declared' when the user said it in their own words, 'inferred' when you worked it out. This changes how the desks WORD things — never what they decide, never a level or a size. Call it once when it becomes clear, not every turn.`,
}
