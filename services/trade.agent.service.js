import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { callAnthropicWithTools, streamAnthropicWithTools } from '../providers/anthropic.provider.js'
import { getQuote, getTickerAggregates } from '../providers/yahoofinance.provider.js'
import { logger } from './logger.service.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE_SYSTEM_PROMPT = readFileSync(join(__dirname, '../trade_assistant_system_prompt.md'), 'utf-8')

const LOG = '[tradeAgent]'
const MODEL = 'claude-sonnet-4-6'
const MAX_RECENT_MESSAGES = 6

const TOOLS = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
        name: 'get_quote',
        description: 'Get the current real-time price quote for a stock ticker. Call this when the user asks about current price, today\'s levels, or when you need live price data to answer accurately.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'Stock ticker symbol e.g. AAPL, NVDA' },
            },
            required: ['ticker'],
        },
    },
    {
        name: 'get_candles',
        description: 'Fetch recent OHLCV candles for a ticker. Use this whenever the user asks about orderblocks, support/resistance, chart patterns, price levels, or any question that requires seeing recent price action. Never say you cannot see live data — call this tool first.',
        input_schema: {
            type: 'object',
            properties: {
                ticker: {
                    type: 'string',
                    description: 'Stock ticker symbol e.g. AAPL, NVDA',
                },
                timeframe: {
                    type: 'string',
                    enum: ['1hr', '4hr', 'day', 'week'],
                    description: 'Candle timeframe. 4hr returns 1hr candles (Yahoo Finance limit) — group 4 consecutive 1hr rows as one 4hr period.',
                },
            },
            required: ['ticker', 'timeframe'],
        },
    },
]

// candle count and Yahoo interval per requested timeframe
const _CANDLE_CFG = {
    '1hr':  { timeSpan: 'hour', multiplier: 1, count: 30, windowDays: 5  },
    '4hr':  { timeSpan: 'hour', multiplier: 1, count: 60, windowDays: 12 },  // 1hr rows; LLM groups 4→1
    'day':  { timeSpan: 'day',  multiplier: 1, count: 40, windowDays: 60 },
    'week': { timeSpan: 'week', multiplier: 1, count: 24, windowDays: 200 },
}

function _fmtVol(v) {
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
    if (v >= 1_000)     return (v / 1_000).toFixed(0) + 'K'
    return String(v)
}

const TOOL_HANDLERS = {
    get_quote: async ({ ticker }) => {
        try {
            return await getQuote(ticker)
        } catch (err) {
            logger.warn(LOG, `get_quote failed for ${ticker}:`, err.message)
            return `Could not fetch quote for ${ticker}: ${err.message}`
        }
    },

    get_candles: async ({ ticker, timeframe }) => {
        try {
            const cfg  = _CANDLE_CFG[timeframe] ?? _CANDLE_CFG['day']
            const from = Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000
            const raw  = await getTickerAggregates(ticker.toUpperCase(), { timeSpan: cfg.timeSpan, multiplier: cfg.multiplier, from })
            const rows = raw.slice(-cfg.count)
            if (rows.length === 0) return `No candle data available for ${ticker}`

            const label = timeframe === '4hr' ? '1hr (group 4 rows = one 4hr candle)' : timeframe
            const header = `${ticker.toUpperCase()} ${label} — ${rows.length} candles, newest last:\n`
            const lines  = rows.map(c => {
                const d = new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
                return `${d}  O:${c.open.toFixed(2)}  H:${c.high.toFixed(2)}  L:${c.low.toFixed(2)}  C:${c.close.toFixed(2)}  V:${_fmtVol(c.volume)}`
            })
            return header + lines.join('\n')
        } catch (err) {
            logger.warn(LOG, `get_candles failed for ${ticker}:`, err.message)
            return `Could not fetch candles for ${ticker}: ${err.message}`
        }
    },
}

export const tradeAgentService = {
    chat,
    chatStream,
}

