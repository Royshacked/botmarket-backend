// Shared trading-context accessor (docs/desks/kairos-hermes.md cross-cutting). Assembles the user's AUTHORITATIVE
// venue + account menu from existing backend state (broker connections + accounts + capabilities +
// paper/manual) — NO new persisted state. One read used by all desk agents (idea/kairos/atlas) + the
// feasibility gate + sizing. Best-effort: never throws; a failed leg just drops from the menu.
//
// Returns:
//   { modes: { paper: bool, manual: bool, live_brokers: [name] },
//     workspace: 'paper'|'live',   ← the one the user is SITTING IN (see activeWorkspace)
//     accounts: [ { id, broker, mode, name, balance, freeMargin, currency, capabilities, selected, positions } ],
//     unavailable: [broker] }   ← brokers whose position read failed; their book is UNKNOWN, not flat
//
// Every agent reaches this through the tools in tradingContext.tools.js — it is the ONE answer to
// "where am I trading, with what, and holding what", so no desk has to assemble it again. It owns
// no data: it composes brokerService / paperBrokerService into the shape a model can read. Per
// CLAUDE.md, share the pipe not the judgment — what a desk DOES with a $12k balance or a crowded
// book stays that desk's call.

import { brokerService } from '../api/broker/broker.service.js'
import { paperBrokerService, VIRTUAL_MODES } from '../api/broker/paperBroker.service.js'
import { activeWorkspace } from './venue.resolve.service.js'
import { toBrokerSymbol } from './brokerSymbol.service.js'
import { positionPnlPct } from './agentUtils.js'
import { logger } from './logger.service.js'

const LOG = '[tradingContext]'

function _caps(broker, svc = brokerService) {
    try { return svc.capabilities(broker) } catch { return {} }
}

// Open positions per broker, keyed by the account they live on. Adapters return EVERY account's
// positions when no accountId is passed (true of cTrader, paper and manual alike), so one call per
// broker covers the whole venue. Best-effort per broker — one unreachable venue must not blank the
// others' books.
// A broker whose read THREW is named in `failed` rather than left to look flat: an empty book and
// an unanswered one are the same shape and opposite facts, and "you hold nothing" is the more
// dangerous of the two to say by accident. Same rule performance/watchlist already keep with their
// `unavailable` list.
async function _positionsByAccount(userId, brokers) {
    const byAccount = new Map()
    const failed = []
    await Promise.all(brokers.map(async (broker) => {
        try {
            const raw = await brokerService.getPositions(broker, userId)
            for (const p of (Array.isArray(raw) ? raw : [])) {
                const key = String(p.accountId ?? p.accountNo ?? '')
                if (!byAccount.has(key)) byAccount.set(key, [])
                byAccount.get(key).push({
                    symbol:       p.symbol ?? null,
                    direction:    p.direction ?? null,
                    quantity:     p.volume ?? null,
                    entryPrice:   p.entryPrice ?? null,
                    currentPrice: p.currentPrice ?? null,
                    pnl:          p.pnl ?? null,
                    // The raw BrokerPosition carries no %, so derive it the way every other
                    // surface does (shared helper — sign-flipped for shorts).
                    pnlPct:       _round(positionPnlPct(p)),
                })
            }
        } catch (err) {
            logger.warn(LOG, `getPositions(${broker}) failed`, err.message)
            failed.push(broker)
        }
    }))
    return { byAccount, failed }
}

const _round = (v) => (v == null || !Number.isFinite(Number(v))) ? null : Number(Number(v).toFixed(2))

export async function getTradingContext(userId) {
    const empty = { modes: { paper: false, manual: false, live_brokers: [] }, workspace: 'live', accounts: [], unavailable: [] }
    if (!userId) return empty

    let connections
    try { connections = await brokerService.listConnections(userId) }
    catch (err) { logger.warn(LOG, 'listConnections failed', err.message); return empty }

    const liveBrokers = Object.entries(connections)
        .filter(([b, on]) => on && !VIRTUAL_MODES.includes(b))
        .map(([b]) => b)

    const accounts = []
    const activeBrokers = Object.entries(connections).filter(([, on]) => on).map(([b]) => b)
    // Fetched once for every venue, then attached per account below — so "which positions are open
    // in each account" is answered in the same read as "which accounts do I have".
    const { byAccount: positionsByAccount, failed: unavailable } = await _positionsByAccount(userId, activeBrokers)
    const posFor = (id) => positionsByAccount.get(String(id)) ?? []

    // Live broker accounts.
    for (const broker of liveBrokers) {
        try {
            const { accounts: accs = [], selectedAccountId = null } = await brokerService.getTradingAccounts(broker, userId)
            const caps = _caps(broker)
            for (const a of accs) accounts.push({
                id: String(a.id), broker, mode: 'live',
                name: a.name ?? a.login ?? String(a.id),
                balance: a.balance ?? null, currency: a.currency ?? null, capabilities: caps,
                // What is actually deployable. Balance includes capital already in the positions
                // listed alongside it, so an agent sizing against balance spends it twice. null when
                // the broker doesn't report it — the renderer then falls back to balance rather than
                // inventing a number.
                freeMargin: a.freeMargin ?? null,
                // Which account an order would actually go to today, when the user holds several.
                selected: selectedAccountId != null && String(selectedAccountId) === String(a.id),
                positions: posFor(a.id),
            })
        } catch (err) { logger.warn(LOG, `getTradingAccounts(${broker}) failed`, err.message) }
    }

    // Virtual (paper / manual) accounts.
    for (const mode of ['paper', 'manual']) {
        if (!connections[mode]) continue
        try {
            const accs = await paperBrokerService.listAccounts(userId, { mode })
            const caps = _caps(mode)
            for (const a of accs) {
                const id = String(a.accountId ?? a.id)
                accounts.push({
                    id, broker: mode, mode,
                    name: a.name ?? id,
                    balance: a.cashBalance ?? a.balance ?? null, currency: a.currency ?? null, capabilities: caps,
                    freeMargin: a.freeMargin ?? null,   // see the live branch above
                    // Virtual accounts are picked per artifact, not globally — there is no
                    // "selected" one to report.
                    selected: false,
                    positions: posFor(id),
                })
            }
        } catch (err) { logger.warn(LOG, `listAccounts(${mode}) failed`, err.message) }
    }

    return {
        modes: { paper: !!connections.paper, manual: !!connections.manual, live_brokers: liveBrokers },
        // Which workspace the user is SITTING IN, not merely which are available. Without it the
        // menu reads as a flat list and a desk answers about the live cTrader book while the user
        // is in paper — the accounts are all true, just not the ones they are looking at.
        workspace: activeWorkspace(connections),
        accounts,
        // Brokers whose position read failed — their accounts appear with an empty book that is NOT
        // a flat one. Additive: existing consumers that only read modes/accounts are unaffected.
        unavailable,
    }
}

