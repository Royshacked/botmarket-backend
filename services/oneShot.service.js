// ONE model call, no tools, to whichever provider a registry id lives on (2026-10-21).
//
// The one-shot reads that follow a CHOSEN model — the house pick, or a setting — each had to branch
// on the provider themselves: monitor.claude's vision read does, and the hotlist's news labels were
// about to be the second copy and Argus's board read the third. This is the branch, once:
// llmModels.modelRoute resolves the id (an unknown one falls to the default, so a bad setting never
// reaches a provider), then the Anthropic or the OpenAI-compatible one-shot runs it.
//
// monitor.claude still carries its own copy; it can move here when it is next touched.

import { modelRoute } from './llmModels.js'
import { callAnthropicOnce } from '../providers/anthropic.provider.js'
import { callOpenAICompatOnce } from '../providers/openaiCompat.provider.js'

/**
 * @param {{ model: string, systemText: string, userText: string, maxTokens?: number,
 *           onUsage?: (usage: object, model: string) => void }} p
 * @returns {Promise<string>} the reply's text
 */
export async function oneShotText({ model, systemText, userText, maxTokens = 1024, onUsage }) {
    const route = modelRoute(model)
    if (route.provider === 'openai-compat') {
        return callOpenAICompatOnce({ endpoint: route.endpoint, wire: route.wire, model: route.model, systemText, userText, maxTokens, onUsage })
    }
    return callAnthropicOnce({ model: route.model, systemPrompt: systemText, user: userText, maxTokens, onUsage })
}
