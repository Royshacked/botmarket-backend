// Aether desk tools — channel-graph engine reads.
//
// UNBOUND: channel state, regime and forecasts are house-layer broadcasts written by the Python
// compute repo and shared across all users (same pattern as sectorView). No userId.
//
// Stubs return a structured "not yet computed" message when the engine collections are empty;
// Aether reasons qualitatively (LLM knowledge) in that state and says so plainly.

import { makeToolHandler }   from '../agentUtils.js'
import { getChannelState, getCurrentRegime, getExposure, getTaxonomy, getForecasts, getCalibration, getPortfolioSlots, getInterference, getLossSurface } from '../../api/aether/aether.service.js'

const LOG = '[aetherTools]'

// ── Channel taxonomy (hardcoded — Phase 0, always available) ─────────────────
// The static channel table from docs/design/channel-graph-build-spec.md.
// Never changes between engine runs: it IS the state space definition.

// Channel IDs must match channels.yaml in the aether-engine Python repo exactly.
// The Python engine writes MongoDB docs keyed to these IDs; mismatches break live lookups.
// Last synced: 2026-08-29 (channels.yaml — 22 channels: 5 fast, 8 medium, 6 slow, 3 provisional)

const CHANNEL_TAXONOMY = `
CHANNEL TAXONOMY — 22 measurable pressure channels

FAST (hours–days):
| Channel                    | Proxy series                              |
|----------------------------|-------------------------------------------|
| energy_cost                | WTI, Brent crude, Henry Hub gas           |
| policy_rate_expectations   | Fed funds, 3M T-bill, 2Y Treasury         |
| discount_rate              | 10Y TIPS real yield, 10Y Treasury, term premium |
| risk_premium               | VIX                                       |
| fx_usd                     | Nominal broad USD index (sign: -1)        |

MEDIUM (weeks):
| Channel                    | Proxy series                              |
|----------------------------|-------------------------------------------|
| geopolitical_risk          | Caldara-Iacoviello GPR index (manual)     |
| credit_access              | Moody's Baa/Aaa corporate spreads vs 10Y  |
| freight_logistics          | PPI transport (BDI/HARPEX when licensed)  |
| consumer_credit            | Total consumer credit, card delinquency rate |
| supply_chain_concentration | Capacity utilisation, inventory/sales ratio, NY Fed GSCPI |
| corporate_capex            | Durable goods orders                      |
| regulatory_policy          | Baker-Bloom-Davis EPU index               |
| input_scarcity             | PPI intermediate goods                    |

SLOW (quarters):
| Channel                    | Proxy series                              |
|----------------------------|-------------------------------------------|
| end_demand                 | Retail sales, Michigan consumer sentiment |
| labor_cost                 | Initial claims (inv), avg hourly earnings, JOLTS openings |
| commodity_metals           | IMF copper price, IMF iron ore price      |
| commodity_agriculture      | IMF food price index, wheat price         |
| housing_construction       | Housing starts, building permits, Case-Shiller HPI |
| fiscal_impulse             | Federal surplus/deficit monthly (sign: -1) |

PROVISIONAL (gate may fail — still validating):
| Channel                    | Proxy series                              |
|----------------------------|-------------------------------------------|
| demographic_labor          | Prime-age LFPR 25–54 (sign: -1)           |
| trade_tariffs              | Computed effective tariff rate (manual)   |
| tech_diffusion             | Semiconductor book-to-bill (licensed)     |

Clock: fast = hours, medium = weeks, slow = quarters.
Mixed clocks on one timestep make fast channels appear to cause everything — always note the lag domain.
Provisional channels may be dropped at Phase 1 if proxies fail the ≥10y gate.

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
    get_forecasts:        `Active and recently resolved forecasts from the Phase 6 engine: entity, direction, magnitude, probability, channels responsible, attribution_confidence, and resolution date. Returns "not yet computed" when Phase 6 has not emitted any forecasts. Call it when the user asks about signals, open positions the engine is tracking, or what the model currently sees. No arguments.`,
    get_calibration:      `Brier score calibration report by (channel × event_type × regime): which channel/event combinations are deployment-ready (mean Brier < 0.20), which need more data, which are not calibrated, and which are performing worse than a coin flip (flagged for Phase 8 governance). Returns "not yet computed" when no forecasts have resolved. Call it when the user asks about model accuracy, calibration, or which channels to trust. No arguments.`,
    get_portfolio:        `The current channel-correlation portfolio from Phase 7: one slot per entity with allocation weight, direction, attribution confidence, and per-channel decomposition. Weights are computed from probability × attribution_confidence × residual_score, then trimmed if any channel's gross portfolio exposure exceeds 30%. Returns "not yet computed" when Phase 7 has not run. Call it when Atlas is building or reviewing a portfolio, when the user asks about allocation or position weighting, or when you need to see which names the engine is currently long/short and why.`,
    get_interference:     `Cross-forecast interference classification from Phase 7: compounding (two names betting the same channel direction, superlinear risk near capacity), offsetting (one name pulled in opposite directions), masking (a loud event suppressing repricing of a quiet one — the primary durable edge), conditioning (a fast channel in forecast A shifts the regime for forecast B), sequencing (repeated entity/channel forecast with decaying surprise). Returns "not yet computed" when Phase 7 has not run. Call it when Atlas is evaluating portfolio construction, when you want to flag cross-name dynamics, or when the user asks how the current forecasts interact. No arguments.`,
    get_loss_surface:     `Monte Carlo portfolio loss surface from Phase 7: P&L quantiles (p01–p99), per-channel variance contributions, and gross channel exposures relative to the 30% cap. Simulates 10,000 joint channel state draws using the channel correlation matrix built from channel decompositions (not returns). Returns "not yet computed" when Phase 7 has not run. Call it when the user asks about portfolio risk, tail exposure, drawdown scenarios, or which channels are driving P&L uncertainty. No arguments.`,
}

