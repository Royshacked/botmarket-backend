// remember_about_user — a lasting fact the user STATED, kept for every role (services/userProfile.service.js,
// docs/design/one-axl.md step 3). The judgment of WHEN is the same at every desk, so the description is one constant;
// the handler is wired once, in runAgentStream (the consult pattern): a desk opts in by declaring the tool.

import { makeToolHandler } from '../agentUtils.js'
import { userProfileService } from '../userProfile.service.js'

export const REMEMBER_TOOL = 'remember_about_user'

export const REMEMBER_DESCRIPTION = `Keep a LASTING fact about the user that they STATED, so every role knows it next time — "I never trade low-float names", "I only trade the first hour", "I hold through earnings", "call me by my first name". What you keep shows in ABOUT THE USER on every role's turns.
- Only what THEY said about themselves, as a lasting rule or preference — never your read of them, never this trade's levels or size (the build keeps those), never a mood.
- Never ask questions to fill it. Keep it the moment they say it, and say in a few words that you will remember.
- They take one back ("I do trade small caps now") → call it with \`forget: true\` and the words of the old note.`

/** The handler for one turn's user. `agent` — who kept it, for the record. */
export function makeRememberHandler({ userId, agent = null, profiles = userProfileService } = {}) {
    return makeToolHandler(REMEMBER_TOOL, async ({ note, forget = false } = {}) => {
        if (!userId) return 'There is no signed-in user to remember this for.'
        if (forget === true) {
            const out = await profiles.forget(userId, note)
            return out.ok && out.removed ? `Removed ${out.removed} note(s). Say so in a few words.` : 'No note matched — nothing to remove.'
        }
        const out = await profiles.remember(userId, note, { by: agent })
        if (!out.ok) return `Not kept: ${out.reason}.`
        return out.unchanged ? 'Already kept — nothing to add.' : 'Kept. Every role will see it from the next turn; say in a few words that you will remember.'
    }, (err) => `Could not keep it: ${err.message}. Carry on without it.`, '[userProfile.tools]')
}