async function chat({ messages, userPrompt, analysisState = _emptyState(), brokerContext = null }) {
    const systemPrompt = _buildSystemPrompt(analysisState, brokerContext)
    const builtMessages = _buildMessages({ messages, userPrompt, analysisState })

    logger.info(LOG, 'chat start', {
        userPrompt,
        messageCount: builtMessages.length,
        activeAsset: analysisState?.structured_state?.active_asset ?? '',
    })

    const raw = await callAnthropicWithTools({
        model: MODEL,
        promptOrMessages: builtMessages,
        systemPrompt,
        tools: TOOLS,
        toolHandlers: TOOL_HANDLERS,
    })

    const { reply, updatedState, tradeIdea } = _parseResponse(raw, analysisState, userPrompt)

    logger.info(LOG, 'chat done', {
        replyLength: reply.length,
        hasTradeIdea: Boolean(tradeIdea),
        recentMessageCount: updatedState.recent_messages.length,
    })

    return { reply, analysisState: updatedState, ...(tradeIdea ? { tradeIdea } : {}) }
}

async function chatStream({ messages, userPrompt, analysisState = _emptyState(), brokerContext = null, ideaAccounts = [], onToken, onAsset }) {
    const systemPrompt   = _buildSystemPrompt(analysisState, brokerContext, ideaAccounts)
    const builtMessages  = _buildMessages({ messages, userPrompt, analysisState })

    logger.info(LOG, 'chatStream start', {
        userPrompt,
        messageCount:  builtMessages.length,
        activeAsset:   analysisState?.structured_state?.active_asset ?? '',
    })

    const raw = await streamAnthropicWithTools({
        model: MODEL,
        promptOrMessages: builtMessages,
        systemPrompt,
        tools: TOOLS,
        toolHandlers: TOOL_HANDLERS,
        onToken,
        onAsset,
    })

    const { reply, updatedState, tradeIdea } = _parseResponse(raw, analysisState, userPrompt)

    logger.info(LOG, 'chatStream done', {
        replyLength:       reply.length,
        hasTradeIdea:      Boolean(tradeIdea),
        recentMessageCount: updatedState.recent_messages.length,
    })

    return { reply, analysisState: updatedState, ...(tradeIdea ? { tradeIdea } : {}) }
}

function _buildSystemPrompt(analysisState, brokerContext, ideaAccounts = []) {
    const asset   = analysisState?.structured_state?.active_asset || 'none'
    const summary = analysisState?.recent_chat_summary || 'No prior context.'
    const pt      = analysisState?.structured_state?.pending_trade

    // Include the current pending_trade so the LLM updates from it rather than
    // re-deriving the entire state from scratch each turn.
    const stateSection = pt
        ? `\nCurrent pending trade (carry all set fields forward — only update what changed):\n${JSON.stringify(pt, null, 2)}`
        : ''

    return `${BASE_SYSTEM_PROMPT}

---
CONVERSATION CONTEXT:
${summary}
Active asset: ${asset}${stateSection}${_buildBrokerSection(brokerContext)}${_buildIdeaAccountsSection(ideaAccounts)}`
}

