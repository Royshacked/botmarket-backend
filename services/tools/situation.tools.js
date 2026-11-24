/**
 * `get_situation` — Axl's voice for the SITUATION NETWORK (docs/design/situation-network.md §11.6, Roy 2026-11-23).
 *
 * Offered ONLY to the users on the allow-list (services/situation/access.js: Roy and Marce during the forward test);
 * everyone else gets no tool and no mention. Read-only, no model call: the latest complete run.
 *   summary   the state's date, the industry calls (≥ 60%), the early warnings, the open questions with their numbers,
 *             what the last update decided
 *   industry  one industry: its chance of winning and losing, and the branches behind it with why
 *   question  one question (by words in it): its options and numbers, its reasoning, what links to it
 *   scorecard the forward test so far against its declared pass rule
 */

import { makeToolHandler } from '../agentUtils.js'
import { latestRun, readRun } from '../situation/store.js'
import { buildScorecard } from '../situation/scorecard.js'
import { canSeeSituation } from '../situation/access.js'
import { layerOf, layerName, MACRO } from '../situation/sectors.js'

const LOG = '[situationTool]'

export const SITUATION_TOOL_SPEC = {
    get_situation: `The house's SITUATION NETWORK — the current state of the world (a macro layer, and a layer per sector under it) grown into a network of what could happen next, with probabilities, and which US industries the possible futures favour (summed over every path; a split industry gets no call). \`view\`: "summary" (default: the industry calls, early warnings, the open questions and their numbers, what the last update decided), "industry" with \`name\` (one industry's chances and the branches behind them), "question" with \`name\` (words from the question: its options, numbers, reasoning and links), "scorecard" (the forward test against its declared pass rule). It is a FORWARD TEST, untested: say so, and never turn a call into advice to buy or sell. Say the numbers as the network's, with its date.`,
}

const pct = (p) => (typeof p === 'number' ? `${Math.round(p * 100)}%` : 'n/a')
const opts = (n) => n.options.map(o => `${o.label} ${pct(o.p)}${o.dormant ? ' (dormant)' : ''}`).join(' / ')
/** A sector question names its sector (situation-network-layers.md §2). */
const where = (n) => (layerOf(n) === MACRO ? '' : `[${layerName(layerOf(n))}] `)

/** The summary view. Pure. */
export function formatSummary(run) {
    const live = run.nodes.filter(n => n.status === 'live')
    const calls = run.industries.filter(r => r.p_win >= 0.6 || r.p_lose >= 0.6)
    const warn = run.run.stats?.woken ?? []
    const dec = (run.run.stats?.decisions ?? []).filter(d => d.applied && d.decision !== 'none').slice(0, 8)
    return [
        `SITUATION NETWORK — ${run.run.kind} run of ${run.run.as_of}${run.run.trigger ? ` (${run.run.trigger})` : ''}. A forward test, untested.`,
        `INDUSTRY CALLS (≥ 60% over every path): ${calls.length ? calls.map(r => `${r.name} ${r.p_win >= 0.6 ? `wins ${pct(r.p_win)}` : `loses ${pct(r.p_lose)}`}`).join('; ') : 'none — no industry is that one-sided'}`,
        warn.length ? `EARLY WARNINGS (a dormant branch woke; shown beside the scores, not in them): ${warn.map(w => `${w.question} → ${w.label} (${pct(w.p)})`).join('; ')}` : null,
        `OPEN QUESTIONS (${live.filter(n => n.kind === 'open').length}):`,
        ...live.filter(n => n.kind === 'open').map(n => `- ${where(n)}${n.question} — ${opts(n)}`),
        `SETTLED (${live.filter(n => n.kind === 'settled').length}): ${live.filter(n => n.kind === 'settled').map(n => `${where(n)}${n.question} — ${opts(n)}`).join('; ') || 'none'}`,
        dec.length ? `THE LAST UPDATE DECIDED: ${dec.map(d => `${d.decision.replace('_', ' ')}: ${d.summary}`).join(' | ')}` : null,
    ].filter(Boolean).join('\n')
}

/** One industry. Pure. */
export function formatIndustry(run, name) {
    const q = String(name ?? '').toLowerCase().trim()
    // No name → say so (every string "includes" the empty one, so it used to match the first industry).
    if (!q) return `Name the industry (\`name\`). The network scores ${run.industries.length}: ${run.industries.slice(0, 15).map(x => x.name).join(', ')}…`
    const r = run.industries.find(x => x.name.toLowerCase() === q) ?? run.industries.find(x => x.name.toLowerCase().includes(q) || x.code === q)
    if (!r) return `The network scores no industry matching "${name}". It scores ${run.industries.length}: ${run.industries.slice(0, 15).map(x => x.name).join(', ')}…`
    const nodes = new Map(run.nodes.map(n => [n.node_id, n]))
    const why = (p) => nodes.get(p.node_id)?.options.find(o => o.key === p.option)?.effects?.find(e => e.code === r.code)?.why ?? null
    return [
        `${r.name} (${run.run.as_of}): wins ${pct(r.p_win)}, loses ${pct(r.p_lose)} over every path; size ${r.bucket}; ${r.agreement != null ? `${pct(r.agreement)} of the paths that move it agree` : 'no path moves it'}.`,
        r.macro ? `The macro layer alone: wins ${pct(r.macro.p_win)}, loses ${pct(r.macro.p_lose)} (the rest is the sector layer).` : null,
        'BEHIND IT (the branches that move it most):',
        ...r.paths.map(p => `- "${p.question}" → ${p.label}: ${p.weight >= 0 ? 'helps' : 'hurts'}${why(p) ? ` — ${why(p)}` : ''}`),
        (r.early_warning ?? []).length ? `EARLY WARNING: ${r.early_warning.map(w => `${nodes.get(w.node_id)?.question} → ${w.option} would ${w.direction === 'up' ? 'help' : 'hurt'} it`).join('; ')}` : null,
        'A forward test: untested, not advice.',
    ].filter(Boolean).join('\n')
}