// ── Formatters (pure — exported for testing) ─────────────────────────────────

export function formatTaxonomy(docs) {
    if (!docs || !docs.length) return null   // caller falls back to static string

    const synced = docs.reduce((latest, d) => d.synced_at > latest ? d.synced_at : latest, '')
    const syncDate = synced ? String(synced).slice(0, 10) : 'unknown'

    const groups = {}
    for (const ch of docs) {
        const key = ch.clock ?? 'unknown'
        ;(groups[key] ??= []).push(ch)
    }

    const lines = [
        `CHANNEL TAXONOMY — ${docs.length} measurable pressure channels`,
        `Last synced from channels.yaml: ${syncDate}`,
        '',
    ]

    const clockOrder = ['fast', 'medium', 'slow']
    const extra = Object.keys(groups).filter(k => !clockOrder.includes(k))

    for (const clock of [...clockOrder, ...extra]) {
        const group = groups[clock]
        if (!group?.length) continue
        const label = clock === 'fast' ? 'FAST (hours–days)'
            : clock === 'medium' ? 'MEDIUM (weeks)'
            : clock === 'slow'   ? 'SLOW (quarters)'
            : clock.toUpperCase()
        lines.push(`${label}:`)
        lines.push('| Channel                         | Proxy series                                    |')
        lines.push('|---------------------------------|-------------------------------------------------|')
        for (const ch of group) {
            const proxies = (ch.proxies ?? []).map(p => p.id).join(', ')
            const note = ch.note ? ` [${ch.note}]` : ''
            lines.push(`| ${ch.channel_id.padEnd(31)} | ${(proxies + note).padEnd(47)} |`)
        }
        lines.push('')
    }

    lines.push(
        'Clock: fast = hours, medium = weeks, slow = quarters.',
        'Mixed clocks on one timestep make fast channels appear to cause everything — always note the lag domain.',
        '',
        'State equation: state_{t+1} = decay ⊙ state_t + Σ_lag K_lag · state_{t-lag} + shock_t',
        'Company forecast = channel_state × exposure_matrix − priced_in',
        '',
        'Chains are NOT objects. They are paths read off K after propagation, for explanation only.',
        'Always one matrix operation — never propagate a chain in isolation (it double-counts shared channels).',
    )

    return lines.join('\n').trimEnd()
}

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