function _buildBrokerSection(brokerContext) {
    if (!brokerContext || typeof brokerContext !== 'object') return ''
    const entries = Object.entries(brokerContext).filter(([, d]) => d?.account)
    if (entries.length === 0) return ''

    const lines = entries.map(([type, { account, positions }]) => {
        const cur  = account.currency || ''
        const fmt  = (v) => v != null ? `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'
        const pct  = (v) => v != null ? `${Number(v).toFixed(0)}%` : '—'
        let line = `${type} (${cur}): Balance ${fmt(account.balance)} | Equity ${fmt(account.equity)} | Free margin ${fmt(account.freeMargin)} | Margin level ${pct(account.marginLevel)}`

        if (Array.isArray(positions) && positions.length > 0) {
            const pos = positions.map(p => {
                const pnl = p.pnl != null ? ` P&L: ${p.pnl >= 0 ? '+' : ''}${fmt(p.pnl)}` : ''
                return `  - ${p.symbol} ${p.direction} ${p.volume ?? '?'} @ ${p.entryPrice ?? '?'}${pnl}`
            }).join('\n')
            line += `\n  Open positions:\n${pos}`
        } else {
            line += '\n  No open positions'
        }
        return line
    })

    return `\n\nBROKER ACCOUNT:\n${lines.join('\n\n')}`
}

function _buildIdeaAccountsSection(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) return ''
    const fmt = (v) => v != null ? `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'
    const lines = accounts.map(a => {
        const type = a.isLive ? 'LIVE' : 'DEMO'
        const parts = [`${(a.broker || '').toUpperCase()} ${type} — login: ${a.login || '—'}, currency: ${a.currency || '—'}`]
        if (a.balance != null) parts.push(`balance: ${fmt(a.balance)}`)
        if (a.equity  != null) parts.push(`equity: ${fmt(a.equity)}`)
        return `  - ${parts.join(', ')}`
    })
    return `\n\nIDEA ACCOUNTS (the user plans to execute this trade on):\n${lines.join('\n')}`
}

function _buildMessages({ messages, userPrompt, analysisState }) {
    const prior = Array.isArray(analysisState?.recent_messages) ? analysisState.recent_messages : []

    if (Array.isArray(messages) && messages.length > 0) {
        const normalized = messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
            .map(({ role, content }) => ({ role, content: content.trim() }))
        // Caller owns the history — don't prepend prior to avoid duplicating messages
        // that are already present in the messages array.
        return _trimMessages(normalized)
    }

    const current = userPrompt?.trim()
        ? [{ role: 'user', content: userPrompt.trim() }]
        : []
    return _trimMessages([...prior, ...current])
}

function _parseResponse(raw, priorState, userPrompt) {
    let text = raw ?? ''
    let tradeIdea = null
    let updatedState = null


    text = text.replace(/<asset>[\s\S]*?<\/asset>/, '').trim()

    const tradeMatch = text.match(/<trade_idea>([\s\S]*?)<\/trade_idea>/)
    if (tradeMatch) {
        try {
            tradeIdea = JSON.parse(tradeMatch[1].trim())
            // Normalise timeframes in all condition tree nodes
            if (tradeIdea) {
                const entryTf = _firstLeafTf(tradeIdea.entry_condition) ?? null
                tradeIdea.entry_condition = _normalizeTreeNode(tradeIdea.entry_condition, entryTf)
                tradeIdea.stop_loss       = _normalizeTreeNode(tradeIdea.stop_loss,       entryTf)
                tradeIdea.take_profit     = _normalizeTreeNode(tradeIdea.take_profit,     entryTf)
            }
        } catch {
            logger.warn(LOG, 'trade_idea parse failed', { raw: tradeMatch[1] })
        }
        text = text.replace(/<trade_idea>[\s\S]*?<\/trade_idea>/, '').trim()
    }

    const stateMatch = text.match(/<state>([\s\S]*?)<\/state>/)
    if (stateMatch) {
        try {
            updatedState = JSON.parse(stateMatch[1].trim())
        } catch (err) {
            logger.warn(LOG, 'state parse failed', { raw: stateMatch[1], err: err.message })
        }
        text = text.replace(/<state>[\s\S]*?<\/state>/, '').trim()
    }

    if (!updatedState || !_isValidState(updatedState)) {
        updatedState = _fallbackState(priorState, userPrompt, text)
    } else {
        updatedState.recent_messages = _trimMessages(updatedState.recent_messages ?? [])
        const pt      = updatedState.structured_state.pending_trade
        const priorPt = priorState?.structured_state?.pending_trade

        logger.info(LOG, 'parsed pending_trade', JSON.stringify({
            entry_timeframe:  pt?.entry_timeframe,
            stop_timeframe:   pt?.stop_timeframe,
            tp_timeframe:     pt?.tp_timeframe,
            entry_cond_count: pt?.entry_conditions?.length,
            first_entry_tf:   pt?.entry_conditions?.[0]?.timeframe,
        }))

        // if the LLM omitted pending_trade entirely, keep the prior values
        if (!pt && priorPt) {
            updatedState.structured_state.pending_trade = priorPt
        } else if (pt) {
            // ── Migrate old flat 'timeframe' field → entry_timeframe ──────────────
            if (pt.timeframe && !pt.entry_timeframe) {
                pt.entry_timeframe = _normalizeTimeframe(pt.timeframe)
            }
            delete pt.timeframe   // always remove — never send old field back to LLM

            // Normalise group-level TF fields
            pt.entry_timeframe = _normalizeTimeframe(pt.entry_timeframe) || _normalizeTimeframe(priorPt?.entry_timeframe) || null
            pt.stop_timeframe  = _normalizeTimeframe(pt.stop_timeframe)  || null
            pt.tp_timeframe    = _normalizeTimeframe(pt.tp_timeframe)    || null

            // Normalise per-condition timeframe strings (LLM often writes "15m", "4 hours", etc.)
            pt.entry_conditions = _normalizeConditions(pt.entry_conditions)
            pt.stop_conditions  = _normalizeConditions(pt.stop_conditions)
            pt.tp_conditions    = _normalizeConditions(pt.tp_conditions)

            // Best available entry TF: condition-level → group-level → prior group-level → prior condition-level
            const entryTf = pt.entry_conditions[0]?.timeframe
                || pt.entry_timeframe
                || priorPt?.entry_timeframe
                || priorPt?.entry_conditions?.[0]?.timeframe
                || _normalizeTimeframe(priorPt?.timeframe)   // migrate prior old-format too
                || null

            // Backfill group-level TF if LLM omitted it
            if (!pt.entry_timeframe) pt.entry_timeframe = entryTf

            // Carry forward per-condition timeframes from prior state if LLM omitted them
            _fillMissingTimeframes(pt.entry_conditions, priorPt?.entry_conditions, entryTf)
            _fillMissingTimeframes(pt.stop_conditions,  priorPt?.stop_conditions,  pt.stop_timeframe  ?? entryTf)
            _fillMissingTimeframes(pt.tp_conditions,    priorPt?.tp_conditions,    pt.tp_timeframe    ?? entryTf)

            // Carry forward logic operators — default AND/OR if LLM omitted them
            pt.entry_logic = pt.entry_logic || priorPt?.entry_logic || 'AND'
            pt.stop_logic  = pt.stop_logic  || priorPt?.stop_logic  || 'OR'
            pt.tp_logic    = pt.tp_logic    || priorPt?.tp_logic    || 'OR'

            // Carry forward quantity
            if (pt.quantity == null && priorPt?.quantity != null) pt.quantity = priorPt.quantity
            if (pt.quantity != null) pt.quantity = Number(pt.quantity) || null

            // Normalise additional entries
            if (!Array.isArray(pt.additional_entries)) {
                pt.additional_entries = priorPt?.additional_entries ?? []
            } else {
                pt.additional_entries = pt.additional_entries.map(ae => ({
                    conditions: _normalizeConditions(ae.conditions),
                    logic:      ae.logic ?? 'AND',
                    quantity:   ae.quantity != null ? Number(ae.quantity) || null : null,
                }))
            }
        }
    }

    return { reply: text, updatedState, tradeIdea }
}

function _isValidState(state) {
    return (
        state &&
        typeof state === 'object' &&
        Array.isArray(state.recent_messages) &&
        typeof state.recent_chat_summary === 'string' &&
        state.structured_state &&
        typeof state.structured_state === 'object'
    )
}

function _fallbackState(priorState, userPrompt, replyText) {
    const prior = priorState && typeof priorState === 'object' ? priorState : _emptyState()
    const recent_messages = _trimMessages([
        ...(prior.recent_messages ?? []),
        ...(userPrompt?.trim() ? [{ role: 'user', content: userPrompt.trim() }] : []),
        ...(replyText?.trim() ? [{ role: 'assistant', content: replyText.trim() }] : []),
    ])
    return {
        recent_messages,
        recent_chat_summary: prior.recent_chat_summary ?? '',
        // preserve the full prior structured_state — never wipe trade params on fallback
        structured_state: prior.structured_state ?? _emptyState().structured_state,
    }
}

function _trimMessages(messages) {
    if (!Array.isArray(messages)) return []
    return messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content.trim() }))
        .slice(-MAX_RECENT_MESSAGES)
}

