// "FIND ONE FOR ME", in a background build (docs/design/modes-and-builders.md M18, step 8 — Roy, 2026-11-20): the trader's
// card answered with no name → the stock picker is asked, headless, for his two or three best names from the house's
// list (`<argus_candidates>`, gated to the lists like his pick) → a card asks the user which → the build goes on with it.
// Before, the trader routed the user to the stock picker in the chat — a conversation the background build has no room for.
//
// Built as a factory so the tests run it with a stub chat.

import { scannerAgentService } from '../agents/scanner.agent.service.js'
import { logger } from '../logger.service.js'

const LOG = '[candidates]'
export const FIND_ONE = 'Find one for me'
const DEFAULT_HORIZON = 'swing'

/** The app's note to the stock picker. Pure. */
export function candidatesNote(horizon = DEFAULT_HORIZON) {
    return `[App note, not the user's words: CANDIDATES for a trade the trader builds in the background — the user picks the name on a card. ` +
        `Horizon: ${horizon}. Read that list (get_horizon_list) and give the two or three best names from it in <argus_candidates>; no pick, no question.]`
}

/** The pick card's one question: the candidates as options, a ticker of their own as Other. Pure. */
export function pickQuestion(candidates = [], reply = '') {
    const why = String(reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
    return {
        id: 'name', header: 'Name', multiSelect: false, other: true,
        question: candidates.length ? 'Which name should the trader build?' : `The stock picker found no name${why ? `: ${why}` : ''} — type a ticker to build instead.`,
        options: candidates.map(c => ({ label: c.ticker, ...(c.thesis ? { description: c.thesis } : {}) })),
    }
}

export function makeCandidates({ chat = (args) => scannerAgentService.chatStream(args) } = {}) {
    /** @returns {Promise<{ candidates: { ticker: string, thesis: string }[], reply: string }>} never throws */
    async function find({ userId, horizon = DEFAULT_HORIZON }) {
        try {
            const r = await chat({ messages: [{ role: 'user', content: candidatesNote(horizon) }], userId })
            return { candidates: Array.isArray(r?.candidates) ? r.candidates : [], reply: r?.reply ?? '' }
        } catch (err) {
            logger.warn(LOG, 'the stock picker failed', err.message)
            return { candidates: [], reply: 'the stock picker could not be reached just now' }
        }
    }
    return { find }
}

export const candidates = makeCandidates()