export function formatForecasts(docs) {
    if (!docs || !docs.length) return NOT_YET('Forecasts')
    const pending  = docs.filter(d => d.status === 'pending')
    const resolved = docs.filter(d => d.status === 'resolved').slice(0, 5)
    const lines = [`FORECASTS (${pending.length} pending, ${resolved.length} recently resolved):`]
    if (pending.length) {
        lines.push('\nPending:')
        for (const f of pending) {
            lines.push(
                `  ${f.entity.padEnd(6)} ${f.direction.padEnd(5)} `
                + `horizon=${f.horizon_weeks}w  p=${f.probability.toFixed(2)}  `
                + `conf=${f.attribution_confidence.toFixed(2)}  `
                + `residual=${f.residual_score >= 0 ? '+' : ''}${f.residual_score.toFixed(3)}  `
                + `resolves ${String(f.resolution_date).slice(0, 10)}`
            )
            lines.push(`    channels: ${(f.channels_responsible ?? []).join(', ')}`)
        }
    }
    if (resolved.length) {
        lines.push('\nRecently resolved:')
        for (const f of resolved) {
            const brier = f.brier_score != null ? `brier=${f.brier_score.toFixed(3)}` : '(neutral)'
            const imp   = f.brier_improvement != null
                ? (f.brier_improvement >= 0 ? `+${f.brier_improvement.toFixed(3)}` : f.brier_improvement.toFixed(3))
                : ''
            lines.push(
                `  ${f.entity.padEnd(6)} ${f.direction.padEnd(5)} `
                + `actual=${f.outcome != null ? (f.outcome >= 0 ? '+' : '') + f.outcome.toFixed(3) : '?'}  `
                + `${brier}  improvement=${imp}`
            )
        }
    }
    return lines.join('\n')
}

