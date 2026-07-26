import Anthropic from '@anthropic-ai/sdk'

const HAIKU  = 'claude-haiku-4-5-20251001'
const SONNET = 'claude-sonnet-4-6'
const OPUS   = 'claude-opus-5'

export const ROUTING_MODES = {
    MANUAL:     'manual',
    AUTO:       'auto',
    CLASSIFIER: 'classifier',
}

// Canonical reasoning-effort values. Providers treat 'off' (and undefined) as
// no-thinking; 'off' is the canonical no-reasoning value across all routing paths.
export const REASONING_EFFORT = { OFF: 'off', LOW: 'low', HIGH: 'high' }

const DEFAULT_ROUTE = { model: SONNET, reasoningEffort: REASONING_EFFORT.OFF }

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
    kairos: {
        1: { model: HAIKU,  reasoningEffort: 'off' },  // locate & classify — thesis + horizon
        2: { model: SONNET, reasoningEffort: 'low' },  // market regime & correlations
        3: { model: SONNET, reasoningEffort: 'low' },  // fundamentals — horizon-gated + event/float
        4: { model: SONNET, reasoningEffort: 'low' },  // technicals & triggers — the core price read
        5: { model: SONNET, reasoningEffort: 'low' },  // zones — volatility-sized, scenario-placed
        6: { model: SONNET, reasoningEffort: 'low' },  // risk — invalidation + targets + R:R
        7: { model: SONNET, reasoningEffort: 'off' },  // validate + size/account + emit call
    },
    // Axl is a single-mode agent (no phases) — intentionally empty so it resolves to
    // DEFAULT_ROUTE. Present here so the omission reads as deliberate, not a missing table.
    axl: {},
}

const _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const _CLASSIFIER_SYSTEM = `You are a routing classifier for a trading AI assistant. Output ONLY valid JSON — no prose, no markdown.

Agents: idea (trade idea builder, phases 1-5), portfolio (portfolio manager, phases 1-6), scanner (market scanner, phases 1-4), kairos (discretionary day/swing call builder, phases 1-7)

Model options:
- "haiku": greeting, simple data lookup, single-field update, no synthesis
- "sonnet": analysis, synthesis, multi-tool coordination, judgment, generation
- "opus": the hardest calls only — full thesis construction, portfolio sizing and allocation, contradictory evidence to weigh, risk decisions with real money on the line

Reasoning options:
- "off": clear task, no ambiguity
- "low": chart analysis, ambiguous conditions, complex nesting, multi-factor judgment, final JSON generation
- "high": sizing, risk/reward trade-offs, conflicting signals — anything where being wrong costs money

Opus is expensive: pick it only when sonnet would plausibly get the call wrong, not merely when the task is long.

Output format: {"model":"haiku"|"sonnet"|"opus","reasoning":"off"|"low"|"high"}`

/**
 * Resolve model and reasoningEffort for the current turn.
 * @param {object} opts
 * @param {'manual'|'auto'|'classifier'} opts.routingMode
 * @param {'idea'|'portfolio'|'scanner'|'kairos'|'axl'} opts.agent
 * @param {number|null} opts.phase  - phase from the previous turn's response
 * @param {string} [opts.model]     - manual mode: explicit model id
 * @param {string} [opts.reasoningEffort] - manual mode: explicit effort
 * @param {string} [opts.lastMessage]     - classifier mode: last user message text
 */
export async function resolveModel(opts) {
    return _floorEffort(await _resolveRoute(opts ?? {}))
}

async function _resolveRoute({ routingMode, agent, phase, model, reasoningEffort, lastMessage }) {
    if (routingMode === ROUTING_MODES.MANUAL) {
        return { model: model ?? SONNET, reasoningEffort: reasoningEffort ?? REASONING_EFFORT.OFF }
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

    const text = response.content[0]?.text ?? ''
    return _normalizeClassification(JSON.parse(text))
}

const _MODEL_MAP  = { haiku: HAIKU, sonnet: SONNET, opus: OPUS }
const _EFFORT_MAP = {
    off:  REASONING_EFFORT.OFF,
    low:  REASONING_EFFORT.LOW,
    high: REASONING_EFFORT.HIGH,
}

/**
 * Map the classifier's JSON onto a real route. Anything unrecognised — a
 * hallucinated model name, a missing field, a whole missing object — lands on
 * the conservative default rather than reaching a provider. Pure; exported for
 * testing.
 */
export function _normalizeClassification(parsed) {
    return {
        model:           _MODEL_MAP[parsed?.model]       ?? SONNET,
        reasoningEffort: _EFFORT_MAP[parsed?.reasoning]  ?? REASONING_EFFORT.OFF,
    }
}

// Opus 5 reasons by default: unlike Sonnet 4.6 / Opus 4.8, sending no thinking
// block does NOT buy zero reasoning tokens — the model thinks anyway, and those
// tokens count against max_tokens. Explicitly disabling thinking is worse than
// leaving it on: with thinking off, Opus 5 sometimes writes a tool call as plain
// text instead of a tool_use block, so the call silently never runs — fatal in
// agents that are entirely tool-driven. So we floor the effort instead of
// turning thinking off, here rather than in the provider, so the route we report
// and persist matches what actually runs.
const _MIN_EFFORT = { [OPUS]: REASONING_EFFORT.LOW }

function _floorEffort(route) {
    const min = _MIN_EFFORT[route.model]
    if (!min || route.reasoningEffort !== REASONING_EFFORT.OFF) return route
    return { ...route, reasoningEffort: min }
}
