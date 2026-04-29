import { callOpenAI } from '../providers/openai.provider.js'

export const llmService = {
    filterRelevantNews,
}


async function filterRelevantNews(articles) {
    const model = 'gpt-4o-mini'
    const prompt = `Return JSON only. Filter these articles for market relevance:
    ${articles.map(article => `- ${JSON.stringify(article.summary)}`).join('\n')}
    `
    const response = await callOpenAI(model, prompt)

    console.log(response)
    return JSON.parse(response.output_text || '[]')
}

