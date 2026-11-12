// Mentor's MODE — ONE WAY since 2026-11-12 (docs/design/argus-rework.md §2.3; history: docs/design/mentor-modes.md).
//
//   thesis — every NEW build: Mentor judges the stop and the target off the structure, the user's numbers set the entry
//            (prompt § How you build every trade). Never named to the user.
//   user   — only a SAVED setup built before 2026-11-12 on its own lens (discretionary · smc · institutional), opened
//            for an edit or a redraw: it keeps that lens and the whole kit, so its levels are revised on the terms they
//            were drawn on (CR 2026-11-12 — forced to thesis, the ledger "restored" its lens every turn).
//
// The one-way KIT is the whole kit minus the pattern and indicator tools (Roy: "leave the news, the fundamentals, the
// chart and the candles"; how a stock behaves is Proteus's). Off the LIST, not just off the prompt: a "don't call it"
// line is ignored now and then, and every declared tool is paid for on every turn.

export const MODE_THESIS = 'thesis'
export const MODE_USER   = 'user'

/** What the risk-based kit leaves out. Every other Mentor tool stays. */
export const THESIS_DROPPED = new Set([
    'get_orderblocks', 'get_false_breaks', 'get_fvg', 'get_liquidity', 'get_structure', 'get_key_levels',
    'get_indicators', 'get_cycle_analysis', 'get_correlations', 'get_peers',
    'get_macro_snapshot', 'get_sector_snapshot', 'get_derivatives_context',
])

/**
 * The tool list for a mode. PURE; the input is not touched.
 *
 * The full kit's tools-cache breakpoint sits on get_derivatives_context, which the risk-based kit drops — so the
 * breakpoint moves to the last tool kept from the shared prefix (`prefixLength` = TRADING_TOOLS.length), or the kit
 * would carry no tools breakpoint at all. Each mode keeps its own cached prefix; a switch costs one cache write.
 */
export function kitFor(mode, tools, prefixLength = tools.length) {
    if (mode !== MODE_THESIS) return tools
    const kept = []
    let lastPrefix = -1
    tools.forEach((t, i) => {
        if (THESIS_DROPPED.has(t.name)) return
        const { cache_control, ...rest } = t
        if (i < prefixLength) lastPrefix = kept.length
        kept.push(rest)
    })
    if (lastPrefix >= 0) kept[lastPrefix] = { ...kept[lastPrefix], cache_control: { type: 'ephemeral' } }
    return kept
}

/** The ledger's lens on the active name — settled first, else the standing claim. PURE. */
export function lensOf(name) {
    return name?.settled?.lens ?? name?.claimed?.lens?.value ?? null
}

/**
 * This turn's mode, and where it came from (argus-rework.md §2.3, Roy: "there is only one lens"):
 *   ledger — a SAVED setup being edited keeps the lens it was built on: its own (`user`, the whole kit) when that is not
 *            the one way's, else the one way;
 *   seed   — a hand-off (the Hotlist, Argus): the one way;
 *   one    — a typed build: the one way.
 * Their own LEVELS are talked through inside the one way; their own METHOD is Daedalus's, coming. PURE (async for the
 * callers that await it).
 */
export async function resolveMode({ name = null, seed = null, editing = false } = {}) {
    const lens = lensOf(name)
    if (lens && editing && lens !== MODE_THESIS) return { mode: MODE_USER, source: 'ledger', lens }
    if (lens) return { mode: MODE_THESIS, source: 'ledger' }
    if (seed?.ticker) return { mode: MODE_THESIS, source: 'seed' }
    return { mode: MODE_THESIS, source: 'one' }
}

/**
 * The handlers the kit allows. Off the LIST is not enough on its own: a model that calls an undeclared tool would still
 * have it run by the handler map, so the risk-based kit drops the handlers too — the call comes back "no handler". PURE.
 */
export function handlersFor(mode, handlers) {
    if (mode !== MODE_THESIS) return handlers
    return Object.fromEntries(Object.entries(handlers).filter(([name]) => !THESIS_DROPPED.has(name)))
}
