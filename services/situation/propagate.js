// THE UPDATE ENGINE (docs/design/situation-network.md §5; plan step 6). Pure code: no I/O, no model.
//
// TREES. A node may hang under one branch of a parent (`given`). Its probabilities are then CONDITIONAL on that branch;
// the chance it is REACHED is the product of the branches above it, and a branch's MARGINAL probability is
// reach × its own conditional probability. A path's probability is the product along it (0.85 × 0.25 × 0.75 × 0.55).
//
// LINKS. A link from a branch to a target option adds a log-odds shift to that option. It is weighted by how much the
// branch's marginal probability has MOVED since the target's numbers were last set (the target's `anchor`), not by its
// level: the numbers the model sets already take the sources' current state into account, so weighting by the level
// would count every link twice (flagged to Roy, 2026-11-23: the plan said "weighted by its branch's probability").
//   p_k ∝ anchor_k × exp( Σ shift × (marginal_now(source) − marginal_at_anchor(source)) )   then renormalised
// Log-odds keep every number inside (0, 1) however many links stack up.
//
// SPREADING. Every node is recomputed from the current marginals, round after round, until no option moves by more
// than SETTLE_BY (1 point) or MAX_ROUNDS (10) — the cap that stops a loop.
//
// RESOLVING. A step that resolved is 100%; its siblings 0; a node hanging under a dead branch is unreachable.

export const SETTLE_BY = 0.01
export const MAX_ROUNDS = 10
const EPS = 1e-9

const byId = (nodes) => new Map(nodes.map(n => [n.node_id, n]))
const pOf = (n, key) => n.options.find(o => o.key === key)?.p ?? 0

/** The chance a node is reached at all: the product of the marginal branches above it. Pure. */
export function reach(nodes, id, map = byId(nodes), seen = new Set()) {
    const n = map.get(id)
    if (!n || seen.has(id)) return 0
    if (!n.given) return 1
    seen.add(id)
    const parent = map.get(n.given.node_id)
    if (!parent) return 0
    return reach(nodes, parent.node_id, map, seen) * pOf(parent, n.given.option)
}

/** A branch's marginal probability: reach × its conditional probability. Pure. */
export function marginal(nodes, id, key, map = byId(nodes)) {
    const n = map.get(id)
    return n ? reach(nodes, id, map) * pOf(n, key) : 0
}

/**
 * A path's probability: the product of its steps' conditional probabilities, each step hanging under the one before
 * (the first may hang anywhere: its reach is included). → null when the steps are not a chain. Pure.
 */
export function pathProbability(nodes, steps) {
    const map = byId(nodes)
    if (!steps.length) return null
    let p = reach(nodes, steps[0].node_id, map)
    for (let i = 0; i < steps.length; i++) {
        const n = map.get(steps[i].node_id)
        if (!n || !n.options.some(o => o.key === steps[i].option)) return null
        if (i > 0 && (n.given?.node_id !== steps[i - 1].node_id || n.given?.option !== steps[i - 1].option)) return null
        p *= pOf(n, steps[i].option)
    }
    return p
}

/**
 * Every end point of the tree under `rootId` → `[{ steps, p }]`. A branch with no node under it ends a path; a branch
 * with several nodes under it multiplies them (each combination is a path). Bounded by `max`. The end points of a root
 * sum to 1. Pure.
 */
export function treePaths(nodes, rootId, { max = 2000 } = {}) {
    const map = byId(nodes)
    const children = new Map()
    for (const n of nodes) if (n.given) {
        const k = `${n.given.node_id}|${n.given.option}`
        if (!children.has(k)) children.set(k, [])
        children.get(k).push(n)
    }
    const expand = (node, depth = 0) => {
        if (depth > 50) return [{ steps: [], p: 1 }]
        const out = []
        for (const o of node.options) {
            const kids = children.get(`${node.node_id}|${o.key}`) ?? []
            let combos = [{ steps: [{ node_id: node.node_id, option: o.key }], p: o.p }]
            for (const kid of kids) {
                const sub = expand(kid, depth + 1)
                const next = []
                for (const c of combos) for (const s of sub) { next.push({ steps: [...c.steps, ...s.steps], p: c.p * s.p }); if (next.length >= max) break }
                combos = next
            }
            out.push(...combos)
            if (out.length >= max) break
        }
        return out.slice(0, max)
    }
    const root = map.get(rootId)
    return root ? expand(root) : []
}

