// Mentor's two MODES (docs/design/mentor-modes.md, Roy 2026-11-01).
//
//   thesis — RISK-BASED, the default: the user brought no setup of their own. Mentor judges the stop and the target
//            off the structure and the user's risk sets the entry (prompt § The thesis lens).
//   user   — THE USER'S SETUP: they brought an idea or a plan, finished or half-made, and Mentor builds it in their
//            terms under the lens it recommends (discretionary · smc · institutional).
//
// THE MODE IS THE LENS. No field of its own: `thesis` on the ledger is risk-based, any other lens is the user's
// setup. Only before a lens exists is there anything to work out — a seeded build (the Hotlist, Argus) carries no
// setup by definition, and a TYPED first message is read by one cheap call, because the tool kit has to be picked
// before the desk's model reads a word of it.
//
// The risk-based KIT is the whole kit minus the pattern and indicator tools (Roy: "leave the news, the fundamentals,
// the chart and the candles"; then keep analyst actions, short interest, options, the price-action snapshot and the
// flip test — "they might help Mentor choose stops and targets"). Off the LIST, not just off the prompt: a "don't
// call it" line is ignored now and then, and every declared tool is paid for on every turn.

import { callAnthropicOnce } from '../providers/anthropic.provider.js'
import { CHEAP_MODEL } from './llmModels.js'
import { recordUsage } from './tokenUsage.service.js'
import { logger } from './logger.service.js'

const LOG = '[mentorMode]'

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

const SYSTEM = [
    'You read ONE message a trader sent to a trade-building desk and answer one question: did they bring a SETUP of',
    'their own? A setup is ANY condition, price level or chart pattern / indicator of theirs — an entry, a stop, a',
    'target, "on a pullback to the 50-day", "the breakout over 50", "if it reclaims VWAP", "the order block at 212".',
    'A ticker alone, a direction alone (long / short / buy), a horizon alone (day trade, swing, long term), or a',
    'request to build / look at / plan a trade is NOT a setup. Answer with one word: SETUP or NONE.',
].join(' ')

/** The text of the user's last few messages, newest last — what the read is about. PURE. */
export function _userText(messages, last = 3) {
    const text = (c) => (typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join(' ') : '')
    return (Array.isArray(messages) ? messages : [])
        .filter(m => m?.role === 'user')
        .slice(-last)
        .map(m => text(m.content).trim())
        .filter(Boolean)
        .join('\n---\n')
}

/** The read must not hold the turn: past this it is undecided, and the turn goes on with the whole kit. */
export const READ_TIMEOUT_MS = 8000

export function makeSetupReader({ once = callAnthropicOnce, record = recordUsage, model = CHEAP_MODEL, timeoutMs = READ_TIMEOUT_MS } = {}) {
    /** SETUP → 'user', NONE → 'thesis'; null when the read failed, timed out, was aborted or said neither. */
    return async function readSetup({ messages, userId = null, signal = null }) {
        const user = _userText(messages)
        if (!user || signal?.aborted) return null
        let timer
        try {
            const call = once({
                model, systemPrompt: SYSTEM, user, maxTokens: 8,
                onUsage: userId ? (usage, m) => { record(userId, m, usage, 'mentor').catch(() => {}) } : undefined,
            })
            const late = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs) })
            const out = await Promise.race([call, late])
            if (out === TIMED_OUT) { logger.warn(LOG, `setup read timed out after ${timeoutMs}ms (the desk decides from the prompt)`); return null }
            if (signal?.aborted) return null
            const word = String(out ?? '').trim().toUpperCase()
            if (word.startsWith('SETUP')) return MODE_USER
            if (word.startsWith('NONE'))  return MODE_THESIS
            logger.warn(LOG, 'setup read answered neither', { out: String(out ?? '').slice(0, 40) })
            return null
        } catch (err) {
            logger.warn(LOG, 'setup read failed (the desk decides from the prompt)', err.message)
            return null
        } finally {
            clearTimeout(timer)
        }
    }
}

const TIMED_OUT = Symbol('timed out')

export const readSetup = makeSetupReader()

/**
 * This turn's mode, and where it came from. ONE WAY since 2026-11-12 (argus-rework.md §2.3, Roy: "no need to use the
 * term lens anymore because there is only one lens"): every build is the `thesis` build — the user's own METHOD is
 * Daedalus's, coming; their own LEVELS are talked through inside the one way. No cheap read of the user's words any more
 * (`read` and `messages` are kept in the signature for the callers and tests that pass them).
 *
 *   ledger — the build already carries its lens (a saved setup being edited): kept as the source.
 *   seed   — a hand-off (the Hotlist, Argus).
 *   one    — a typed build: the one way.
 */
export async function resolveMode({ name = null, seed = null } = {}) {
    if (lensOf(name)) return { mode: MODE_THESIS, source: 'ledger' }
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
