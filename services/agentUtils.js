import { readFileSync, statSync } from 'fs'
import { TRADE_HORIZONS as VOCAB_TRADE_HORIZONS } from './entity/vocabulary.js'
import { getShortInterest, getOptionsContext } from '../providers/yahoofinance.provider.js'
import { getDerivativesContext } from '../providers/binance.provider.js'
import { toolError } from './toolResult.util.js'
import { logger } from './logger.service.js'
import { resolveStreamFn } from './llmModels.js'
import { recordUsage } from './tokenUsage.service.js'

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

// ─── Per-position P&L% ─────────────────────────────────────────────────────────────
// Mirrors computePortfolioState's per-idea formula (price move entry→current, sign-flipped for
// shorts). The raw BrokerPosition carries no pnlPct, so every surface that shows one derives it
// here — today that is tradingContext.service, which serves it to the agents through
// get_trading_context.
export function positionPnlPct(p) {
    const entry = Number(p?.entryPrice), cur = Number(p?.currentPrice)
    if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(cur)) return null
    return ((cur - entry) / entry) * 100 * (p.direction === 'short' ? -1 : 1)
}

// Canonical trade-horizon vocabulary, shared across every agent (Idea/Kairos/Atlas holdings/
// Scanner). The fault line between intraday and day is OVERNIGHT: intraday is flat by the session
// close, day carries 1–few days. Kairos trades a subset (no long term), but all agents validate
// against this same list so a horizon round-trips between them (e.g. a Kairos↔Argus scan) unchanged.
// Moved to services/entity/vocabulary.js — one home for the words entities and agents share.
// Re-exported here (imported into a local const, since a bare re-export creates no local binding)
// so the agents that already import it from agentUtils resolve unchanged.
export const TRADE_HORIZONS = VOCAB_TRADE_HORIZONS

// ─── User-local time context ──────────────────────────────────────────────────
// Shared by every agent that authors an absolute UTC instant from something the user said in
// their own clock ("enter at 16:40", "good through Friday"). Idea and Mentor had byte-identical
// copies of this pair; a divergence here silently mis-times a trade by hours.

/**
 * Format the browser instant in its IANA zone as
 * "Mon, 07/13/2026, 19:24 Asia/Jerusalem (GMT+03:00)".
 * Returns null when the zone is absent or invalid (a bad IANA string throws inside Intl).
 */
export function formatClientTime(clientTime) {
    const tz  = typeof clientTime?.clientTz === 'string' ? clientTime.clientTz.trim() : ''
    const now = Number.isFinite(clientTime?.clientNow) ? clientTime.clientNow : Date.now()
    if (!tz) return null
    try {
        const d     = new Date(now)
        const local = d.toLocaleString('en-US', {
            timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
            day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        })
        const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
            .formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? ''
        return `${local} ${tz}${offset ? ` (${offset})` : ''}`
    } catch {
        return null   // invalid IANA timezone
    }
}

/**
 * The timezone guidance block for a system prompt. With a known zone it tells the agent to read
 * bare clock times in the USER's zone and store the result as absolute UTC; with an unknown zone
 * it tells the agent to ASK rather than guess — a silent guess is how a scheduled entry ends up
 * firing on the wrong side of the world. `what` names the fields being authored.
 */
export function buildTimeSection(clientTime, what = 'a time condition') {
    const local = formatClientTime(clientTime)
    return local
        ? `USER LOCAL TIME: ${local}. Interpret any clock time or date the user gives WITHOUT an explicit timezone in THIS timezone, and resolve relative dates (today, tomorrow, next week) against the user's local date. For ${what}, always store the bounds as absolute UTC (ISO-8601 …Z).`
        : `USER LOCAL TIMEZONE: unknown. If the user gives a clock time or date for ${what}, ask which timezone (or confirm UTC) before converting — never guess — then store the bounds as absolute UTC (ISO-8601 …Z).`
}

/**
 * The user's stated goal, as a system-prompt block — what Axl took down at intake, rendered for
 * whichever desk they landed at. See api/objectives/objective.model.js for the record itself.
 *
 * Two things this block is careful about:
 *
 *   - It says the goal is ESTABLISHED, so the desk stops re-asking. That is the whole point of
 *     persisting it: the user states the job once. Same discipline as the mandate block Atlas has
 *     always had (portfolio.agent.service.js _buildMandateSection).
 *
 *   - When risk is MISSING it says so out loud rather than staying quiet. A silent gap reads as
 *     "no constraint" and the desk sizes against nothing; naming it puts the question exactly where
 *     sizing happens. Never render a risk figure derived from the target — see the model's rule 1.
 *
 * Context, not instruction: the goal is what the user is working toward, not an order to act now.
 *
 * @returns {string|null} null when there is no objective, so callers can push conditionally
 */
export function buildObjectiveSection(objective) {
    if (!objective) return null

    const { target = {}, horizon = {}, risk = {}, scope, symbol } = objective
    const lines = ["THE USER'S STATED GOAL (already established — do not re-ask for any field listed here):"]

    const targetText = [
        target.pct != null ? `${target.pct}%` : null,
        target.amount != null ? `${target.amount}${target.currency ? ` ${target.currency}` : ''}` : null,
    ].filter(Boolean).join(' / ')
    if (targetText) lines.push(`Target return: ${targetText}`)

    if (horizon.days != null) {
        lines.push(`Horizon: ${horizon.days} day${horizon.days === 1 ? '' : 's'}${horizon.until ? ` — by ${horizon.until}` : ''}`)
    }

    const riskText = [
        risk.maxDrawdownPct != null ? `${risk.maxDrawdownPct}% of the account` : null,
        risk.amount != null ? `${risk.amount}` : null,
    ].filter(Boolean).join(' / ')
    lines.push(riskText
        ? `Most they are willing to lose: ${riskText}`
        : 'Risk tolerance: NOT STATED — ask for it before you size anything, and never infer it from the target.')

    if (scope) lines.push(`Shape: ${scope === 'single' ? 'one position' : 'spread across several positions'}`)
    if (symbol) lines.push(`Name they came for: ${symbol}`)

    lines.push('This is the job they came here with, not an instruction to act now. Use it; do not re-ask for it.')
    return lines.join('\n')
}

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