// ─── Timeframe normalisation ──────────────────────────────────────────────────

const _TF_REMAP = [
    // minute variants
    [/^(\d+)\s*[-\s]?m(?:in(?:utes?)?)?$/i, (_, n) => `${n}min`],
    // hour variants
    [/^(\d+)\s*[-\s]?h(?:r|rs|our|ours)?$/i, (_, n) => `${n}hr`],
    // named
    [/^daily$/i,   () => 'day'],
    [/^weekly$/i,  () => 'week'],
    [/^monthly$/i, () => 'month'],
]
const _VALID_TF = new Set(['1min','5min','15min','30min','1hr','2hr','4hr','day','week','month'])

function _normalizeTimeframe(tf) {
    if (!tf || typeof tf !== 'string') return null
    const s = tf.trim()
    if (_VALID_TF.has(s)) return s
    for (const [re, fn] of _TF_REMAP) {
        const m = s.match(re)
        if (m) return fn(...m)
    }
    return s  // keep as-is; better than losing it
}

function _normalizeConditions(arr) {
    if (!Array.isArray(arr)) return []
    return arr.map(c => {
        if (typeof c === 'string') return { condition: c, type: 'structured', timeframe: null }
        return { ...c, timeframe: _normalizeTimeframe(c.timeframe) }
    })
}

