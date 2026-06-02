/**
 * News condition evaluator.
 *
 * Uses the existing newsService (GNews + file cache) — no new news source.
 * Asks Claude (Haiku) YES/NO whether the condition is reflected in recent headlines.
 */

import { claudeText }   from '../monitor.claude.js'
import { newsService }  from '../../services/news.service.js'
import { logger }       from '../../services/logger.service.js'

const LOG = '[news.evaluator]'

const SYSTEM = `You are a financial news analyst.
Given a list of recent news headlines for an asset, decide whether a stated condition is met.
Base your answer only on the headlines provided.
If the headlines do not clearly confirm the condition, answer NO.
Respond with a single word only: YES or NO.`

/**
 * Evaluate a news/macro condition.
 *
 * @param {string} condition  e.g. "Fed announces rate cut"
 * @param {string} symbol     asset symbol  e.g. 'AAPL'
 * @returns {Promise<boolean>}
 */
export async function evaluateNews(condition, symbol) {
    let articles = []
    try {
        const result = await newsService.getOrFetch({
            category: 'companies',
            subject:  symbol,
            query:    symbol,
        })
        articles = result.articles ?? []
    } catch (err) {
        logger.warn(LOG, `News fetch failed for ${symbol}:`, err.message)
        return false
    }

    if (articles.length === 0) {
        logger.warn(LOG, `No articles found for ${symbol} — skipping news eval`)
        return false
    }

    const headlines     = articles.slice(0, 20).map(a => a.headline).filter(Boolean)
    const headlineBlock = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')

    const user =
        `Asset: ${symbol}\n\n` +
        `Recent news headlines:\n${headlineBlock}\n\n` +
        `Condition to check: "${condition}"\n\n` +
        `YES or NO?`

    try {
        const raw  = await claudeText(SYSTEM, user)
        const pass = raw.trim().toUpperCase().startsWith('Y')
        logger.info(LOG, `News eval "${condition.slice(0, 60)}" for ${symbol} → ${pass ? 'YES' : 'NO'}`)
        return pass
    } catch (err) {
        logger.error(LOG, 'News eval error:', err.message)
        return false
    }
}
