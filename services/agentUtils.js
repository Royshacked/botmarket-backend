import { readFileSync, statSync } from 'fs'
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

export function buildAccountLines(accounts) {
    return accounts.map(a => {
        const type  = a.isLive ? 'LIVE' : 'DEMO'
        const parts = [`${(a.broker || '').toUpperCase()} ${type} — login: ${a.login || '—'}, currency: ${a.currency || '—'}`]
        if (a.balance != null) parts.push(`balance: ${formatMoney(a.balance)}`)
        if (a.equity  != null) parts.push(`equity: ${formatMoney(a.equity)}`)
        return `  - ${parts.join(', ')}`
    })
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