/**
 * Recursively normalise timeframe strings in a condition tree node.
 * Leaf nodes get their timeframe normalised; missing timeframes fall back to defaultTf.
 * Group nodes with old { logic, conditions } shape are migrated to { operator, children }.
 */
function _normalizeTreeNode(node, defaultTf) {
    if (!node || typeof node !== 'object') return node

    // Leaf node
    if (typeof node.condition === 'string') {
        const leaf = {
            ...node,
            timeframe: _normalizeTimeframe(node.timeframe) || defaultTf || null,
        }
        if (node.quantity != null) leaf.quantity = Number(node.quantity) || null
        return leaf
    }

    // Group node: { operator, children }
    if (node.operator && Array.isArray(node.children)) {
        return {
            operator: node.operator,
            children: node.children.map(child => _normalizeTreeNode(child, defaultTf)),
        }
    }

    // Old format migration: { logic, conditions }
    if (Array.isArray(node.conditions)) {
        return {
            operator: node.logic ?? 'AND',
            children: node.conditions.map(child => _normalizeTreeNode(child, defaultTf)),
        }
    }

    return node
}

/** Find the timeframe of the first leaf in a condition tree (for defaultTf propagation). */
function _firstLeafTf(node) {
    if (!node || typeof node !== 'object') return null
    if (typeof node.condition === 'string') return _normalizeTimeframe(node.timeframe) || null
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            const tf = _firstLeafTf(child)
            if (tf) return tf
        }
    }
    if (Array.isArray(node.conditions)) {
        for (const child of node.conditions) {
            const tf = _firstLeafTf(child)
            if (tf) return tf
        }
    }
    return null
}

/**
 * For each condition that is missing a timeframe, try to fill it from:
 * 1. The matching prior-state condition at the same index
 * 2. The defaultTf (entry TF) as the final fallback
 */
function _fillMissingTimeframes(conditions, priorConditions, defaultTf) {
    if (!Array.isArray(conditions)) return
    conditions.forEach((c, i) => {
        if (!c.timeframe) {
            c.timeframe = priorConditions?.[i]?.timeframe || defaultTf || null
        }
    })
}

function _emptyState() {
    return {
        recent_messages: [],
        recent_chat_summary: '',
        structured_state: {
            active_asset: '',
            pending_trade: {
                direction: null,
                type:      null,
                quantity:  null,
                entry_timeframe: null,  // set as soon as user mentions a TF, even before conditions
                stop_timeframe: null,   // null = inherit entry_timeframe
                tp_timeframe: null,     // null = inherit entry_timeframe
                entry_logic: 'AND',
                entry_conditions: [],       // [{ condition, type, timeframe }]
                stop_logic: 'OR',
                stop_conditions: [],        // [{ condition, type, timeframe }]
                tp_logic: 'OR',
                tp_conditions: [],          // [{ condition, type, timeframe }]
                additional_entries: [],     // [{ conditions, logic, quantity }]
                notes: null,
            },
        },
    }
}
