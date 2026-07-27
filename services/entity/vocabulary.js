// ONE home for the vocabulary every entity and every agent speaks: lifecycle statuses, trade
// horizons, and asset classes.
//
// ENTITY_MODEL.md §7.3 called for "a common lifecycle enum + per-kind extension set" and it was
// never built, so the words scattered instead: 13 status declarations across 8 files, the SAME
// list `['long','short']` written three times under three different names (ACTIVE_STATUSES,
// LIVE_STATUSES, LOCKED_DELETE_STATUSES), and no canonical asset-class list at all.
//
// The pattern is the same one the tool registry uses: the VOCABULARY is mechanism and lives here;
// which subset a kind or an agent uses is judgment and stays with them. A Kairos call genuinely
// cannot be `long term` — that's a decision about what a call IS, not drift — so it declares its
// subset rather than re-typing the words.

// ─── Lifecycle statuses ───────────────────────────────────────────────────────
//
// Pre-entry vocabulary is kind-specific; from entry onward every kind CONVERGES on the execution
// vocabulary (hit → long/short → closed) so the kind-blind reconciler can match any of them
// (ENTITY_MODEL P3b).

export const STATUS = {
    WAITING:  'waiting',    // created, NOT monitored — arming is a separate user act
    LOOKING:  'looking',    // armed; the monitor is watching for entry
    WATCHING: 'watching',   // (calls) price is inside a mapped zone right now
    RESTING:  'resting',    // (ideas) a stop-market entry is resting at the broker
    HIT:      'hit',        // entry triggered; an order is placed or awaiting confirm
    LONG:     'long',
    SHORT:    'short',
    CLOSED:   'closed',     // terminal
}

// Calls confirmed BEFORE the P3b cutover still carry these; kept so those documents stay
// manageable. New writes never use them.
export const LEGACY_POSITION_STATUSES = ['confirmed', 'in_position']

/**
 * In a LIVE broker position. This is what the kind-blind reconciler matches on, so the words must
 * be identical across every kind — it was previously spelled out separately as entityRepo's
 * ACTIVE_STATUSES, portfolioState's LIVE_STATUSES and tradeIdeas' LOCKED_DELETE_STATUSES.
 */
export const LIVE_POSITION = [STATUS.LONG, STATUS.SHORT]

/** Past entry: an order exists at the broker, or is awaiting the user's confirm. */
export const PAST_ENTRY = [STATUS.HIT, ...LIVE_POSITION]

/** Past entry, including the transitional pre-P3b call statuses. */
export const PAST_ENTRY_LEGACY = [...PAST_ENTRY, ...LEGACY_POSITION_STATUSES]

/** Before entry — still being watched, nothing at the broker yet. */
export const PRE_ENTRY = [STATUS.WAITING, STATUS.LOOKING, STATUS.WATCHING, STATUS.RESTING]

export const TERMINAL = [STATUS.CLOSED]

/**
 * The statuses each kind may hold. Subsets, not separate vocabularies:
 *   • idea  — has `resting` (a stop-market entry can rest at the broker) but no `watching`.
 *   • setup — no `resting` (a zone cannot rest as a broker order) and no `watching` (the card
 *     fires on any verdict, so a zone trip resolves to `hit` in the same wake).
 *   • call  — has `watching` (price inside a mapped zone) plus the legacy pair.
 */
export const STATUSES_BY_KIND = {
    idea:  [STATUS.WAITING, STATUS.LOOKING, STATUS.RESTING, STATUS.HIT, STATUS.LONG, STATUS.SHORT, STATUS.CLOSED],
    setup: [STATUS.WAITING, STATUS.LOOKING, STATUS.HIT, STATUS.LONG, STATUS.SHORT, STATUS.CLOSED],
    call:  [STATUS.WAITING, STATUS.WATCHING, STATUS.HIT, STATUS.LONG, STATUS.SHORT, STATUS.CLOSED,
        ...LEGACY_POSITION_STATUSES],
}

export const statusesFor = (kind) => STATUSES_BY_KIND[kind] ?? []
export const isValidStatus = (kind, status) => statusesFor(kind).includes(status)

/** In a live position right now. */
export const isLivePosition = (status) => LIVE_POSITION.includes(status)

/** Past entry — `includeLegacy` covers pre-P3b calls. */
export const isPastEntry = (status, includeLegacy = true) =>
    (includeLegacy ? PAST_ENTRY_LEGACY : PAST_ENTRY).includes(status)

/** Terminal: no further transition is legal. A closed entity must never be resurrected. */
export const isTerminal = (status) => TERMINAL.includes(status)

// ─── Trade horizons ───────────────────────────────────────────────────────────
//
// One ladder, coarse→fine in holding period. Agents take a SUBSET where their remit is narrower.

export const TRADE_HORIZONS = ['intraday', 'day', 'swing', 'long term']

/**
 * Kairos builds day/swing CALLS — a call is a moment to act on, not a multi-month hold, and its
 * prompt says so ("intraday / day / swing; never scalping"). The narrowing is deliberate, so it
 * is declared as a subset of the shared ladder instead of a second literal that merely looks
 * like the first minus one entry.
 */
export const CALL_HORIZONS = TRADE_HORIZONS.filter(h => h !== 'long term')

export const isHorizon = (h) => TRADE_HORIZONS.includes(h)

// ─── Asset classes ────────────────────────────────────────────────────────────
//
// The agents emit these; market hours, event risk and the monitors all branch on them. There was
// no canonical list, so each consumer grew its own synonym map (market.service accepted
// stock/stocks/equity/equities/etf; eventRisk accepted equity/stock/stocks/etf) and nothing
// normalised the value at the entity boundary — an agent emitting "Equity " stored it verbatim.
//
// Normalising ONCE on the way in beats every consumer absorbing the drift defensively.

export const ASSET_CLASSES = ['stock', 'etf', 'futures', 'forex', 'crypto']

const ASSET_CLASS_SYNONYMS = {
    stock: 'stock', stocks: 'stock', equity: 'stock', equities: 'stock', share: 'stock', shares: 'stock',
    etf: 'etf', etfs: 'etf', fund: 'etf',
    future: 'futures', futures: 'futures',
    forex: 'forex', fx: 'forex', currency: 'forex', currencies: 'forex',
    crypto: 'crypto', cryptocurrency: 'crypto', cryptocurrencies: 'crypto', coin: 'crypto',
}

/**
 * Canonicalise an agent-emitted asset class. Unknown or absent → null, which every consumer
 * already treats as "fall back to the symbol heuristic" — so an unrecognised value degrades to
 * the same safe path rather than being stored as a word nothing matches.
 */
export function normalizeAssetClass(raw) {
    if (!raw || typeof raw !== 'string') return null
    return ASSET_CLASS_SYNONYMS[raw.trim().toLowerCase()] ?? null
}

/** Equity-like (stock or ETF) — earnings, short interest and options only exist here. */
export const isEquityClass = (raw) => {
    const c = normalizeAssetClass(raw)
    return c === 'stock' || c === 'etf'
}
