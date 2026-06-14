/**
 * Single source of truth for condition-tree structure handling.
 *
 * A condition tree is built from two kinds of node:
 *   - Group node:  { operator: 'AND'|'OR', children: [node, …] }
 *   - Leaf node:   { condition: string, type, timeframe, symbol?, quantity? }
 *
 * Two legacy shapes are still accepted on read and migrated on the way in:
 *   - Old group:   { logic, conditions: [node, …] }
 *   - Flat array:  [leaf, …]  (no enclosing group)
 *
 * Evaluation lives in monitoring/monitor.orchestrator.js — this module only
 * concerns the *structure* (resolve, normalise, traverse).
 */

import { normalizeTimeframe } from './timeframe.service.js'

/**
 * Normalise a condition input into a canonical group node { operator, children }.
 * Handles new tree nodes, bare leaves, the old { logic, conditions } shape, and
 * legacy flat arrays. Returns null when there are no conditions.
 *
 * @param {object|null} treeNode   New/old tree node (preferred source)
 * @param {Array|null}  flatArray  Legacy flat leaf array (fallback source)
 * @param {'AND'|'OR'}  defaultOperator
 * @returns {{ operator: string, children: object[] } | null}
 */
export function resolveConditionTree(treeNode, flatArray, defaultOperator = 'AND') {
    // New tree group node: { operator, children }
    if (treeNode && typeof treeNode === 'object' && !Array.isArray(treeNode)) {
        if (treeNode.operator && Array.isArray(treeNode.children) && treeNode.children.length > 0) {
            return treeNode
        }
        // Bare leaf node — wrap in a single-child group
        if (typeof treeNode.condition === 'string') {
            return { operator: defaultOperator, children: [treeNode] }
        }
        // Old format: { logic, conditions }
        if (Array.isArray(treeNode.conditions) && treeNode.conditions.length > 0) {
            return { operator: treeNode.logic ?? defaultOperator, children: treeNode.conditions }
        }
    }
    // Legacy flat array
    if (Array.isArray(flatArray) && flatArray.length > 0) {
        return { operator: defaultOperator, children: flatArray }
    }
    return null
}

/** Recursively collect all leaf condition objects from a tree (children only). */
export function extractLeaves(node) {
    if (!node) return []
    if (typeof node.condition === 'string') return [node]
    if (Array.isArray(node.children)) return node.children.flatMap(extractLeaves)
    return []
}

/** Return the top-level operator of a group node, or null. */
export function topOperator(node) {
    return node?.operator ?? null
}

/**
 * Return the first leaf node found in a tree (depth-first), regardless of its
 * timeframe. Walks both canonical `children` and legacy `conditions` arrays.
 * @returns {object|null}
 */
export function firstLeaf(node) {
    if (!node || typeof node !== 'object') return null
    if (typeof node.condition === 'string') return node
    const branches = Array.isArray(node.children) ? node.children
        : Array.isArray(node.conditions) ? node.conditions
        : null
    if (branches) {
        for (const child of branches) {
            const found = firstLeaf(child)
            if (found) return found
        }
    }
    return null
}

/**
 * Find the first *non-empty* normalised timeframe among the tree's leaves
 * (depth-first). Used to propagate a default timeframe through a tree.
 * Differs from `firstLeaf().timeframe`: it skips leaves whose timeframe is
 * missing and keeps searching.
 * @returns {string|null}
 */
export function firstLeafTimeframe(node) {
    if (!node || typeof node !== 'object') return null
    if (typeof node.condition === 'string') return normalizeTimeframe(node.timeframe) || null
    const branches = Array.isArray(node.children) ? node.children
        : Array.isArray(node.conditions) ? node.conditions
        : null
    if (branches) {
        for (const child of branches) {
            const tf = firstLeafTimeframe(child)
            if (tf) return tf
        }
    }
    return null
}

/**
 * Recursively normalise timeframe strings in a condition tree node.
 * Leaf nodes get their timeframe normalised (falling back to defaultTf); group
 * nodes are passed through, and the old { logic, conditions } shape is migrated
 * to { operator, children }.
 *
 * @param {object} node
 * @param {string|null} defaultTf  fallback timeframe for leaves missing one
 */
export function normalizeTreeNode(node, defaultTf) {
    if (!node || typeof node !== 'object') return node

    // Leaf node
    if (typeof node.condition === 'string') {
        const leaf = {
            ...node,
            timeframe: normalizeTimeframe(node.timeframe) || defaultTf || null,
        }
        if (node.quantity != null) leaf.quantity = Number(node.quantity) || null
        return leaf
    }

    // Group node: { operator, children }
    if (node.operator && Array.isArray(node.children)) {
        return {
            operator: node.operator,
            children: node.children.map(child => normalizeTreeNode(child, defaultTf)),
        }
    }

    // Old format migration: { logic, conditions }
    if (Array.isArray(node.conditions)) {
        return {
            operator: node.logic ?? 'AND',
            children: node.conditions.map(child => normalizeTreeNode(child, defaultTf)),
        }
    }

    return node
}

/**
 * Collect every distinct cross-asset symbol referenced in a condition set,
 * from both the tree and a legacy flat-array form. The traded (default) asset
 * is not special-cased here — callers skip it when building a symbol map.
 *
 * @param {object|null} tree
 * @param {Array|null}  flatConditions
 * @returns {Set<string>}
 */
export function collectSymbols(tree, flatConditions) {
    const symbols = new Set()
    if (tree) _walkSymbols(tree, symbols)
    if (Array.isArray(flatConditions)) {
        flatConditions.forEach(c => { if (c?.symbol) symbols.add(c.symbol) })
    }
    return symbols
}

function _walkSymbols(node, symbols) {
    if (!node) return
    if (typeof node.condition === 'string') {
        if (node.symbol) symbols.add(node.symbol)
        return
    }
    if (Array.isArray(node.children)) node.children.forEach(c => _walkSymbols(c, symbols))
}
