import { readFileSync }   from 'fs'
import { fileURLToPath }  from 'url'
import { dirname, join }  from 'path'
import { streamAnthropicWithTools } from '../providers/anthropic.provider.js'
import { getQuote }       from '../providers/yahoofinance.provider.js'
import { logger }         from './logger.service.js'

const __dirname    = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, '../trade_portfolio_system_prompt.md'), 'utf-8')

const LOG   = '[portfolioAgent]'
const MODEL = 'claude-sonnet-4-6'
const MAX_MESSAGES = 20

const TOOLS = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
        name: 'get_quote',
        description: 'Get current price quote for a ticker symbol.',
        input_schema: {
            type: 'object',
            properties: { ticker: { type: 'string', description: 'e.g. AAPL, NVDA, SPY' } },
            required: ['ticker'],
        },
    },
]

const TOOL_HANDLERS = {
    get_quote: async ({ ticker }) => {
        try { return await getQuote(ticker) }
        catch (err) { return `Could not fetch quote for ${ticker}: ${err.message}` }
    },
}

export const portfolioAgentService = { chatStream }

async function chatStream({ messages = [], ideaAccounts = [], onToken, onTicker }) {
    const normalized   = _buildMessages(messages)
    const systemPrompt = ideaAccounts.length > 0
        ? `${SYSTEM_PROMPT}\n\n${_buildAccountsSection(ideaAccounts)}`
        : SYSTEM_PROMPT

    logger.info(LOG, 'chatStream start', { messageCount: normalized.length, accountCount: ideaAccounts.length })

    const raw = await streamAnthropicWithTools({
        model:            MODEL,
        promptOrMessages: normalized,
        systemPrompt,
        tools:            TOOLS,
        toolHandlers:     TOOL_HANDLERS,
        onToken,
        onTicker,
    })

    // Strip any residual <ticker> tags from text (suppressor should have caught them)
    const reply = raw.replace(/<ticker>[\s\S]*?<\/ticker>/g, '').trim()

    logger.info(LOG, 'chatStream done', { replyLength: reply.length })
    return { reply }
}

function _buildMessages(messages) {
    return messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
        .map(({ role, content }) => ({ role, content: content.trim() }))
        .slice(-MAX_MESSAGES)
}

function _buildAccountsSection(accounts) {
    const fmt = (v) => v != null ? `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'
    const lines = accounts.map(a => {
        const type  = a.isLive ? 'LIVE' : 'DEMO'
        const parts = [`${(a.broker || '').toUpperCase()} ${type} — login: ${a.login || '—'}, currency: ${a.currency || '—'}`]
        if (a.balance != null) parts.push(`balance: ${fmt(a.balance)}`)
        if (a.equity  != null) parts.push(`equity: ${fmt(a.equity)}`)
        return `  - ${parts.join(', ')}`
    })
    return `PORTFOLIO ACCOUNTS (the user plans to execute ideas from this portfolio on):\n${lines.join('\n')}\n\nWhen suggesting position sizes, use these account balances to recommend concrete allocations. If a main account is identified by a larger balance or context, use it as the reference for scaling other accounts.`
}
