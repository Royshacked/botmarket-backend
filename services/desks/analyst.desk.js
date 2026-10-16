// Prometheus — researches a company into house coverage. Working state: `{ active_symbol, draft }`;
// the coverage list and the standing thesis are read fresh every turn (_resolveCoverageContext).
// One definition for the HTTP desk stream and the session turn (unified-chat plan phase 4).

import { analystAgentService } from '../agents/analyst.agent.service.js'
import { coverageService } from '../../api/analyst/coverage.service.js'
import { sanitizeScanSeed } from '../scanSeed.util.js'
import { logger } from '../logger.service.js'

const LOG = '[analyst:desk]'

// Enrich chatState with coverage data from the DB so the agent always knows what's already
// covered — without depending on the frontend to send it. The frontend can still override
// by pre-populating either field; we only fill what's missing.
export async function _resolveCoverageContext(chatState, seed) {
    const state = { ...chatState }

    if (!state.coverage_symbols?.length) {
        try {
            state.coverage_symbols = await coverageService.listSymbols({ onError: 'throw' })
        } catch (err) {
            logger.warn(LOG, '_resolveCoverageContext: listSymbols failed (non-fatal)', err.message)
        }
    }

    // Check the active ticker — seed hand-off takes precedence over chatState.active_symbol.
    const ticker = seed?.ticker
        ? String(seed.ticker).toUpperCase().trim()
        : chatState.active_symbol
            ? String(chatState.active_symbol).toUpperCase().trim()
            : null

    if (ticker && !state.existing_coverage) {
        try {
            const existing = await coverageService.getCoverageBySymbol(ticker)
            if (existing) state.existing_coverage = existing
        } catch (err) {
            logger.warn(LOG, '_resolveCoverageContext: getCoverageBySymbol failed (non-fatal)', err.message)
        }
    }

    return state
}

/**
 * The working state after a turn: the coverage draft (a new one replaces the old) and the name in focus.
 * The coverage list and the standing thesis are not state — read fresh every turn.
 */
export function analystNextState(prev, result, input = {}) {
    const draft = result.coverage ?? prev?.draft ?? null
    return {
        active_symbol: draft?.symbol || input.seed?.ticker || prev?.active_symbol || null,
        draft,
    }
}

export const analystDesk = {
    agent: 'analyst',
    log:   LOG,
    parse: (body, turn) => ({ state: turn.chatState ?? {}, input: { seed: sanitizeScanSeed(body.seed) } }),
    prepareInput: (input = {}) => ({ ...input, seed: sanitizeScanSeed(input.seed) }),
    nextState: analystNextState,
    run: async ({ state, input, emit, common }) => analystAgentService.chatStream({
        ...common,
        chatState: await _resolveCoverageContext(state ?? {}, input.seed ?? null),
        seed:      input.seed ?? null,
        onPhase:   phase => emit('phase', { phase }),
    }),
    done: (result) => ({ reply: result.reply, phase: result.phase ?? null, ...(result.coverage ? { coverage: result.coverage } : {}) }),
}
