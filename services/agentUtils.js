import { readFileSync, statSync } from 'fs'
import { getShortInterest, getOptionsContext } from '../providers/yahoofinance.provider.js'
import { getDerivativesContext } from '../providers/binance.provider.js'
import { toolError } from './toolResult.util.js'
import { logger } from './logger.service.js'
import { resolveStreamFn } from './llmModels.js'
import { recordUsage } from './tokenUsage.service.js'
import { _deriveMode, formatWorkspaceLine, BROKER_LABELS } from '../api/portfolio/portfolioMode.util.js'

const LOG = '[agentUtils]'

// ─── Streaming setup ──────────────────────────────────────────────────────────
// Resolve a requested model to its provider streaming fn + provider id, and build
// the standard per-request usage recorder (a no-op when there's no userId). Every
// streaming agent repeats these two lines verbatim; centralizing them means a new
// agent (e.g. Axl) can't silently diverge on model routing or usage accounting.
export function resolveAgentStream(requestedModel, userId) {
    const { model, streamFn, provider } = resolveStreamFn(requestedModel)
    const onUsage = userId ? (usage) => recordUsage(userId, model, usage).catch(() => {}) : undefined
    return { model, streamFn, provider, onUsage }
}

// ─── Tool handler wrapper ─────────────────────────────────────────────────────
// Wrap a raw handler `fn` in the standard try/catch shape: on throw, warn-log the
// failure under LOG (the logging trade's handlers already have, which portfolio/
// scanner previously omitted) and return a toolError() so the provider flags a
// failed call rather than passing an error string through as data.
//
// `errorMessage(err, args)` builds the exact toolError text — supplied per handler
// so the model-visible failure string stays byte-identical to what each agent
// returned before. `log` sets the [LOG] tag used for the warn line.
export function makeToolHandler(name, fn, errorMessage, log = LOG) {
    return async (args) => {
        try { return await fn(args) }
        catch (err) {
            logger.warn(log, `${name} failed:`, err.message)
            return toolError(errorMessage(err, args))
        }
    }
}

export const COMMON_TOOL_HANDLERS = {
    get_short_interest: makeToolHandler(
        'get_short_interest',
        ({ ticker }) => getShortInterest(ticker),
        (err, { ticker }) => `Could not fetch short interest for ${ticker}: ${err.message}`,
    ),
    get_options_context: makeToolHandler(
        'get_options_context',
        ({ ticker }) => getOptionsContext(ticker),
        (err, { ticker }) => `Could not fetch options context for ${ticker}: ${err.message}`,
    ),
    get_derivatives_context: makeToolHandler(
        'get_derivatives_context',
        ({ symbol }) => getDerivativesContext(symbol),
        (err, { symbol }) => `Could not fetch derivatives context for ${symbol}: ${err.message}`,
    ),
}

export function normalizeMessages(messages, maxCount) {
    if (!Array.isArray(messages)) return []
    const cleaned = messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map(({ role, content }) => ({ role, content: content.trim() }))
    // Coalesce consecutive same-role turns into one. Kairos threads a single reply across several
    // display bubbles (one per phase) → several assistant messages in a row; the model API needs
    // strict user/assistant alternation. A no-op for the agents that already alternate.
    const merged = []
    for (const m of cleaned) {
        const last = merged[merged.length - 1]
        if (last && last.role === m.role) last.content += `\n\n${m.content}`
        else merged.push({ ...m })
    }
    return merged.slice(-maxCount)
}

// ─── Prompt hot-reload loader ─────────────────────────────────────────────────
// Load a system-prompt file fresh when it changes (mtime-gated), so prompt edits
// take effect on the next request without a server restart. The read is skipped
// when the file is unchanged, so the steady-state cost is one statSync. Returns a
// zero-arg function that yields the current prompt text.
export function makePromptLoader(absPath, log = LOG) {
    let cache = { mtimeMs: 0, text: '' }
    return function loadPrompt() {
        try {
            const { mtimeMs } = statSync(absPath)
            if (mtimeMs !== cache.mtimeMs) {
                cache = { mtimeMs, text: readFileSync(absPath, 'utf-8') }
                logger.info(log, 'System prompt (re)loaded')
            }
        } catch (err) {
            if (!cache.text) throw err   // first load must succeed — surface it
            logger.warn(log, `prompt reload failed, using cached copy: ${err.message}`)
        }
        return cache.text
    }
}

