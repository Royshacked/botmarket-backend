import Anthropic from '@anthropic-ai/sdk'

const HAIKU  = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-4-6'

export const ROUTING_MODES = {
    MANUAL:     'manual',
    AUTO:       'auto',
    CLASSIFIER: 'classifier',
}

const DEFAULT_ROUTE = { model: SONNET, reasoningEffort: 'off' }

// Conservative phase-to-model tables. Haiku for pure extraction turns,
// Sonnet for everything else. Reasoning only where output ambiguity is real.
const PHASE_TABLES = {
    idea: {
        1: { model: HAIKU,  reasoningEffort: 'off' },  // nucleus — no tools, just extraction
        2: { model: SONNET, reasoningEffort: 'off' },  // formation — data + news
        3: { model: SONNET, reasoningEffort: 'low'  },  // structure — chart + entry conditions
        4: { model: SONNET, reasoningEffort: 'off' },  // exits — stop/TP
        5: { model: SONNET, reasoningEffort: 'off' },  // validation — positioning overlay
    },
    portfolio: {
        1: { model: HAIKU,  reasoningEffort: 'off' },  // mandate — extraction
        2: { model: SONNET, reasoningEffort: 'off' },  // macro regime
        3: { model: SONNET, reasoningEffort: 'off' },  // architecture
        4: { model: SONNET, reasoningEffort: 'off' },  // instrument selection
        5: { model: SONNET, reasoningEffort: 'off' },  // sizing
        6: { model: SONNET, reasoningEffort: 'off' },  // review
    },
    scanner: {
        1: { model: HAIKU,  reasoningEffort: 'off' },  // thesis extraction
        2: { model: SONNET, reasoningEffort: 'off' },  // discovery
        3: { model: SONNET, reasoningEffort: 'off' },  // validation
        4: { model: SONNET, reasoningEffort: 'off' },  // final list
    },
}

const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const _CLASSIFIER_SYSTEM = `You are a routing classifier for a trading AI assistant. Output ONLY valid JSON — no prose, no markdown.

Agents: idea (trade idea builder, phases 1-5), portfolio (portfolio manager, phases 1-6), scanner (market scanner, phases 1-4)

Model options:
- "haiku": greeting, simple data lookup, single-field update, no synthesis
- "sonnet": analysis, synthesis, multi-tool coordination, judgment, generation

Reasoning options:
- "off": clear task, no ambiguity
- "low": chart analysis, ambiguous conditions, complex nesting, multi-factor judgment, final JSON generation

Output format: {"model":"haiku"|"sonnet","reasoning":"off"|"low"}`

/**
 * Resolve model and reasoningEffort for the current turn.
 * @param {object} opts
 * @param {'manual'|'auto'|'classifier'} opts.routingMode
 * @param {'idea'|'portfolio'|'scanner'} opts.agent
 * @param {number|null} opts.phase  - phase from the previous turn's response
 * @param {string} [opts.model]     - manual mode: explicit model id
 * @param {string} [opts.reasoningEffort] - manual mode: explicit effort
 * @param {string} [opts.lastMessage]     - classifier mode: last user message text
 */
export async function resolveModel({ routingMode, agent, phase, model, reasoningEffort, lastMessage }) {
    if (routingMode === ROUTING_MODES.MANUAL) {
        return { model: model ?? SONNET, reasoningEffort: reasoningEffort ?? 'none' }
    }

    if (routingMode === ROUTING_MODES.AUTO) {
        const table = PHASE_TABLES[agent] ?? {}
        return table[phase] ?? DEFAULT_ROUTE
    }

    if (routingMode === ROUTING_MODES.CLASSIFIER) {
        try {
            return await _classify(agent, phase, lastMessage)
        } catch {
            // classifier failed — fall back to phase-based
            const table = PHASE_TABLES[agent] ?? {}
            return table[phase] ?? DEFAULT_ROUTE
        }
    }

    return DEFAULT_ROUTE
}

async function _classify(agent, phase, lastMessage) {
    const response = await _client.messages.create({
        model:      HAIKU,
        max_tokens: 32,
        system:     _CLASSIFIER_SYSTEM,
        messages:   [{ role: 'user', content: `Agent: ${agent}\nPhase: ${phase ?? 'unknown'}\nMessage: ${String(lastMessage ?? '').slice(0, 400)}` }],
    })

    const text   = response.content[0]?.text ?? ''
    const parsed = JSON.parse(text)
    const modelMap = { haiku: HAIKU, sonnet: SONNET }

    return {
        model:          modelMap[parsed.model]   ?? SONNET,
        reasoningEffort: parsed.reasoning === 'low' ? 'low' : 'off',
    }
}
