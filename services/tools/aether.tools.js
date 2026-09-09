// Aether desk tools — the surviving channel MEASUREMENT reads.
//
// Eleven tools were retired on 2026-09-09 with the channel-forecasting stack they read
// from: exposure elasticities, forecasts, calibration, portfolio slots, interference,
// loss surface, governance budget, decay audit, shock predictions, the opportunity
// feed and per-ticker signals. Their collections are archived, empty, or — worst —
// stale: get_shock_feed was serving Mentor and Atlas the 170 opportunity cards built
// on June's channel state by a generator that no longer runs.
//
// What is left is the measurement path: taxonomy, channel state, regime. The event
// pipeline (aether_event_runs, aether_event_candidates) has no tool surface yet.
//
// UNBOUND: channel state, regime and forecasts are house-layer broadcasts written by the Python
// compute repo and shared across all users (same pattern as sectorView). No userId.
//
// Stubs return a structured "not yet computed" message when the engine collections are empty;
// Aether reasons qualitatively (LLM knowledge) in that state and says so plainly.

import { makeToolHandler }   from '../agentUtils.js'
import { getChannelState, getCurrentRegime, getTaxonomy } from '../../api/aether/aether.service.js'

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
    get_regime:           `The current market regime as classified by the engine: label, definition, and which channels are driving it. Returns "not yet computed" when Phase 1 has not run. Call it when the user asks about the regime or when you need the regime label to contextualise channel pressure. No arguments.`,
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

// Mongo returns a Date for date-typed fields and a string for ISO text. Slicing
// String(aDate) yields "Sun Aug 30 2026 17:" — take the ISO form before slicing.
const iso = (v, len) => v == null ? '' : (v instanceof Date ? v.toISOString() : String(v)).slice(0, len)
const isoDay = v => iso(v, 10)
const isoSec = v => iso(v, 19).replace('T', ' ')

export function formatChannelState(doc) {
    if (!doc) return NOT_YET('Channel state')
    const channels = Object.entries(doc.channels ?? {})
        .map(([ch, v]) => `  ${ch.padEnd(27)} ${typeof v === 'number' ? v.toFixed(3) : v}`)
        .join('\n')
    const when = isoSec(doc.computed_at)
    return [
        `CHANNEL STATE${when ? ` (computed ${when})` : ''}:`,
        channels || '  (no channel values)',
        doc.regime_label ? `Active regime: ${doc.regime_label}` : '',
    ].filter(Boolean).join('\n')
}

