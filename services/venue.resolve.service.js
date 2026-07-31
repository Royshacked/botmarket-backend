import { toBrokerSymbol } from './brokerSymbol.service.js'
import { brokerService } from '../api/broker/broker.service.js'
import { accountMode } from '../api/broker/paperBroker.service.js'
import { computeBasisOffset } from '../api/broker/brokerPrice.service.js'
import { logger } from './logger.service.js'

// The venue/symbol gate, shared by every entity that binds to a broker at Generate.
//
// Extracted from kairos.agent.service.js (which still re-exports it as `_resolveVenue` for its
// existing importers) so the `setup` kind resolves symbols through the SAME path as calls rather
// than growing a second copy of the cTrader basis logic. See docs/setup-entity.md §8.

const LOG = '[venue]'

/**
 * Bind an asset to a broker's price space: the broker-native symbol plus the basis offset between
 * chart space and broker space.
 *
 * Only cTrader needs resolving (NQ → US100 → US100.cash, plus the index basis). Paper and manual
 * trade in chart space, so symbol == asset and offset == 0.
 *
 * Never throws: a failed symbol lookup falls back to the static alias map, and a failed basis
 * computation falls back to zero. Binding must not be the thing that blocks a Generate.
 * Deps injectable for tests (no network).
 */
export async function resolveVenue(broker, userId, accountId, asset, deps = {}) {
    const {
        toBrokerSymbol:     _toBrokerSymbol     = toBrokerSymbol,
        // Wrapped (not detached) so the real brokerService method keeps its receiver.
        resolveSymbol:      _resolveSymbol      = (...args) => brokerService.resolveSymbol(...args),
        computeBasisOffset: _computeBasisOffset = computeBasisOffset,
    } = deps

    if (broker !== 'ctrader') return { broker_symbol: asset, basis_offset: 0 }

    const mapped = _toBrokerSymbol('ctrader', asset)
    let brokerSymbol = mapped
    try {
        const res = await _resolveSymbol('ctrader', userId, accountId, mapped)
        if (res?.found && res.symbol) brokerSymbol = res.symbol
    } catch (err) {
        logger.warn(LOG, `resolveSymbol ${asset}→${mapped} failed — using static map: ${err.message}`)
    }

    let basis_offset = 0
    try {
        const { offset } = await _computeBasisOffset({ brokerSymbol, asset })
        basis_offset = offset || 0
    } catch (err) {
        logger.warn(LOG, `basis offset failed for ${asset}→${brokerSymbol}: ${err.message}`)
    }

    return { broker_symbol: brokerSymbol, basis_offset }
}

// ─── The venue chain: mode → broker → accounts ────────────────────────────────
//
// Every agent and every execution path needs the same three answers about a trade: which
// WORKSPACE it belongs to, which BROKER runs it when that workspace is live, and which ACCOUNTS
// it touches in any workspace. This module is the single authority for all three.
//
// It replaces five divergent copies (kairos.handoff, tradeCapture, portfolioMode, this module's
// own former modeForBroker, and the frontend's isPaperIdea). They did NOT agree: only some
// implemented the account-prefix fallback, so a legacy doc with no `broker` field resolved as
// paper in the UI and LIVE in the canonical trades ledger.

/** The supported live brokers. Paper and manual are workspaces, not brokers. */
export const LIVE_BROKERS = ['ctrader', 'ibkr']

/** Every workspace a trade can live in. The frontend mirrors this list. */
export const WORKSPACE_MODES = ['live', 'paper', 'manual']

/**
 * The WORKSPACE a trade belongs to: 'live' | 'paper' | 'manual'. Never null — every trade lives
 * somewhere, and defaulting to 'live' is the safe direction (it can only over-warn, never
 * mislabel real money as simulated).
 *
 * DUAL SIGNAL, and both halves matter:
 *   1. the `broker` field stamped at save time — authoritative when present;
 *   2. the `paper-<userId>` / `manual-<userId>` account-id prefix — the fallback for legacy docs
 *      written before `broker` existed, and for positions whose broker field isn't the literal
 *      workspace name.
 *
 * Dropping (2) is what let paper fills be recorded as live trades. Accepts anything carrying a
 * broker and/or account: an idea, a setup, a call, a position, or a bare { broker, accountId }.
 */
export function resolveMode(source = {}) {
    // An already-stamped mode is the frozen answer — return it rather than recomputing, so calling
    // this on a stored doc can never contradict what that doc says about itself. Producers pass a
    // source with no `mode` (a fresh partition / account list) and fall through to derivation.
    // A junk value is NOT trusted; it falls through too.
    if (WORKSPACE_MODES.includes(source?.mode)) return source.mode

    const broker = source?.broker ?? null
    if (broker === 'paper' || broker === 'manual') return broker

    for (const id of resolveAccountIds(source)) {
        const mode = accountMode(id)
        if (mode) return mode
    }
    return 'live'
}

/**
 * The workspace the user is WORKING IN right now — a different question from resolveMode(), which
 * answers where an existing trade LIVES. A user with a cTrader account connected can still be sat
 * in the paper workspace, and everything an agent says should be about the book in front of them.
 *
 * Paper being connected IS the switch: the frontend's useWorkspaceMode derives the workspace the
 * same way (paper ON ⇔ the paper workspace, straight off this flag), so the two stay in step
 * without the client having to tell us. Kept here beside resolveMode so the two "which world is
 * this" answers live together.
 *
 * KNOWN GAP: 'manual' is a frontend-local overlay (localStorage) with no server-side flag, so a
 * user sitting in the manual workspace reads as 'live' here. Closing that needs the client to send
 * its workspace on the chat request; paper — the reported case — needs nothing.
 *
 * @param {object} connections  brokerService.listConnections(userId)
 * @returns {'paper'|'live'}
 */
export function activeWorkspace(connections = {}) {
    return connections?.paper ? 'paper' : 'live'
}

/**
 * Every account id on a source, in precedence order (main first). Accepts the several shapes the
 * codebase stores accounts in: a bare id, an { id } object, or an { accountId }.
 */
export function resolveAccountIds(source = {}) {
    const ids = [
        source?.mainAccountId,
        source?.accountId,
        ...(Array.isArray(source?.accounts) ? source.accounts : []),
    ]
    return ids
        .map(a => (a && typeof a === 'object' ? (a.id ?? a.accountId) : a))
        .filter(a => a != null && a !== '')
        .map(String)
}

/**
 * The broker actually running this trade — only meaningful in the live workspace. Paper and
 * manual return null, because "paper" names a workspace, not a venue that fills orders.
 */
export function resolveBroker(source = {}) {
    return resolveMode(source) === 'live' ? (source?.broker ?? null) : null
}

/**
 * Is this a SUPPORTED venue? A different question from resolveMode: this one is allowed to say
 * "I don't know" (null), and callers use that as a validity gate before binding execution.
 * resolveMode always commits to a workspace; this refuses to guess.
 */
export function knownVenue(broker) {
    if (broker === 'paper')  return 'paper'
    if (broker === 'manual') return 'manual'
    return LIVE_BROKERS.includes(broker) ? 'live' : null
}
