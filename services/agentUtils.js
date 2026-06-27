import { getShortInterest, getOptionsContext } from '../providers/yahoofinance.provider.js'
import { getDerivativesContext } from '../providers/binance.provider.js'
import { toolError } from './toolResult.util.js'
import { logger } from './logger.service.js'

const LOG = '[agentUtils]'

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