export function formatRegime(doc) {
    if (!doc) return NOT_YET('Regime')
    // Python writes the label as `regime` (aether_regimes); `label` is the build spec's name
    // for the same field. Accept either, so neither writer renders as "(unlabelled)".
    const lines = [
        `REGIME: ${doc.regime ?? doc.label ?? '(unlabelled)'}`,
        doc.definition ? doc.definition : '',
        // `date` is the observation the regime describes; computed_at is only when the run ran.
        doc.date ? `As of: ${isoDay(doc.date)}` : '',
        doc.computed_at ? `Computed: ${isoSec(doc.computed_at)}` : '',
    ]
    // The classifier's own inputs, when the doc carries them instead of a channel list.
    const inputs = [
        doc.credit_access_z != null ? `credit_access ${doc.credit_access_z.toFixed(2)}` : null,
        doc.risk_premium_z  != null ? `risk_premium ${doc.risk_premium_z.toFixed(2)}`   : null,
    ].filter(Boolean)
    if (inputs.length) lines.push(`Classifier inputs: ${inputs.join(', ')}`)
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

// lag_profile is a DISTRIBUTION — { p10_weeks, median_weeks, p90_weeks } — not a scalar.
// Interpolating it directly renders "[object Object]".
function formatLagProfile(profile) {
    if (profile == null) return null
    if (typeof profile !== 'object') return `lag ${profile}w`
    const pts = [profile.p10_weeks, profile.median_weeks, profile.p90_weeks].filter(v => v != null)
    return pts.length ? `lag ${pts.join('–')}w` : null
}

export function formatExposure(ticker, doc) {
    const entries = Object.entries(doc?.channels ?? {})
    if (!doc || !entries.length) return NOT_YET(`Exposure for ${ticker}`)

    const channels = entries
        .map(([ch, e]) => {
            // 26 = longest channel id in channels.yaml (supply_chain_concentration).
            const parts = [`  ${ch.padEnd(27)}`]
            if (e.elasticity != null)     parts.push(`elasticity ${e.elasticity.toFixed(3)}`)
            const lag = formatLagProfile(e.lag_profile)
            if (lag)                      parts.push(lag)
            if (e.hedge_coverage != null) parts.push(`hedged ${e.hedge_coverage.toFixed(2)}`)
            if (e.pass_through != null)   parts.push(`pass-through ${e.pass_through.toFixed(2)}`)
            if (e.confidence != null)     parts.push(`conf ${e.confidence.toFixed(2)}`)
            return parts.join('  ')
        })
        .join('\n')

    return [
        `EXPOSURE — ${ticker} (${entries.length} channel${entries.length === 1 ? '' : 's'}; lag shown p10–median–p90):`,
        channels,
        doc.supply_graph?.length ? `Supply-graph edges into ${ticker}: ${doc.supply_graph.length}` : '',
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

const ANNUAL_BUDGET_CAP = 4
const ANNUAL_BUDGET_WARN = 2

export function formatGovernanceBudget(docs) {
    if (!docs) return NOT_YET('Governance budget')

    const now = Date.now()
    const cutoff = now - 365 * 24 * 60 * 60 * 1000

    const promoted = docs.filter(d =>
        d.status === 'promoted' && d.decided_at && new Date(d.decided_at).getTime() >= cutoff
    ).length
    const remaining   = Math.max(0, ANNUAL_BUDGET_CAP - promoted)
    const exhausted   = remaining === 0
    const atWarn      = promoted >= ANNUAL_BUDGET_WARN
    const inProcess   = docs.filter(d =>
        d.status === 'candidate' && d.admission_step >= 2 ||
        d.status === 'provisional'
    ).length
    const unreviewed  = docs.filter(d => d.status === 'candidate' && d.admission_step === 1).length
    const blocked     = docs.filter(d => d.status === 'budget_blocked').length

    const lines = [
        `EDGE GOVERNANCE BUDGET (${ANNUAL_BUDGET_CAP} edges/year hard cap):`,
        `  Promoted in last 365 days : ${promoted} / ${ANNUAL_BUDGET_CAP}`,
        `  Remaining capacity        : ${remaining}`,
    ]
    if (exhausted) {
        lines.push('  *** BUDGET EXHAUSTED — no new admissions until a promotion ages out ***')
    } else if (atWarn) {
        lines.push(`  Warning: ${ANNUAL_BUDGET_WARN} of ${ANNUAL_BUDGET_CAP} annual slots used`)
    }
    lines.push(`  Candidates in process     : ${inProcess}`)
    lines.push(`  Candidates awaiting OOS   : ${unreviewed}`)
    if (blocked) lines.push(`  Budget-blocked (queued)   : ${blocked}`)
    lines.push('')
    lines.push(
        'The residual monitor always has more suggestions than the budget allows.',
        'The budget is the mechanism that prevents spurious edge additions.'
    )

    // Show active candidates if any
    const active = docs.filter(d => d.status === 'candidate' || d.status === 'provisional')
    if (active.length) {
        lines.push('\nActive pipeline:')
        for (const c of active) {
            const stepLabel = ['', 'submitted', 'OOS check', 'provisional', 'scoring', 'deciding'][c.admission_step] ?? `step${c.admission_step}`
            lines.push(
                `  K[${c.channel_from}→${c.channel_to}] lag=${c.lag}w  `
                + `${c.status.padEnd(11)} (${stepLabel})  source=${c.source}`
            )
        }
    }

    return lines.join('\n')
}

export function formatDecayAudit(docs) {
    if (!docs) return NOT_YET('Decay audit')
    const runDate  = String(docs[0]?.audit_date ?? '').slice(0, 10)
    const nKeep    = docs.filter(d => d.recommendation === 'keep').length
    const nDemote  = docs.filter(d => d.recommendation === 'demote').length
    const nDelete  = docs.filter(d => d.recommendation === 'delete').length

    const lines = [
        `DECAY AUDIT — ${docs.length} K edges audited (run ${runDate}):`,
        `  keep   : ${nKeep}`,
        `  demote : ${nDemote}`,
        `  delete : ${nDelete}`,
    ]

    const deleteEdges = docs.filter(d => d.recommendation === 'delete')
    if (deleteEdges.length) {
        lines.push('\nEdges flagged for DELETION (recent weight < 20% of original):')
        for (const r of deleteEdges) {
            lines.push(
                `  K[${r.channel_from}→${r.channel_to}] lag=${r.lag}w  `
                + `regime=${r.regime}  `
                + `original=${r.original_weight.toFixed(4)}  `
                + `recent=${r.recent_weight.toFixed(4)}  `
                + `ratio=${(r.weight_ratio * 100).toFixed(0)}%`
            )
        }
    }

    const demoteEdges = docs.filter(d => d.recommendation === 'demote')
    if (demoteEdges.length) {
        lines.push('\nEdges flagged for DEMOTION (recent weight 20–50% of original):')
        for (const r of demoteEdges) {
            lines.push(
                `  K[${r.channel_from}→${r.channel_to}] lag=${r.lag}w  `
                + `ratio=${(r.weight_ratio * 100).toFixed(0)}%  `
                + `OOS R²=${r.recent_oos_r2.toFixed(4)}`
            )
        }
    }

    if (!deleteEdges.length && !demoteEdges.length) {
        lines.push('\nAll audited edges remain healthy (weight_ratio ≥ 50%).')
    }

    lines.push('')
    lines.push('"Dead edges are worse than missing ones — they generate confident wrong forecasts."')

    return lines.join('\n')
}

export function formatActiveShockPredictions(docs) {
    if (!docs || !docs.length) {
        return 'ACTIVE SHOCK PREDICTIONS: no active signals — the Aether shock pipeline has not produced provisional predictions yet. Reason qualitatively from your own macro knowledge and say so.'
    }

    // Aggregate by channel: keep highest-confidence signal per channel
    const byChannel = {}
    for (const d of docs) {
        const ch    = d.channel_id
        const entry = (byChannel[ch] ??= { top: d, signals: [] })
        if (d.confidence_llm > entry.top.confidence_llm) entry.top = d
        entry.signals.push(d)
    }

    const total    = docs.length
    const channels = Object.keys(byChannel).length
    const lines = [
        `ACTIVE SHOCK PREDICTIONS — ${total} provisional signal${total !== 1 ? 's' : ''} across ${channels} channel${channels !== 1 ? 's' : ''}`,
        '(status: provisional — not yet confirmed by a FRED release)',
        '',
        'SIGNALS BY CHANNEL (highest-confidence signal shown; N = total for that channel):',
    ]

    const dirArrow = { up: '↑ UP', down: '↓ DOWN', neutral: '→ NEUTRAL' }

    for (const [chId, { top, signals }] of Object.entries(byChannel).sort((a, b) => b[1].top.confidence_llm - a[1].top.confidence_llm)) {
        const d       = top
        const lagStr  = d.lag_weeks_min === d.lag_weeks_max
            ? `lag ${d.lag_weeks_min}w`
            : `lag ${d.lag_weeks_min}–${d.lag_weeks_max}w`
        const expStr  = d.expires_at ? `  expires ${d.expires_at}` : ''
        const nStr    = signals.length > 1 ? `  [N=${signals.length}]` : ''
        lines.push(
            `  ${chId.padEnd(28)} ${(dirArrow[d.direction] ?? d.direction).padEnd(11)} `
            + `${d.magnitude.padEnd(8)} conf=${d.confidence_llm.toFixed(2)}  ${lagStr}${expStr}${nStr}`
        )
        lines.push(`    "${d.reasoning}"`)
    }

    lines.push('')
    return lines.join('\n')
}

const DIR_ARROWS = { up: '↑ UP', down: '↓ DOWN', neutral: '→ NEUTRAL' }

export function formatValidationOutcomes(docs) {
    if (!docs || !docs.length) return null   // caller handles the no-data case
    const confirmed = docs.filter(d => d.new_status === 'confirmed')
    const rejected  = docs.filter(d => d.new_status === 'rejected')
    const lines = [
        `VALIDATION OUTCOMES — ${confirmed.length} confirmed, ${rejected.length} rejected (most recent first):`,
    ]
    for (const d of docs) {
        const icon    = d.new_status === 'confirmed' ? '✓' : '✗'
        const dirLbl  = DIR_ARROWS[d.direction] ?? d.direction.toUpperCase()
        const brier   = d.brier != null ? `  brier=${d.brier.toFixed(3)}` : ''
        const correct = d.direction_correct != null ? `  correct=${d.direction_correct}` : ''
        lines.push(
            `  ${icon} ${d.channel_id.padEnd(28)} ${dirLbl.padEnd(11)} `
            + `conf=${d.confidence_llm.toFixed(2)}${brier}${correct}  validated=${d.validated_at}`
        )
    }
    return lines.join('\n')
}

// 8-K item numbers the event pipeline whitelists (sec_8k_fetcher._MATERIAL_ITEMS).
// The bare number is opaque to a reader; the label is what makes the card legible.
const EIGHT_K_ITEMS = {
    '1.01': 'material agreement',
    '1.02': 'agreement terminated',
    '2.01': 'acquisition/disposition',
    '2.03': 'financial obligation',
    '5.02': 'officer/director change',
    '7.01': 'Reg FD disclosure',
    '8.01': 'other material event',
}

// An event card puts the FILING ITEM in channel_id ("8-K:1.01") — not a macro channel id —
// and carries source_type/dimension that macro cards do not have. Rendering channel_id bare
// leaves the agent unable to tell an idiosyncratic filing signal from a macro channel move.
function formatCardSource(c) {
    if (c?.source_type !== 'event') return c?.channel_id ?? ''
    return `${c.channel_id}${c.dimension ? `·${c.dimension}` : ''}`
}

// One legend for the whole feed rather than a label repeated on every card.
function eventLegend(events) {
    const items = [...new Set(
        events.map(c => String(c.channel_id ?? '').split(':')[1]).filter(Boolean)
    )].sort()
    const lines = [
        'EVENT cards are sourced from the company\'s own 8-K filing, not a macro channel:'
        + ' idiosyncratic to the name, and never FRED-validated — a missing brier means'
        + ' "never scored", not "pending".',
    ]
    if (items.length) {
        lines.push(`  8-K items present: ${items.map(i => `${i}=${EIGHT_K_ITEMS[i] ?? 'other'}`).join(', ')}`)
    }
    return lines
}

export function formatOpportunityCards(docs) {
    if (!docs || !docs.length) return null   // caller handles the no-data case
    const mentor = docs.filter(d => d.agent === 'mentor')
    const atlas  = docs.filter(d => d.agent === 'atlas')
    const events = docs.filter(d => d.source_type === 'event')
    const mix    = events.length ? `; ${events.length} event-sourced, ${docs.length - events.length} macro` : ''
    const lines  = [
        `OPPORTUNITY CARDS — ${docs.length} active (${mentor.length} swing/Mentor, ${atlas.length} position/Atlas${mix}):`,
        ...(events.length ? eventLegend(events) : []),
    ]

    function renderGroup(group, label) {
        if (!group.length) return
        lines.push(`\n${label}:`)
        for (const c of group) {
            const dirLbl = DIR_ARROWS[c.direction] ?? c.direction.toUpperCase()
            const lagStr = c.lag_weeks_min === c.lag_weeks_max
                ? `${c.lag_weeks_min}w`
                : `${c.lag_weeks_min}–${c.lag_weeks_max}w`
            const brier  = c.brier != null ? `  brier=${c.brier.toFixed(3)}` : ''
            lines.push(
                `  ${c.ticker.padEnd(6)} ${(c.ticker_direction ?? '').padEnd(6)} `
                + `${dirLbl.padEnd(11)} ${formatCardSource(c).padEnd(30)} `
                + `lag=${lagStr}  conf=${c.confidence_llm.toFixed(2)}${brier}  ${c.magnitude}`
            )
            lines.push(`    Why:  ${c.why}`)
            lines.push(`    When: ${c.when}`)
            lines.push(`    Risk: ${c.risk_note}`)
        }
    }

    renderGroup(mentor, 'SWING (Mentor domain, lag ≤ 3w)')
    renderGroup(atlas,  'POSITION (Atlas domain, lag ≥ 4w)')
    return lines.join('\n')
}

export function formatShockFeed(outcomes, opportunities) {
    const outcomeText = formatValidationOutcomes(outcomes)
        ?? 'VALIDATION OUTCOMES: none yet — FRED validation loop has not produced results.'
    const cardText    = formatOpportunityCards(opportunities)
        ?? 'OPPORTUNITY CARDS: none active — no confirmed predictions have generated cards yet.'

    return [
        outcomeText,
        '',
        cardText,
        '',
    ].join('\n')
}

// A news signal now stands for the whole day's coverage of one channel, not one article.
// `agreement` is |net| / gross across that batch: 1.0 unanimous, 0 a dead heat. An agent
// reading conf=0.55 cannot otherwise tell a lone confident article from thirteen articles
// that nearly cancelled out — and those call for different position sizes.
export function formatConsensus(c) {
    const n = c?.contributing_count
    if (!n || n < 2) return null
    const pct = c.agreement != null ? `${(c.agreement * 100).toFixed(0)}% net agreement` : null
    return [`${n} articles`, pct].filter(Boolean).join(', ')
}

export function formatTickerSignals(ticker, { opportunities = [], signals = [] } = {}) {
    if (!opportunities.length && !signals.length) {
        return `AETHER SIGNALS — ${ticker}: no active signals. No channel pressure currently confirmed or predicted for this name.`
    }

    const renderCard = (c, label) => {
        const lagStr = c.lag_weeks_min === c.lag_weeks_max ? `${c.lag_weeks_min}w` : `${c.lag_weeks_min}–${c.lag_weeks_max}w`
        const lines = [
            `  ${c.ticker_direction?.padEnd(6) ?? '?'.padEnd(6)} ${formatCardSource(c).padEnd(30)} `
            + `${(c.direction ?? '').padEnd(6)} ${(c.magnitude ?? '').padEnd(8)} `
            + `lag=${lagStr}  conf=${(c.confidence_llm ?? 0).toFixed(2)}  [${c.source_type === 'event' ? 'event' : label}]`,
        ]
        const consensus = formatConsensus(c)
        if (consensus) lines.push(`    Basis: ${consensus}`)
        if (c.why)  lines.push(`    Why:  ${c.why}`)
        if (c.when) lines.push(`    When: ${c.when}`)
        if (c.action_label && c.action_label !== 'watch') lines.push(`    Action: ${c.action_label}`)
        return lines.join('\n')
    }

    const events = [...opportunities, ...signals].filter(c => c.source_type === 'event')
    const out = [
        `AETHER SIGNALS — ${ticker} (${opportunities.length} confirmed, ${signals.length} provisional):`,
        ...(events.length ? eventLegend(events) : []),
    ]
    if (opportunities.length) {
        out.push('\nCONFIRMED (FRED-validated):')
        for (const c of opportunities) out.push(renderCard(c, 'confirmed'))
    }
    if (signals.length) {
        out.push('\nPROVISIONAL (news-driven, awaiting FRED):')
        for (const c of signals) out.push(renderCard(c, 'provisional'))
    }
    return out.join('\n')
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











    }
}
