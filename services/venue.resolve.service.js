import { toBrokerSymbol } from './brokerSymbol.service.js'
import { brokerService } from '../api/broker/broker.service.js'
import { accountMode } from '../api/broker/paperBroker.service.js'
import { computeBasisOffset } from '../api/broker/brokerPrice.service.js'
import { logger } from './logger.service.js'
import { resolveWorkspace } from '../api/workspace/workspace.model.js'

// The venue/symbol gate, shared by every entity that binds to a broker at Generate.
//
// Extracted from kairos.agent.service.js (which still re-exports it as `_resolveVenue` for its
// existing importers) so the `setup` kind resolves symbols through the SAME path as calls rather
// than growing a second copy of the cTrader basis logic. See docs/desks/mentor-talos.md

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
    // As in knownVenue: these literals DEFINE the workspace names, they do not dispatch on them.
    // isSelfExecuted is not the question here — a workspace is where a trade lives, which is a fact
    // about the document, not about what the venue can do.
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
 * THREE of them, not two — `manual` is a full sibling, not a flavour of live. It is real money at an
 * institution we cannot wire to, so it has no broker connection to derive itself from, which is
 * exactly why it needs the second argument. Paper and live need nothing: paper being connected IS
 * the switch.
 *
 * The rule itself lives in api/workspace/workspace.model.js, next to the record it reads, because
 * the frontend's useWorkspaceMode holds the same rule and the two must not drift. This function is
 * the venue-side door onto it, kept here beside resolveMode so the two "which world is this"
 * answers live together.
 *
 * `stored` is null for any caller that hasn't got it, which resolves to the paper-or-live answer
 * this returned before manual was persisted — so a missing read degrades to the old behaviour
 * rather than to a wrong one.
 *
 * @param {object} connections  brokerService.listConnections(userId)
 * @param {string|null} stored  getStoredWorkspace(userId) — the user's own last choice
 * @returns {'paper'|'live'|'manual'}
 */
export function activeWorkspace(connections = {}, stored = null) {
    return resolveWorkspace(!!connections?.paper, stored)
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
    // The two literals here are the DEFINITION of the workspace vocabulary, not a dispatch on it —
    // this is the function everything else asks. Do not route them through isSelfExecuted below:
    // that predicate answers a different question (who executes) and asking it here would make the
    // vocabulary depend on the capability table it is supposed to be independent of.
    if (broker === 'paper')  return 'paper'
    if (broker === 'manual') return 'manual'
    return LIVE_BROKERS.includes(broker) ? 'live' : null
}

/**
 * Is this venue one the USER executes at, rather than the app?
 *
 * THE ONE QUESTION every "post a card instead of placing an order" branch should ask. It used to be
 * asked as `broker === 'manual'` in eleven modules — entry, exit, the setup monitor, exit routing,
 * the manage hand-off, four rebalance paths and the manual-portfolio reads — which meant the venue's
 * defining behaviour was a string literal scattered across the app rather than a property of the
 * venue. A second broker-less venue would have had to be added to all eleven, and the one that got
 * missed would have silently placed a real order.
 *
 * Read off the adapter's own `capabilities().selfExecuted`, so the answer lives with the venue.
 *
 * NEVER THROWS, and that is load-bearing rather than defensive habit: `getBrokerAdapter` answers an
 * unregistered type with a 400, and the callers are monitors iterating live documents — a legacy doc
 * with `broker: null`, or one naming a venue since removed, must resolve to "the app executes here"
 * (which then fails visibly at the broker call) rather than take down the tick for every other
 * entity in the batch. Same posture as tradingContext.service._caps.
 */
export function isSelfExecuted(broker) {
    try { return !!brokerService.capabilities(broker)?.selfExecuted }
    catch { return false }
}

/**
 * Can a trade be BOUND to this venue — is there anything here that will ever fill it?
 *
 * Two ways to answer yes and they are genuinely different: the app can place the order
 * (`trading`), or the account holder will (`selfExecuted`). Either one means the entity has a
 * future; neither means it would be persisted to be watched by a monitor that can never act.
 *
 * Derived rather than listed, because a hard list is a second broker registry and it goes stale
 * silently in the ONE direction nobody notices — outwards. `setups.service` held
 * `['ctrader','paper','manual']`, which is right today and becomes wrong the moment IBKR's trading
 * flips on: a user with only IBKR connected would be told `no_venue` on every Generate, with
 * nothing in the message pointing at a list in a file they never edited. This yields exactly those
 * three today (IBKR is excluded because it can do neither — see the flag note in broker.interface)
 * and admits it automatically when it can.
 *
 * Never throws, for the same reason isSelfExecuted doesn't.
 */
export function isBindableVenue(broker) {
    try {
        const caps = brokerService.capabilities(broker)
        return !!(caps?.trading || caps?.selfExecuted)
    } catch { return false }
}
