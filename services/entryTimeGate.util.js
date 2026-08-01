/**
 * Is an entity's ENTRY gated on the clock, and if so how completely?
 *
 * Pure, no I/O. Lifted out of minos.monitor.service.js when the deferred-order sweep moved to its
 * own monitor: two callers now need the same answer (the archived idea monitor's market-closed
 * exemption, and marketOpen.monitor's card note), and a shared *mechanism* belongs in one service
 * rather than being copied or subtly diverging. The `idea` kind is the only one with a `time` leaf
 * type today, so on any other kind this correctly answers "not time-gated" rather than throwing.
 *
 *   timeGated — at least one `time` leaf gates entry
 *   allTime   — EVERY entry leaf is a `time` leaf (a pure scheduled entry: needs no market data,
 *               so it can be monitored regardless of market hours)
 *   after     — the governing (latest) `after` bound in ms, or null
 *
 * See project_timestamp_ideas (Phase 4).
 */

import { resolveConditionTree, extractLeaves } from './conditionTree.service.js'
import { toMs } from '../monitoring/evaluators/time.evaluator.js'

export function entryTimeGate(idea) {
    const tree   = resolveConditionTree(idea?.entry_condition_tree, idea?.entry_conditions, idea?.entry_logic ?? 'AND')
    const leaves = extractLeaves(tree)
    const timeLeaves = leaves.filter(l => l?.type === 'time')
    if (timeLeaves.length === 0) return { timeGated: false, allTime: false, after: null }
    const afters = timeLeaves.map(l => toMs(l?.after)).filter(v => v != null)
    return {
        timeGated: true,
        allTime:   timeLeaves.length === leaves.length,
        after:     afters.length ? Math.max(...afters) : null,
    }
}
