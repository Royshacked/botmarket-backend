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
export function resolveAgentStream(requestedModel, userId, agent) {
    const { model, streamFn, provider } = resolveStreamFn(requestedModel)
    const onUsage = userId ? (usage) => recordUsage(userId, model, usage, agent).catch(() => {}) : undefined
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

// How far the history is allowed to grow past `maxCount` before it is trimmed back to it. The
// history is trimmed on a HIGH-WATER MARK, not on every turn — see trimHistory.
const HISTORY_CEILING_FACTOR = 3

/**
 * Trim a coalesced history to `keep` turns, but only once it has grown past keep × 3.
 *
 * A sliding window (`slice(-keep)` every turn) drops the oldest turn on EVERY turn, and that is
 * expensive twice over. The model loses the start of the conversation permanently — the constraint
 * the user set ten turns ago is simply gone, so the desk re-asks and re-suggests things already
 * settled. And prompt caching is a PREFIX match: shifting the first message by one turn changes the
 * first byte, so the cached history is thrown away and re-read at full price, every turn, forever.
 *
 * Trimming on a high-water mark fixes both. Between trims the prefix is byte-stable, so the cache
 * reads; the history runs 1–3× longer before anything is dropped; and the cost is one cache miss per
 * trim instead of one per turn.
 *
 * Guarantees the result still opens on a `user` turn: the API rejects a history that starts with an
 * assistant message, and slicing a strictly-alternating list to an even count lands on an assistant
 * whenever the total is odd — which it is on exactly the turns the user is speaking.
 */
export function trimHistory(merged, keep) {
    if (!(keep > 0) || merged.length <= keep * HISTORY_CEILING_FACTOR) return merged
    const cut = merged.slice(-keep)
    return cut[0]?.role === 'assistant' ? cut.slice(1) : cut
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
    return trimHistory(merged, maxCount)
}

// ─── Per-turn context placement ───────────────────────────────────────────────
/**
 * Attach this turn's VOLATILE context to the end of the conversation instead of to the system
 * prompt. Returns a NEW array (the input is never mutated); a falsy `text`, or no message to
 * attach to, returns the input untouched.
 *
 * WHY IT MOVES AT ALL. Caching is a prefix match over `tools → system → messages`, so a block that
 * changes every turn invalidates everything AFTER it. Sitting in `system`, a volatile tail is ahead
 * of the entire conversation: the tools and the base prompt still cache (their breakpoints come
 * first), but the history breakpoint the provider stamps on the last message can never hit, and the
 * whole conversation is re-read at full price on every turn — for the life of the session. That is
 * the shape of the uncached ~24% of prompt tokens measured across Aug 2026.
 *
 * WHY THE END OF THE CONVERSATION IS THE RIGHT PLACE, and not just a later one. Text written into a
 * MESSAGE is frozen the moment it is written: on the next turn it is ordinary history, byte for
 * byte, so it caches. Text written into `system` is regenerated every turn and cannot. Moving it
 * converts a permanent cache miss into a one-turn one.
 *
 * The caller is responsible for sending only genuinely per-turn material through here — a draft
 * being built, a rolling summary, the clock. Session-stable context (the mode, the mandate, the
 * account list) belongs in `system`, where it is written once and read from cache thereafter.
 */
export function attachTurnContext(messages, text) {
    const body = typeof text === 'string' ? text.trim() : ''
    if (!body || !Array.isArray(messages) || !messages.length) return messages ?? []

    const last = messages[messages.length - 1]
    // Only ever onto a USER turn. Appending to an assistant message would put words in the model's
    // own mouth — it would read its previous reply as having stated this context itself.
    if (!last || last.role !== 'user') return messages

    const content = typeof last.content === 'string'
        ? `${last.content}\n\n${body}`
        : [...(Array.isArray(last.content) ? last.content : []), { type: 'text', text: body }]

    return [...messages.slice(0, -1), { ...last, content }]
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
        // DEPLOYABLE cash, and the number to size against — balance counts capital already sitting in
        // open positions, so an agent sizing a new book against it allocates money that isn't there.
        // Every adapter reports it (it is on the broker interface); it was simply never rendered, so
        // no agent could see it. Absent → the broker didn't report it, and balance is the fallback.
        if (a.freeMargin != null) parts.push(`available to deploy: ${formatMoney(a.freeMargin)}`)
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
 * WHO you are talking to, as a system-prompt block — see api/experience/experience.model.js.
 *
 * This is a VOICE parameter and the block says so in the strongest terms available, because it is
 * the one way this feature could do real harm. Every desk in this app is written practitioner-to-
 * practitioner; a beginner needs different WORDS, not a different trade. If a desk ever reads this
 * as licence to widen a stop, shrink a size or soften a risk number "because they're new", it has
 * stopped adapting its voice and started adapting its judgment — and the user is now getting a
 * worse trade for being honest about their experience.
 *
 * Returns null when there is no view, so an un-inferred user's prompt is byte-identical to today's.
 *
 * @returns {string|null}
 */
export function buildAudienceSection(level) {
    if (level === 'beginner') {
        return [
            'WHO YOU ARE TALKING TO: someone new to trading.',
            'Say the same things in plainer words. Define a term the first time you use it, in half a sentence, and move on. Prefer proposing to interrogating — offer a level and explain what it does rather than asking them to supply one they have no way to choose. Skip the shorthand: no bare R, R:R, FVG, BOS/CHoCH, "invalidation", "the structure broke" without saying what it means.',
            'This changes your WORDS ONLY. The analysis, the levels, the size, the risk and your verdict are exactly what they would have been for anyone else. Never soften a number, never widen a stop, never talk someone out of a real risk because they are new — tell them plainly what it is instead. Being new is a reason to explain more, never a reason to decide differently.',
            'Do not lecture. If they want to act, help them act and explain alongside, not in front.',
        ].join('\n')
    }
    if (level === 'experienced') {
        return 'WHO YOU ARE TALKING TO: an experienced trader who has asked to be spoken to normally. Use the standard vocabulary without glossing it, and keep it tight.'
    }
    return null
}

// ─── Language ─────────────────────────────────────────────────────────────────
// English by DEFAULT, switched only by an explicit request. One rule, appended to
// every agent's base system prompt — a voice rule in the same family as
// buildAudienceSection above, and single-sourced for the same reason: eight copies
// of a sentence about tone is eight chances for one of them to drift.
//
// WHY A FIXED DEFAULT rather than "the language of the conversation". These agents
// also write when nobody is in the room — a headless re-model, a scheduled monitor
// card, a notification. Those runs have NO conversation to read a language off, so a
// rule phrased that way has nothing to bind to and the model picks. (ZTS,
// 2026-08-05: a headless coverage refresh rewrote an English thesis in Portuguese.
// Nothing was wrong with the research; the doc just changed language with nobody
// asking.) A default cannot be absent, so it cannot be guessed.
//
// This is appended to the BASE prompt only, never to a mode/profile fragment — those
// are concatenated onto the base and would repeat it.
export const LANGUAGE_RULE = `

LANGUAGE: Write in English. That covers your replies AND any prose you emit into something that gets saved — a thesis, a rationale, kill-criteria, card copy, a note.

Switch only when the user EXPLICITLY asks you to use another language. The request counts no matter which language it is written in — "answer me in Hebrew" and "תענה לי בעברית" are both requests. But a user simply WRITING to you in another language is not one: keep answering in English until they actually ask. Once they have asked, stay in that language for the rest of the conversation.

Vocabulary fields are canonical English ALWAYS, in every language — rating, status, side, horizon, band_basis and the like are validated enum values, not prose.`

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
