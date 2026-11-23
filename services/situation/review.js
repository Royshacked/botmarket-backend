// ROY'S REVIEW (docs/design/situation-network.md §11.1; plan step 10).
//
// After every run, ONE card to Roy (only Roy: the review is his, Marce sees the board): the open nodes that moved more
// than 10 points in the run or since his last review (the drift rule), new nodes, woken branches (early warnings) and
// resolutions, each with the model's number and why. The first build's card lists every open node. Silence = accept
// (update.js resets the drift baseline for what the card showed). An OVERRIDE (the board, or Axl on Roy's word) is a
// new run: the node at Roy's numbers, re-anchored, spread, the industries re-scored; both numbers are logged.

import { postCard } from '../notifyCard.js'
import { readRun, latestRun, saveRun } from './store.js'
import { anchorFor, propagate } from './propagate.js'
import { scoreIndustries, wouldBeEntries } from './industries.js'
import { effectsFromNodes } from './build.js'
import { canSeeSituation } from './access.js'
import { logger } from '../logger.service.js'

const LOG = '[situation.review]'

const _io = {
    read: (id) => readRun(id), latest: () => latestRun(), save: (b) => saveRun(b),
    post: (card, ctx) => postCard(card, ctx),
    roy: async () => { const { houseLedgerUserId } = await import('../../api/user/user.model.js'); return houseLedgerUserId() },
    now: () => new Date(),
}
export function _setIO(io) { Object.assign(_io, io) }

const pct = (p) => `${Math.round(p * 100)}%`
const opts = (n) => n.options.map(o => `${o.label} ${pct(o.p)}`).join(' / ')

/** The card's lines for a run. The first build lists every open node. Pure. */
export function cardLines(run) {
    const nodes = new Map((run.nodes ?? []).map(n => [n.node_id, n]))
    const lines = []
    if (run.run.kind === 'build') {
        for (const n of run.nodes.filter(x => x.kind === 'open' && x.status === 'live')) lines.push(`• ${n.question} — ${opts(n)}`)
        return { title: `The situation network is built (${run.run.as_of}): ${lines.length} open questions to review`, lines }
    }
    const label = { moved: 'moved', drift: 'drifted since your last review', new: 'new', woken: 'EARLY WARNING — a dormant branch woke', resolved: 'resolved' }
    for (const it of run.run.stats?.review ?? []) {
        const n = nodes.get(it.node_id)
        if (!n) continue
        if (it.why === 'resolved') lines.push(`• Resolved: ${n.question} → ${n.options.find(o => o.key === it.option)?.label ?? it.option}`)
        else if (it.why === 'woken') lines.push(`• ${label.woken}: ${n.question} → ${n.options.find(o => o.key === it.option)?.label ?? it.option} (${pct(n.options.find(o => o.key === it.option)?.p ?? 0)})`)
        else lines.push(`• ${n.question} (${label[it.why]}${it.by ? `, ${Math.round(it.by * 100)} pts` : ''}) — ${opts(n)}`)
    }
    const kind = run.run.kind === 'event' ? `Event update: ${run.run.trigger}` : run.run.kind === 'rebuild' ? 'Monthly rebuild' : 'Weekly update'
    return { title: `${kind} (${run.run.as_of}): ${lines.length ? `${lines.length} to review` : 'nothing past your review line'}`, lines }
}

/** Post the run's card to Roy. Nothing to review → no card. Never throws. */
export async function postReviewCard(run_id) {
    try {
        const run = await _io.read(run_id)
        if (!run) return null
        const { title, lines } = cardLines(run)
        if (!lines.length) return null
        const userId = await _io.roy()
        if (!userId || !canSeeSituation(userId)) return null
        const top = (run.industries ?? []).filter(r => r.p_win >= 0.6 || r.p_lose >= 0.6).slice(0, 6)
            .map(r => `${r.name} ${r.p_win >= 0.6 ? `wins ${pct(r.p_win)}` : `loses ${pct(r.p_lose)}`}`)
        const content = [title, '', ...lines.slice(0, 30), lines.length > 30 ? `…and ${lines.length - 30} more on the board.` : null,
            top.length ? `\nIndustry calls (≥ 60%): ${top.join(' · ')}` : null,
            '\nSilence accepts these numbers. To change one, open the board or tell me the number.'].filter(x => x !== null).join('\n')
        return _io.post({ userId, botId: 'axl', type: 'situation_review', content, payload: { kind: 'situation_review', run_id, items: run.run.stats?.review ?? [] } }, { tag: 'Situation review card', log: LOG })
    } catch (err) {
        logger.warn(LOG, 'the review card failed', { error: err.message })
        return null
    }
}

/**
 * Roy's override of one node's numbers → a new run (kind 'event', trigger "Roy's override"). `p` is `{ option: number }`
 * over the node's options; it is renormalised. → `{ ok, run_id }` or `{ ok: false, reason }`.
 */
export async function overrideNode(node_id, p, userId) {
    if (!canSeeSituation(userId)) return { ok: false, reason: 'not allowed' }
    const head = await _io.latest()
    if (!head) return { ok: false, reason: 'no network yet' }
    const prev = await _io.read(head.run_id)
    const n = prev.nodes.find(x => x.node_id === node_id && x.status === 'live')
    if (!n) return { ok: false, reason: 'no live node with that id' }
    const xs = n.options.map(o => Math.max(0, Number(p?.[o.key]) || 0))
    const sum = xs.reduce((a, b) => a + b, 0)
    if (!(sum > 0)) return { ok: false, reason: 'give a number for at least one option' }
    const asOf = _io.now().toISOString().slice(0, 10)
    let nodes = prev.nodes.map(x => (x.node_id !== node_id ? x : {
        ...x, set_by: 'roy', options: x.options.map((o, i) => ({ ...o, p: xs[i] / sum })),
        review: { on: asOf, p: Object.fromEntries(x.options.map((o, i) => [o.key, xs[i] / sum])) },
    }))
    nodes = nodes.map(x => (x.node_id === node_id ? { ...x, anchor: anchorFor(nodes, prev.links, node_id, asOf) } : x))
    const spread = propagate(nodes, prev.links)
    const inds = (prev.industries ?? []).map(r => ({ code: r.code, name: r.name, level: r.level }))
    const industries = scoreIndustries(spread.nodes, prev.links, effectsFromNodes(spread.nodes), inds)
    const forecasts = n.options.map((o, i) => ({ node_id, option: o.key, p: xs[i] / sum, set_by: 'roy', llm_p: o.p, resolve_by: n.resolve_by }))
    const saved = await _io.save({
        run: { kind: 'event', as_of: asOf, trigger: "Roy's override", parent_run_id: head.run_id },
        state: prev.state ? { ...prev.state, as_of: asOf } : null, nodes: spread.nodes, links: prev.links, dropped: prev.dropped, industries, forecasts,
        stats: { cost_usd: 0, override: { node_id, by: String(userId), llm: Object.fromEntries(n.options.map(o => [o.key, o.p])) }, changes: spread.changes, rounds: spread.rounds,
            review: [], entries: wouldBeEntries(prev.industries, industries, asOf) },
    })
    return saved.ok ? { ok: true, run_id: saved.run_id, changes: spread.changes.length } : saved
}