/** One question. Pure. */
export function formatQuestion(run, name) {
    const words = String(name ?? '').toLowerCase().split(/\W+/).filter(w => w.length > 2)
    const scored = run.nodes.map(n => ({ n, hits: words.filter(w => n.question.toLowerCase().includes(w)).length })).filter(x => x.hits).sort((a, b) => b.hits - a.hits)
    const n = scored[0]?.n
    if (!n) return `No question matches "${name}". Call with view "summary" for the list.`
    const into = run.links.filter(l => l.to.node_id === n.node_id).map(l => `${run.nodes.find(x => x.node_id === l.from.node_id)?.question ?? '?'} → ${l.from.option} ${l.shift > 0 ? 'raises' : 'lowers'} ${l.to.option}`)
    const outOf = run.links.filter(l => l.from.node_id === n.node_id).map(l => `${n.options.find(o => o.key === l.from.option)?.label ?? l.from.option} ${l.shift > 0 ? 'raises' : 'lowers'} "${run.nodes.find(x => x.node_id === l.to.node_id)?.question ?? '?'}" → ${l.to.option}`)
    return [
        `${where(n)}${n.question} (${n.status}, ${n.kind}; resolve by ${n.resolve_by ?? 'n/a'}; set by ${n.set_by}): ${opts(n)}`,
        n.status === 'resolved' ? `RESOLVED: ${n.resolved.option} — ${n.resolved.evidence}` : null,
        n.reasoning ? `REASONING: ${n.reasoning}` : null,
        ...n.options.filter(o => o.dormant).map(o => `SIGNPOST for "${o.label}": ${o.signpost}`),
        into.length ? `MOVED BY: ${into.join('; ')}` : null,
        outOf.length ? `MOVES: ${outOf.join('; ')}` : null,
    ].filter(Boolean).join('\n')
}

/** The scorecard. Pure. */
export function formatScorecard(s) {
    const n = s.nodes.all
    return [
        `FORWARD TEST since ${s.started_on ?? 'not started'} (${s.verdict.months} months, ${s.runs} runs). The pass rule was declared before the start.`,
        `Questions resolved: ${n.questions} (needs ${100}). Brier ${n.brier?.toFixed(3) ?? 'n/a'} vs equal odds ${n.equal_odds?.toFixed(3) ?? 'n/a'}.`,
        `Industry long − short at 6 months: ${s.industries.m6.n} dates, mean ${s.industries.m6.mean == null ? 'n/a' : pct(s.industries.m6.mean)}, t ${s.industries.m6.t?.toFixed(1) ?? 'n/a'}. The macro layer alone: ${s.macro_only?.m6?.mean == null ? 'n/a' : pct(s.macro_only.m6.mean)}. The plain question (control): ${s.control.m6.mean == null ? 'n/a' : pct(s.control.m6.mean)}.`,
        s.layers ? `By layer: macro ${s.layers.macro.questions} resolved (Brier ${s.layers.macro.brier?.toFixed(3) ?? 'n/a'}), sectors ${s.layers.sectors.questions} resolved (Brier ${s.layers.sectors.brier?.toFixed(3) ?? 'n/a'}).` : null,
        s.unforeseen?.of ? `Unforeseen: ${s.unforeseen.questions} of ${s.unforeseen.of} resolved questions were won by an outcome their options did not have when forecast.` : null,
        `Checks: ${Object.entries(s.verdict.checks).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v ? '✓' : '✗'}`).join('; ')}. ${s.verdict.pass ? 'PASSED.' : 'Not passed.'}`,
    ].filter(Boolean).join('\n')
}

const _deps = { latest: () => latestRun(), read: (id) => readRun(id), scorecard: () => buildScorecard() }

/** @returns {{ get_situation: Function }} */
export function makeSituationHandlers(userId = null, deps = _deps) {
    return {
        get_situation: makeToolHandler('get_situation', async ({ view = 'summary', name } = {}) => {
            if (!canSeeSituation(userId)) return 'Not available.'
            if (view === 'scorecard') return formatScorecard(await deps.scorecard())
            const head = await deps.latest()
            if (!head) return 'The situation network has not been built yet.'
            const run = await deps.read(head.run_id)
            if (view === 'industry') return formatIndustry(run, name)
            if (view === 'question') return formatQuestion(run, name)
            return formatSummary(run)
        }, (err) => `Could not read the situation network: ${err.message}`, LOG),
    }
}
