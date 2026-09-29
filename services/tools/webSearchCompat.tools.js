import { fetchGNews } from '../../providers/gnews.provider.js'
import { logger } from '../logger.service.js'

/**
 * `web_search` FOR A NON-ANTHROPIC MODEL.
 *
 * On Anthropic, web_search is a SERVER tool: the vendor runs it and the model just uses it. There
 * is no OpenAI-shaped twin, so the compat translation dropped it and the request carried
 * OpenRouter's `web` plugin instead — which augments the prompt automatically and is not something
 * the model can CALL. The result, seen live on Luna: every desk prompt names `web_search` in its
 * tool ladder, the model looks for it, and reports it unavailable.
 *
 * So it becomes a real function tool here, backed by the search this app already has a key for.
 * GNews is news rather than the whole web, which is narrower than Anthropic's — and it is the
 * narrower thing the desks actually ask for: Mentor's own line for this tool is "news, catalysts,
 * macro tone", Prometheus wants what was written since an event, and a dated, attributed,
 * per-query answer is worth more to both than a bag of page text folded silently into the prompt.
 *
 * SAY WHAT IT IS. The description tells the model this searches news, so it does not go looking
 * for documentation or a company's own site and then report the tool as broken.
 */
export const WEB_SEARCH_COMPAT = {
    name: 'web_search',
    description: 'Search recent NEWS — dated, attributed articles with the publisher\'s own summary. Use it for catalysts, the story behind a move, and macro tone. It searches news rather than the whole web, so it will not find documentation, filings or a company\'s own pages: for filings use get_sec_filings, and for one ticker\'s headlines prefer get_news, which is cached. Give it the words you would type into a news site.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'What to search for, in plain words.' },
            from:  { type: 'string', description: 'Optional ISO-8601 UTC lower bound — articles published on or after it. Use it to ask "what was written SINCE the event".' },
        },
        required: ['query'],
    },
}

const MAX_RESULTS = 6

/**
 * The handler. Failures come back as text the model can act on rather than as a throw: a search
 * that did not happen is a fact about this turn, and the desks' prompts already know what to do
 * with "I could not check" — inventing a reason it did not need to is worse than saying so.
 */
export function makeWebSearchCompatHandler(log = '[webSearch]') {
    return async ({ query, from } = {}) => {
        const q = String(query ?? '').trim()
        if (!q) return 'web_search needs a query.'
        try {
            const articles = await fetchGNews({ query: q, ...(from ? { from } : {}), max: MAX_RESULTS })
            const rows = Array.isArray(articles) ? articles : (articles?.articles ?? [])
            if (!rows.length) return `No news found for "${q}"${from ? ` since ${from}` : ''}. That is an absence of coverage, not evidence that nothing happened.`
            return [`News for "${q}"${from ? ` since ${from}` : ''} — ${rows.length} result(s), newest first:`]
                .concat(rows.map((a) => {
                    const when = a.publishedAt ?? a.published_at ?? ''
                    const who  = a.source?.name ?? a.source ?? 'unknown'
                    return `- ${when ? `${String(when).slice(0, 10)} ` : ''}[${who}] ${a.title ?? '(untitled)'}${a.description ? ` — ${a.description}` : ''}`
                }))
                .join('\n')
        } catch (err) {
            logger.warn(log, `web_search failed for "${q}": ${err.message}`)
            return `Could not search news for "${q}": ${err.message}. Say you have not checked rather than answering from memory.`
        }
    }
}