// ─── Money / account formatting ───────────────────────────────────────────────
// Shared USD formatter and idea-accounts line builder. Each agent keeps only its
// own header sentence; the per-account lines are byte-identical across agents.
export function formatMoney(v) {
    return v != null ? `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'
}

// Which marked account a call / portfolio binds to as MAIN — the venue + monitoring anchor.
// Mirrors _finalizeCall's rule so the prompt an agent sees matches what save actually does:
// the explicitly-marked main if it's still in the list, else the first marked account. Ids are
// compared as strings (a marked-account id may arrive as a number or string). Returns null for
// an empty / id-less list.
export function resolveMainAccountId(accounts, mainAccountId = null) {
    const list = Array.isArray(accounts) ? accounts.filter(a => a && a.id != null) : []
    if (list.length === 0) return null
    const explicit = list.find(a => String(a.id) === String(mainAccountId))
    return String((explicit ?? list[0]).id)
}

// `mainAccountId` (optional) tags which account the trade binds to as MAIN — but only when more
// than one account is marked, since a single account is unambiguous and the tag would be noise.
// The tagged account mirrors resolveMainAccountId (explicit main, else first) so the agent's
// answer to "which account is connected?" matches the save. An id-less list renders untagged.
export function buildAccountLines(accounts, mainAccountId = null) {
    const valid  = Array.isArray(accounts) ? accounts.filter(a => a && a.id != null) : []
    const mainId = valid.length > 1 ? resolveMainAccountId(valid, mainAccountId) : null
    return accounts.map(a => {
        const type  = a.isLive ? 'LIVE' : 'DEMO'
        const parts = [`${(a.broker || '').toUpperCase()} ${type} — login: ${a.login || '—'}, currency: ${a.currency || '—'}`]
        if (a.balance != null) parts.push(`balance: ${formatMoney(a.balance)}`)
        if (a.equity  != null) parts.push(`equity: ${formatMoney(a.equity)}`)
        const line = `  - ${parts.join(', ')}`
        return (mainId != null && a.id != null && String(a.id) === mainId) ? `${line}  ← MAIN` : line
    })
}

// ─── Open positions + P&L (shared "live book" context) ────────────────────────
// The user's open positions as prompt text, shared by the Idea and Kairos agents so both see
// what Atlas sees: for every connected broker (paper / live / manual) a workspace line
// (mode + broker + account), each open position with P&L in $ AND %, and that book's total P&L
// in $ and %. `brokerContext` is brokerService.loadContext(userId) output — { [brokerType]:
// { account, positions } } — one entry per connected broker.

// Per-position P&L% off entry — mirrors computePortfolioState's per-idea formula (price move
// entry→current, sign-flipped for shorts). The raw BrokerPosition carries no pnlPct.
export function positionPnlPct(p) {
    const entry = Number(p?.entryPrice), cur = Number(p?.currentPrice)
    if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(cur)) return null
    return ((cur - entry) / entry) * 100 * (p.direction === 'short' ? -1 : 1)
}

// Signed $ (+$1,234 / -$56) and signed % (+1.2% / -0.3%) — the P&L convention Atlas's block uses.
const _signedMoney = (v) => (v == null || !Number.isFinite(Number(v))) ? '—'
    : `${Number(v) >= 0 ? '+' : '-'}$${Math.abs(Number(v)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const _signedPct = (v) => (v == null || !Number.isFinite(Number(v))) ? '—'
    : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`

export function buildPositionsSection(brokerContext) {
    if (!brokerContext || typeof brokerContext !== 'object') return ''
    const entries = Object.entries(brokerContext).filter(([, d]) => d?.account)
    if (!entries.length) return ''

    const blocks = entries.map(([type, { account, positions }]) => {
        const mode = _deriveMode(type, account.id ?? account.login ?? null)
        const brokerLabel = mode === 'live' ? (BROKER_LABELS[type] ?? type) : null
        const pos = Array.isArray(positions) ? positions : []

        // Human label + dedupe key for one account. Live shows the recognisable login/number
        // (fix #4 — never an internal id); paper/manual show the mode word + a short id suffix so
        // several accounts of the same mode stay distinct (loadContext gives one `account` per
        // broker, but getPositions spans every account of that mode — fix #1).
        const acctNumber = (a) => a?.accountNo ?? a?.login ?? a?.id ?? a?.accountId
        const acctKey    = (a) => String(acctNumber(a) ?? '')
        const acctLabel  = (a) => {
            if (mode === 'live') return `${brokerLabel} #${acctNumber(a) ?? '—'}`
            const word = mode === 'paper' ? 'Paper' : 'Manual'
            const id   = a?.id ?? a?.accountId ?? a?.accountNo ?? a?.login
            const suffix = id ? String(id).split('-').pop() : null
            return suffix ? `${word} #${suffix}` : word
        }

        // Distinct accounts = the header account + every account referenced by a position.
        const accts = new Map()
        const addAcct = (a) => { const k = acctKey(a); if (k && !accts.has(k)) accts.set(k, a) }
        addAcct(account)
        for (const p of pos) addAcct({ accountNo: p.accountNo, accountId: p.accountId })
        const multiAcct = accts.size > 1

        const wsLine = formatWorkspaceLine({
            mode,
            brokerLabel,
            accounts: [...accts.values()].map((a, i) => ({ id: i, label: acctLabel(a) })),
        })
        const bal = `Balance ${formatMoney(account.balance)} | Equity ${formatMoney(account.equity)} | Free margin ${formatMoney(account.freeMargin)}`

        if (!pos.length) return `${wsLine}\n${bal}\nNo open positions`

        let totalPnl = 0, costBasis = 0
        const posLines = pos.map(p => {
            totalPnl  += Number(p.pnl) || 0
            costBasis += (Number(p.entryPrice) || 0) * (Number(p.volume) || 0)
            const price = p.currentPrice != null ? ` → ${p.currentPrice}` : ''
            // Only tag the account when the book spans more than one — no noise on a single-account book.
            const acct  = multiAcct && (p.accountNo ?? p.accountId) != null ? ` [acct ${p.accountNo ?? p.accountId}]` : ''
            return `  - ${p.symbol} ${p.direction} ${p.volume ?? '?'} @ ${p.entryPrice ?? '?'}${price}  P&L ${_signedMoney(p.pnl)} (${_signedPct(positionPnlPct(p))})${acct}`
        })
        const totalPct = costBasis > 0 ? (totalPnl / costBasis) * 100 : null
        return `${wsLine}\n${bal}\nOpen positions:\n${posLines.join('\n')}\nTotal P&L: ${_signedMoney(totalPnl)} (${_signedPct(totalPct)})`
    })

    return `\n\nCURRENT POSITIONS & P&L — the user's live book (workspace + per-position and total P&L; prices current, don't re-fetch):\n${blocks.join('\n\n')}`
}

// Canonical trade-horizon vocabulary, shared across every agent (Idea/Kairos/Atlas holdings/
// Scanner). The fault line between intraday and day is OVERNIGHT: intraday is flat by the session
// close, day carries 1–few days. Kairos trades a subset (no long term), but all agents validate
// against this same list so a horizon round-trips between them (e.g. a Kairos↔Argus scan) unchanged.
export const TRADE_HORIZONS = ['intraday', 'day', 'swing', 'long term']

// ─── Emit-tag cleanup ─────────────────────────────────────────────────────────
// Strip the given emit blocks (<name>…</name>) from a raw model reply. Each name
// is removed globally, matching the per-agent hand-written `.replace(...)` chains.
export function stripEmitTags(raw, tagNames) {
    let text = raw ?? ''
    for (const name of tagNames) {
        text = text.replace(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, 'g'), '')
    }
    return text
}