export function formatCalibration(docs) {
    if (!docs || !docs.length) return NOT_YET('Calibration')
    const ready     = docs.filter(d => d.calibrated && d.n_forecasts >= 5)
    const pending   = docs.filter(d => d.calibrated && d.n_forecasts < 5)
    const notCal    = docs.filter(d => !d.calibrated)
    const degraded  = docs.filter(d => d.brier_improvement < 0)
    const lines = [
        `CALIBRATION STATUS (${docs.length} slices):`,
        `  deployment-ready    : ${ready.length}`,
        `  needs more data     : ${pending.length}`,
        `  not calibrated      : ${notCal.length}`,
        `  worse than coin flip: ${degraded.length}`,
    ]
    if (ready.length) {
        lines.push('\nDeployment-ready slices (mean Brier < 0.20, n ≥ 5):')
        for (const s of ready) {
            lines.push(
                `  ${s.channel_id.padEnd(28)} ${s.event_type.padEnd(18)} `
                + `${s.regime.padEnd(12)} Brier=${s.mean_brier.toFixed(3)}  n=${s.n_forecasts}`
            )
        }
    }
    if (degraded.length) {
        lines.push('\nDegraded — flag for Phase 8 edge governance:')
        for (const s of degraded) {
            lines.push(
                `  ${s.channel_id.padEnd(28)} improvement=${s.brier_improvement.toFixed(3)}`
            )
        }
    }
    return lines.join('\n')
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

export function formatPortfolio(docs) {
    if (!docs || !docs.length) return NOT_YET('Portfolio')
    const runDate = String(docs[0]?.computed_at ?? '').slice(0, 10)
    const total   = docs.reduce((s, d) => s + (d.weight ?? 0), 0)
    const lines   = [`PORTFOLIO — ${docs.length} positions (run ${runDate}, Σw=${total.toFixed(3)}):`]

    for (const s of docs) {
        const capNote = s.capped ? ` [CAPPED by ${s.cap_channel}]` : ''
        const wPct    = ((s.weight ?? 0) * 100).toFixed(1)
        const conf    = s.attribution_confidence != null ? `conf=${s.attribution_confidence.toFixed(2)}` : ''
        // top 3 channel contributions by abs value
        const topCh   = Object.entries(s.channel_decomposition ?? {})
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
            .slice(0, 3)
            .map(([ch, v]) => `${ch}(${v >= 0 ? '+' : ''}${v.toFixed(3)})`)
            .join(', ')
        lines.push(
            `  ${(s.entity ?? '?').padEnd(6)} w=${wPct.padStart(5)}%  ${(s.direction ?? '').padEnd(5)}  ${conf}${capNote}`
            + (topCh ? `\n    channels: ${topCh}` : '')
        )
    }
    return lines.join('\n')
}

export function formatInterference(docs) {
    if (!docs) return NOT_YET('Interference')
    if (!docs.length) return 'INTERFERENCE: no interactions detected in the current forecast set.'
    const runDate = String(docs[0]?.computed_at ?? '').slice(0, 10)
    const lines   = [`INTERFERENCE — ${docs.length} interactions (run ${runDate}):`]

    const typeOrder = ['masking', 'compounding', 'offsetting', 'conditioning', 'sequencing']
    const grouped   = {}
    for (const r of docs) grouped[r.interference_type] = [...(grouped[r.interference_type] ?? []), r]

    for (const type of [...typeOrder, ...Object.keys(grouped).filter(k => !typeOrder.includes(k))]) {
        const group = grouped[type]
        if (!group?.length) continue
        lines.push(`\n${type.toUpperCase()}:`)
        for (const r of group) {
            const pair = r.entity_b ? `${r.entity_a} → ${r.entity_b}` : r.entity_a
            const chs  = (r.channel_ids ?? []).join(', ')
            lines.push(`  [sev=${r.severity.toFixed(2)}] ${pair.padEnd(14)} channels: ${chs}`)
            if (r.description) lines.push(`    ${r.description}`)
        }
    }
    return lines.join('\n')
}

export function formatLossSurface(doc) {
    if (!doc) return NOT_YET('Loss surface')
    const runDate = String(doc.computed_at ?? '').slice(0, 10)
    const q       = doc.quantiles ?? {}
    const pct     = (v) => v != null ? `${(v * 100) >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '?'

    const qLine = ['p01','p05','p10','p25','p50','p75','p90','p95','p99']
        .map(k => `${k}=${pct(q[k])}`)
        .join('  ')

    const varLines = Object.entries(doc.channel_var_contributions ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([ch, v]) => `  ${ch.padEnd(28)} ${(v * 100).toFixed(1)}%`)

    const grossLines = Object.entries(doc.gross_channel_exposures ?? {})
        .filter(([, v]) => v > 0.01)
        .sort((a, b) => b[1] - a[1])
        .map(([ch, v]) => {
            const capFlag = v > 0.28 ? '  ← near 30% cap' : ''
            return `  ${ch.padEnd(28)} ${(v * 100).toFixed(1)}%${capFlag}`
        })

    return [
        `LOSS SURFACE — ${(doc.n_simulations ?? 0).toLocaleString()} simulations (run ${runDate}):`,
        qLine,
        '',
        'Channel VaR contributions:',
        ...varLines,
        '',
        'Gross channel exposures (cap: 30%):',
        ...grossLines,
        '',
        `Portfolio: ${(doc.portfolio_entities ?? []).join(', ')}`,
    ].join('\n')
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export function makeAetherToolHandlers() {
    return {
        get_channel_taxonomy: makeToolHandler('get_channel_taxonomy',
            async () => formatTaxonomy(await getTaxonomy()) ?? CHANNEL_TAXONOMY,
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

        get_forecasts: makeToolHandler('get_forecasts',
            async () => formatForecasts(await getForecasts()),
            (err) => `Could not read forecasts: ${err.message}`, LOG),

        get_calibration: makeToolHandler('get_calibration',
            async () => formatCalibration(await getCalibration()),
            (err) => `Could not read calibration scores: ${err.message}`, LOG),

        get_portfolio: makeToolHandler('get_portfolio',
            async () => formatPortfolio(await getPortfolioSlots()),
            (err) => `Could not read portfolio slots: ${err.message}`, LOG),

        get_interference: makeToolHandler('get_interference',
            async () => formatInterference(await getInterference()),
            (err) => `Could not read interference records: ${err.message}`, LOG),

        get_loss_surface: makeToolHandler('get_loss_surface',
            async () => formatLossSurface(await getLossSurface()),
            (err) => `Could not read loss surface: ${err.message}`, LOG),
    }
}