/**
 * Is this ticker tradable at the user's LIVE venues, and what is it called there?
 *
 * Two steps, because neither alone is enough. The STATIC alias map bridges the semantic gap a
 * broker cannot ('NQ' → the index 'US100' — a broker's symbol list only knows its own names), then
 * the broker resolves that base to its exact tradable name ('US100' → 'US100.cash') and confirms it
 * is actually listed on the account. Same order as _resolveBrokerSymbol uses at save time, so what
 * a desk is told here is the name the order will really carry.
 *
 * Per venue the answer is one of THREE, and the third is the whole reason this exists:
 *   tradable: true   — listed; `brokerSymbol` is what the order will use
 *   tradable: false  — the broker answered, and does not list it
 *   tradable: null   — the broker could not be reached: UNKNOWN, never "no"
 * Telling a trader an instrument is unavailable because a socket timed out is worse than admitting
 * you don't know, so those two states are never merged.
 *
 * Only venues that can actually place orders are asked (capabilities().trading — never the broker
 * name): a data-only venue would return a confident, meaningless answer. Paper/manual accept
 * anything the app can price, which is why this is a LIVE-broker question.
 *
 * @returns {Promise<{ ticker: string, venues: object[] }>}
 */
export async function checkBrokerSymbol(userId, ticker, deps = {}) {
    const { broker: svc = brokerService, mapSymbol = toBrokerSymbol } = deps
    const symbol = String(ticker ?? '').trim().toUpperCase()
    if (!userId || !symbol) return { ticker: symbol, venues: [] }

    let connections
    try { connections = await svc.listConnections(userId) }
    catch (err) { logger.warn(LOG, 'listConnections failed', err.message); return { ticker: symbol, venues: [] } }

    const brokers = Object.entries(connections)
        .filter(([b, on]) => on && !VIRTUAL_MODES.includes(b) && _caps(b, svc).trading)
        .map(([b]) => b)

    const venues = await Promise.all(brokers.map(async (broker) => {
        const mapped = mapSymbol(broker, symbol)
        // Ask the symbol list of the account an order would actually go to.
        let accountId = null
        try {
            const { selectedAccountId, accounts = [] } = (await svc.getTradingAccounts(broker, userId)) ?? {}
            accountId = selectedAccountId ?? accounts[0]?.id ?? null
        } catch { /* resolveSymbol may still manage without one */ }

        try {
            const res = await svc.resolveSymbol(broker, userId, accountId, mapped)
            return {
                broker,
                tradable:     !!res?.found,
                brokerSymbol: res?.found ? (res.symbol ?? mapped) : null,
                // Surfaced when the app's alias map renamed it, so a desk seeing 'US100.cash' on an
                // order can tie it back to the NQ it asked for.
                ...(mapped !== symbol ? { mappedFrom: symbol } : {}),
            }
        } catch (err) {
            logger.warn(LOG, `resolveSymbol ${symbol}→${mapped} on ${broker} failed`, err.message)
            return { broker, tradable: null, brokerSymbol: null, error: 'broker unreachable — availability unknown' }
        }
    }))

    return { ticker: symbol, venues }
}

// ─── Availability, enforced rather than requested ─────────────────────────────
// The enforcement itself (`withBrokerAvailability`) lives in tradingContext.tools.js, NOT here.
// Its whole job is decorating a TOOL PAYLOAD for a model to read, which makes it a formatting
// concern, and keeping it beside the read is what let it ship broken: written service-side it
// assumed an object payload, while its only caller — get_quote — returns TEXT, so it silently
// returned every quote untouched and the "every quote carries availability" rule never once fired.
// This file stays what it says it is: the reads.
