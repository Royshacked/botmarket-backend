import { readFileSync, statSync } from 'fs'
import { getShortInterest, getOptionsContext } from '../providers/yahoofinance.provider.js'
import { getDerivativesContext } from '../providers/binance.provider.js'
import { toolError } from './toolResult.util.js'
import { logger } from './logger.service.js'

const LOG = '[agentUtils]'

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
    get_short_interest: async ({ ticker }) => {
        try { return await getShortInterest(ticker) }
        catch (err) {
            logger.warn(LOG, `get_short_interest failed for ${ticker}:`, err.message)
            return toolError(`Could not fetch short interest for ${ticker}: ${err.message}`)
        }
    },
    get_options_context: async ({ ticker }) => {
        try { return await getOptionsContext(ticker) }
        catch (err) {
            logger.warn(LOG, `get_options_context failed for ${ticker}:`, err.message)
            return toolError(`Could not fetch options context for ${ticker}: ${err.message}`)
        }
    },
    get_derivatives_context: async ({ symbol }) => {
        try { return await getDerivativesContext(symbol) }
        catch (err) {
            logger.warn(LOG, `get_derivatives_context failed for ${symbol}:`, err.message)
            return toolError(`Could not fetch derivatives context for ${symbol}: ${err.message}`)
        }
    },
}

export function normalizeMessages(messages, maxCount) {
    if (!Array.isArray(messages)) return []
    return messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map(({ role, content }) => ({ role, content: content.trim() }))
        .slice(-maxCount)
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
