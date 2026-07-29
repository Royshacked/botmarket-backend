import { paperBrokerService } from '../broker/paperBroker.service.js'
import { resolveMode } from '../../services/venue.resolve.service.js'

// ── Workspace mode / broker / account derivation ────────────────────────────────
// Shared by the review-notification path (portfolioChat.service) and the portfolio
// state snapshot (portfolioState.service) so Atlas is told WHERE a book trades —
// paper / live / manual, which broker, and which account(s). Pure logic mirrors the
// frontend tradeIdea.utils.ideaWorkspace deriver; extracted here to avoid a circular
// import between portfolioChat and portfolioState.

// Display names for the live brokers (raw keys are lowercase).
export const BROKER_LABELS = { ctrader: 'cTrader', ibkr: 'IBKR' }

// An idea's account can be a bare id string or a { id } object; take the first.
export function _firstAccountId(accounts) {
    const a = (accounts ?? [])[0]
    if (a == null) return null
    return typeof a === 'object' ? a.id : a
}

// 'paper' | 'manual' | 'live'. This WAS the only correct implementation of the dual signal, so it
// became the shared one (services/venue.resolve.resolveMode). Kept as a named wrapper because the
// portfolio paths and its unit tests call it by this signature.
export function _deriveMode(broker, accountId) {
    return resolveMode({ broker, accountId })
}

// Batch-resolve virtual-account display names, one listAccounts per distinct user.
// Best-effort: a failed lookup just leaves the account unresolved (label falls back).
export async function _virtualAccountNames(userIds) {
    const uniq = [...new Set((userIds ?? []).filter(Boolean))]
    const map  = {}
    await Promise.all(uniq.map(async uid => {
        try {
            const accts = await paperBrokerService.listAccounts(uid)
            for (const a of accts) map[a.accountId] = a.name
        } catch { /* leave unresolved */ }
    }))
    return map
}

// A human-friendly account label. Virtual accounts show their user name; live accounts
// show "<Broker> #<login>" (the broker login IS the id).
export function _accountLabel(mode, accountId, nameByAccount, broker = null) {
    const fallback = mode === 'manual' ? 'Manual' : mode === 'paper' ? 'Paper' : 'Live account'
    if (!accountId) return fallback
    if (mode === 'paper' || mode === 'manual') return nameByAccount[accountId] ?? fallback
    const brokerLabel = BROKER_LABELS[broker] ?? (broker ? String(broker) : 'Live')
    return `${brokerLabel} #${accountId}`
}

/**
 * One-line workspace summary for Atlas's context block: the mode (paper/live/manual),
 * and for a live book the broker; then the account(s) — pluralised when more than one.
 * Pure — takes the workspace object built by computePortfolioState.
 *
 * @param {{ mode?: string, brokerLabel?: string|null, accounts?: {id:string,label:string}[] }} ws
 * @returns {string|null}
 */
export function formatWorkspaceLine(ws) {
    if (!ws) return null
    const labels  = (ws.accounts ?? []).map(a => a.label).filter(Boolean)
    const acctStr = labels.length ? labels.join(', ') : '—'
    const acctKey = `Account${labels.length > 1 ? 's' : ''}`
    if (ws.mode === 'live') {
        return `Workspace: LIVE · Broker: ${ws.brokerLabel ?? '—'} · ${acctKey}: ${acctStr}`
    }
    const modeWord = ws.mode ? ws.mode.toUpperCase() : 'UNKNOWN'
    return `Workspace: ${modeWord} · ${acctKey}: ${acctStr}`
}