/** Resolve a node to the option that happened → a new nodes array (the node 100% on it, status resolved). Pure. */
export function resolve(nodes, id, option, { evidence = '', on = null, by = 'llm' } = {}) {
    return nodes.map(n => (n.node_id !== id ? n : {
        ...n, status: 'resolved', resolved: { option, evidence, on, by },
        options: n.options.map(o => ({ ...o, p: o.key === option ? 1 : 0 })),
    }))
}

/** The anchor for a node whose numbers were just set: its numbers, and each incoming link's source marginal now. Pure. */
export function anchorFor(nodes, links, id, on = null) {
    const map = byId(nodes)
    const n = map.get(id)
    const src = {}
    for (const l of links) if (l.live !== false && l.to.node_id === id) src[l.link_id] = marginal(nodes, l.from.node_id, l.from.option, map)
    return { p: Object.fromEntries(n.options.map(o => [o.key, o.p])), src, on }
}

/** One node's numbers from its anchor and its sources' current marginals. Pure. */
export function recompute(node, incoming, marginals) {
    const a = node.anchor
    if (!a || node.status === 'resolved') return node
    const push = Object.fromEntries(node.options.map(o => [o.key, 0]))
    for (const l of incoming) {
        if (l.live === false || !(l.to.option in push)) continue
        const before = a.src?.[l.link_id]
        if (typeof before !== 'number') continue        // a link added after the anchor counts from the next anchor
        push[l.to.option] += l.shift * ((marginals.get(l.link_id) ?? before) - before)
    }
    const raw = node.options.map(o => Math.max(EPS, a.p[o.key] ?? o.p) * Math.exp(push[o.key]))
    const sum = raw.reduce((s, x) => s + x, 0)
    return { ...node, options: node.options.map((o, i) => ({ ...o, p: raw[i] / sum })) }
}

/**
 * Spread until settled → `{ nodes, rounds, settled, changes }`. `changes` lists every option that moved, start → end.
 * Resolved nodes and nodes without an anchor stay as they are. Pure.
 */
export function propagate(nodes, links, { settleBy = SETTLE_BY, maxRounds = MAX_ROUNDS } = {}) {
    const start = byId(nodes)
    const incoming = new Map()
    for (const l of links) {
        if (!incoming.has(l.to.node_id)) incoming.set(l.to.node_id, [])
        incoming.get(l.to.node_id).push(l)
    }
    let cur = nodes
    let rounds = 0, settled = false
    while (rounds < maxRounds) {
        rounds++
        const map = byId(cur)
        const marg = new Map(links.map(l => [l.link_id, marginal(cur, l.from.node_id, l.from.option, map)]))
        const next = cur.map(n => recompute(n, incoming.get(n.node_id) ?? [], marg))
        let moved = 0
        for (let i = 0; i < next.length; i++) for (let k = 0; k < next[i].options.length; k++) moved = Math.max(moved, Math.abs(next[i].options[k].p - cur[i].options[k].p))
        cur = next
        if (moved < settleBy) { settled = true; break }
    }
    const changes = []
    for (const n of cur) {
        const s = start.get(n.node_id)
        for (const o of n.options) {
            const before = s.options.find(x => x.key === o.key)?.p
            if (before != null && Math.abs(o.p - before) >= 0.005) changes.push({ node_id: n.node_id, option: o.key, before, after: o.p })
        }
    }
    return { nodes: cur, rounds, settled, changes }
}

/**
 * Split a node that resolved differently in its parts (§11.10): the parts inherit its tree, given, lag and links (each
 * link re-pointed to every part with the same option keys); the original is marked `split`. Pure.
 */
export function split(nodes, links, id, parts) {
    const n = nodes.find(x => x.node_id === id)
    if (!n) return { nodes, links }
    const made = parts.map(p => ({ ...n, ...p, split_from: id, status: 'live', resolved: null, anchor: null }))
    const out = nodes.map(x => (x.node_id === id ? { ...x, status: 'split' } : x)).concat(made)
    const relinked = []
    for (const l of links) {
        if (l.to.node_id === id) { for (const m of made) if (m.options.some(o => o.key === l.to.option)) relinked.push({ ...l, link_id: `${l.link_id}~${m.node_id}`, to: { node_id: m.node_id, option: l.to.option } }) }
        else if (l.from.node_id === id) { for (const m of made) if (m.options.some(o => o.key === l.from.option)) relinked.push({ ...l, link_id: `${l.link_id}~${m.node_id}`, from: { node_id: m.node_id, option: l.from.option } }) }
        else relinked.push(l)
    }
    return { nodes: out, links: relinked }
}
