// Aether desk tools — channel-graph engine reads.
//
// UNBOUND: channel state, regime and forecasts are house-layer broadcasts written by the Python
// compute repo and shared across all users (same pattern as sectorView). No userId.
//
// Stubs return a structured "not yet computed" message when the engine collections are empty;
// Aether reasons qualitatively (LLM knowledge) in that state and says so plainly.

import { makeToolHandler }   from '../agentUtils.js'
import { getChannelState, getCurrentRegime, getExposure } from '../../api/aether/aether.service.js'

const LOG = '[aetherTools]'

// ── Channel taxonomy (hardcoded — Phase 0, always available) ─────────────────
// The static channel table from docs/design/channel-graph-build-spec.md.
// Never changes between engine runs: it IS the state space definition.

const CHANNEL_TAXONOMY = `
CHANNEL TAXONOMY — 15-25 measurable pressure channels

| Channel              | Proxy series                                  | Clock  |
|----------------------|-----------------------------------------------|--------|
| energy_cost          | crude, TTF, regional power                    | fast   |
| freight_logistics    | container rates, Baltic Dry, port dwell       | medium |
| policy_rate          | OIS strip, front-end forwards                 | fast   |
| discount_rate        | real yields, term premium                     | fast   |
| credit_capital       | HY & IG spreads, issuance volume              | medium |
| fx                   | trade-weighted baskets                        | fast   |
| risk_premium         | vol surface, skew, cross-asset corr           | fast   |
| end_demand           | PMI, real retail, card data                   | slow   |
| input_scarcity       | inventories, backwardation, lead times        | medium |
| labor_cost           | wage trackers, claims, JOLTS                  | slow   |

Clock: fast = hours, medium = weeks, slow = quarters.
Mixed clocks on one timestep make fast channels appear to cause everything — always note the lag domain.

State equation: state_{t+1} = decay ⊙ state_t + Σ_lag K_lag · state_{t-lag} + shock_t
Company forecast = channel_state × exposure_matrix − priced_in

Chains are NOT objects. They are paths read off K after propagation, for explanation only.
Always one matrix operation — never propagate a chain in isolation (it double-counts shared channels).
`.trim()

// ── Tool spec objects (description lives with the agent, schema lives in the registry) ──

export const AETHER_TOOL_SPECS = {
    get_channel_taxonomy: `The static channel taxonomy: the ~15-25 measurable pressure channels the engine uses as its state space, their observable proxies, and their clock (fast/medium/slow). Call it to explain the mental model, to ground a channel discussion, or any time the user asks "what channels does Aether track?" No arguments.`,
    get_channel_state:    `The latest channel-state snapshot written by the Python engine: current pressure scores per channel, computed_at timestamp, and the active regime label. Returns "not yet computed" when Phase 1 has not run. Call it for "what is the channel picture", "where is pressure building", "what's the current state". No arguments.`,
    get_name_exposure:    `The exposure record for one name from the Phase 3 matrix: per-channel elasticity, lag_profile, hedge_coverage, pass_through, confidence, and supply-graph connections. Returns "not yet computed" when Phase 3 has not populated this ticker. Call it to anchor a company discussion in channel-exposure data.`,
    get_regime:           `The current market regime as classified by the engine: label, definition, and which channels are driving it. Returns "not yet computed" when Phase 1 has not run. Call it when the user asks about the regime or when you need the regime label to contextualise channel pressure. No arguments.`,
}

// ── Formatters (pure — exported for testing) ─────────────────────────────────

const NOT_YET = (name) =>
    `${name}: not yet computed — the Python engine has not run this phase yet. `
    + `Reason qualitatively from your own knowledge and say so explicitly.`

export function formatChannelState(doc) {
    if (!doc) return NOT_YET('Channel state')
    const channels = Object.entries(doc.channels ?? {})
        .map(([ch, v]) => `  ${ch.padEnd(24)} ${typeof v === 'number' ? v.toFixed(3) : v}`)
        .join('\n')
    return [
        `CHANNEL STATE (computed ${String(doc.computed_at ?? '').slice(0, 19)}):`,
        channels || '  (no channel values)',
        doc.regime_label ? `Active regime: ${doc.regime_label}` : '',
    ].filter(Boolean).join('\n')
}

export function formatRegime(doc) {
    if (!doc) return NOT_YET('Regime')
    const lines = [
        `REGIME: ${doc.label ?? '(unlabelled)'}`,
        doc.definition ? doc.definition : '',
        doc.computed_at ? `Computed: ${String(doc.computed_at).slice(0, 19)}` : '',
    ]
    if (Array.isArray(doc.driving_channels) && doc.driving_channels.length) {
        lines.push(`Driving channels: ${doc.driving_channels.join(', ')}`)
    }
    return lines.filter(Boolean).join('\n')
}

export function formatExposure(ticker, doc) {
    if (!doc) return NOT_YET(`Exposure for ${ticker}`)
    const channels = Object.entries(doc.channels ?? {})
        .map(([ch, e]) => {
            const parts = [`  ${ch.padEnd(24)}`]
            if (e.elasticity != null) parts.push(`elasticity ${e.elasticity.toFixed(3)}`)
            if (e.lag_profile)       parts.push(`lag ${e.lag_profile}`)
            if (e.confidence != null) parts.push(`conf ${e.confidence.toFixed(2)}`)
            return parts.join('  ')
        })
        .join('\n')
    return [
        `EXPOSURE — ${ticker} (updated ${String(doc.updated_at ?? '').slice(0, 10)}):`,
        channels || '  (no channel entries)',
        doc.supply_graph?.length ? `Supply-graph edges: ${doc.supply_graph.length}` : '',
    ].filter(Boolean).join('\n')
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export function makeAetherToolHandlers() {
    return {
        get_channel_taxonomy: makeToolHandler('get_channel_taxonomy',
            async () => CHANNEL_TAXONOMY,
            (err) => `Could not read the channel taxonomy: ${err.message}`, LOG),

        get_channel_state: makeToolHandler('get_channel_state',
            async () => formatChannelState(await getChannelState()),
            (err) => `Could not read channel state: ${err.message}`, LOG),

        get_regime: makeToolHandler('get_regime',
            async () => formatRegime(await getCurrentRegime()),
            (err) => `Could not read the regime: ${err.message}`, LOG),

        get_name_exposure: makeToolHandler('get_name_exposure',
            async ({ ticker }) => formatExposure(ticker, await getExposure(ticker)),
            (err, { ticker }) => `Could not read exposure for ${ticker}: ${err.message}`, LOG),
    }
}
