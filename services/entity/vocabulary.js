// ONE home for the vocabulary every entity and every agent speaks: lifecycle statuses, trade
// horizons, and asset classes.
//
// docs/architecture/entity-model.md §7.3 called for "a common lifecycle enum + per-kind extension set" and it was
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
// ONE ladder, spelled the same way by every kind:
//
//   waiting → looking → hit → long|short → closed
//   (created,  monitored,  entry fired,  in position,  terminal)
//
// A kind may use a SUBSET, never a synonym. `resting` is the one kind-specific rung — an idea's
// stop-entry order genuinely sits AT the broker, which is a different thing from being watched.
//
// This is deliberately small. Earlier iterations grew `unarmed`, `watching` and `ready` as second
// spellings of `waiting`, `looking` and `hit`, and every one of them produced the same bug: a gate
// somewhere kept testing the old word and silently matched nothing. Two states that differ only in
// a DETAIL belong in a field, not a status — price being inside a zone is `armed_zone_id`, not a
// lifecycle rung.
//
// A plan that goes stale before it ever enters is NOT a lifecycle state either — that is the
// INVALIDATION axis below, which ideas have always had.

export const STATUS = {
    WAITING:  'waiting',    // created / re-armed — nothing is monitoring it
    LOOKING:  'looking',    // a monitor is watching for entry
    RESTING:  'resting',    // (ideas) a stop-market entry is resting AT the broker
    HIT:      'hit',        // entry triggered — an order is placed or awaiting the user's confirm
    LONG:     'long',
    SHORT:    'short',
    CLOSED:   'closed',     // terminal — `closedReason` says why (expired / dismissed / stopped / …)
}

/**
 * Entry fired, the user is being asked — the state in which confirming actually places orders.
 * placeOrdersForIdea is kind-blind so it gates on this, never on one kind's vocabulary.
 * `ordersPlacedAt` is what prevents a double-place, not the status.
 */
export const AWAITING_CONFIRM = [STATUS.HIT]

/**
 * In a LIVE broker position. This is what the kind-blind reconciler matches on, so the words must
 * be identical across every kind — it was previously spelled out separately as entityRepo's
 * ACTIVE_STATUSES, portfolioState's LIVE_STATUSES and tradeIdeas' LOCKED_DELETE_STATUSES.
 */
export const LIVE_POSITION = [STATUS.LONG, STATUS.SHORT]

/** Past entry: an order exists at the broker, or is awaiting the user's confirm. */
export const PAST_ENTRY = [STATUS.HIT, ...LIVE_POSITION]

/** Alias kept so call sites read as intent. No legacy spellings remain. */
export const PAST_ENTRY_LEGACY = PAST_ENTRY

/** Before entry — nothing at the broker yet, so the entity is freely editable and deletable. */
export const PRE_ENTRY = [STATUS.WAITING, STATUS.LOOKING, STATUS.RESTING]

/**
 * ARMED — a monitor is actively watching this entity. One word now, but shared code must still ask
 * THIS rather than the literal: it is the question ("is anything watching?"), and asking it by name
 * is what stopped `setups.filter(s => s.status === 'looking')` from silently counting zero.
 */
export const ARMED = [STATUS.LOOKING]
export const isArmed = (status) => ARMED.includes(status)

/** Awaiting the user's confirm — kind-blind (see AWAITING_CONFIRM). */
export const isAwaitingConfirm = (status) => AWAITING_CONFIRM.includes(status)

export const TERMINAL = [STATUS.CLOSED]

// ─── Invalidation — the SECOND axis ───────────────────────────────────────────
//
// Orthogonal to the lifecycle: a plan can go stale while it is still perfectly well `looking`.
// Ideas have always had this (a price envelope watched by invalidation.monitor); calls used to
// spend three lifecycle statuses on the same idea — `expiring` / `expired` / `dismissed` — which
// is what made a call's language diverge from every other kind's.
//
// Fire-once latch: set it and the monitor stops re-firing until the user acts. The TRIGGER differs
// by kind (an idea's price envelope, a call's or setup's `valid_until`); the state does not.
export const INVALIDATION = {
    DRIFTING: 'drifting',   // soft — running the wrong way, still alive
    FIRED:    'fired',      // latched — awaiting the user (re-map it, or let it go)
}
/** What tripped it. 'lower'/'upper' are price-envelope edges; 'time' is an expiry window. */
export const INVALIDATION_EDGES = ['lower', 'upper', 'time']
export const isInvalidated = (status) => status === INVALIDATION.FIRED

/**
 * The statuses each kind may hold — SUBSETS of the one ladder, never synonyms.
 *
 *   • idea  — the full ladder. `resting` is idea-only: a stop-market entry actually rests at the
 *     broker, which is materially different from being watched.
 *   • setup — no `resting` (a zone cannot rest as a broker order). Price sitting inside a zone is
 *     `armed_zone_id` on a `looking` setup, not a status of its own.
 *   • call  — same as setup. A thesis going stale pre-entry is the INVALIDATION axis, not a status.
 */
export const STATUSES_BY_KIND = {
    idea:  [STATUS.WAITING, STATUS.LOOKING, STATUS.RESTING, STATUS.HIT, STATUS.LONG, STATUS.SHORT, STATUS.CLOSED],
    setup: [STATUS.WAITING, STATUS.LOOKING, STATUS.HIT, STATUS.LONG, STATUS.SHORT, STATUS.CLOSED],
    call:  [STATUS.WAITING, STATUS.LOOKING, STATUS.HIT, STATUS.LONG, STATUS.SHORT, STATUS.CLOSED],
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

// ─── Entry order types ────────────────────────────────────────────────────────
//
// WHERE an entry waits, which is a different question from what it waits FOR. A resting type
// hands the level to the broker; the absent value leaves the entry on the software monitor.
//
//   • stop  — breakout: the trigger sits BEYOND the current price (above for a long).
//   • limit — pullback: the trigger sits BACK THROUGH it (below for a long).
//
// Both need a bare price level and nothing else, which is exactly what makes them restable —
// so they are one set, not two code paths. A monitored entry is the richer case (indicators,
// news, time, cross-asset), and it stays monitored precisely because a broker can't hold it.
//
// This lives here rather than with the idea kind because two modules already need to agree on
// it — the builder that stamps `entryOrderType` and the executor that reads it back — and they
// import each other, so neither can own the word.
export const RESTING_ENTRY_TYPES = new Set(['stop', 'limit'])

/** Does this entry rest AT the broker (vs. on the software monitor)? */
export const isRestingEntry = (type) => RESTING_ENTRY_TYPES.has(type)

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

// ─── Sectors ──────────────────────────────────────────────────────────────────
//
// The JOIN KEY between research written per name and data read per sector — the Analyst stamps
// `coverage.sector`, and the strategy desk aggregates coverage by sector to cross-check its
// top-down view against our own book. A join needs both sides spelling the sector the same way,
// and left alone they would not: `coverage.sector` was free text from an LLM, matched by exact
// string, against sector rows named by FMP.
//
// CANONICAL = WHAT FMP ACTUALLY RETURNS, probed live 2026-08-06 off /sector-performance-snapshot —
// deliberately not the textbook GICS list, because five of the eleven differ and FMP is the side we
// cannot change. An LLM writing from training knowledge reaches for the GICS spelling every time
// ("Financials", "Health Care", "Consumer Staples"), so those are exactly what the synonym map has
// to absorb. Getting this wrong fails SILENTLY — an empty aggregate reads as "no view", not as an
// error — which is why it is pinned here rather than left to each caller.
export const SECTORS = [
    'Basic Materials', 'Communication Services', 'Consumer Cyclical', 'Consumer Defensive',
    'Energy', 'Financial Services', 'Healthcare', 'Industrials', 'Real Estate', 'Technology',
    'Utilities',
]

// Keyed lowercase; GICS spellings first, then the everyday shorthands.
const SECTOR_SYNONYMS = {
    'basic materials': 'Basic Materials', 'materials': 'Basic Materials',
    'communication services': 'Communication Services', 'communications': 'Communication Services',
    'communication': 'Communication Services', 'telecom': 'Communication Services',
    'telecommunications': 'Communication Services', 'media': 'Communication Services',
    'consumer cyclical': 'Consumer Cyclical', 'consumer discretionary': 'Consumer Cyclical',
    'discretionary': 'Consumer Cyclical', 'consumer cyclicals': 'Consumer Cyclical',
    'consumer defensive': 'Consumer Defensive', 'consumer staples': 'Consumer Defensive',
    'staples': 'Consumer Defensive', 'consumer defensives': 'Consumer Defensive',
    'energy': 'Energy', 'oil & gas': 'Energy', 'oil and gas': 'Energy',
    'financial services': 'Financial Services', 'financials': 'Financial Services',
    'financial': 'Financial Services', 'finance': 'Financial Services', 'banks': 'Financial Services',
    'healthcare': 'Healthcare', 'health care': 'Healthcare', 'health-care': 'Healthcare',
    'health': 'Healthcare', 'medical': 'Healthcare',
    'industrials': 'Industrials', 'industrial': 'Industrials',
    'real estate': 'Real Estate', 'reits': 'Real Estate', 'realestate': 'Real Estate',
    'technology': 'Technology', 'information technology': 'Technology', 'tech': 'Technology',
    'it': 'Technology', 'infotech': 'Technology',
    'utilities': 'Utilities', 'utility': 'Utilities',
}

// Sector/industry separators the Analyst actually reaches for. Checked only AFTER the whole string
// fails to match, so a legitimately hyphenated spelling ("health-care") is never split.
const SECTOR_QUALIFIER = /\s*[/|,;:—–\-(]\s*/

/**
 * Canonicalise a sector to FMP's spelling. Unknown or absent → null, the same contract
 * normalizeAssetClass answers on.
 *
 * TWO PASSES, because the live book showed the model volunteers the industry alongside the sector
 * far more often than it writes the sector alone — "Technology / Semiconductors",
 * "Healthcare — Biotechnology", "Energy / Oil & Gas Equipment & Services". Whole-string matching
 * alone nulled 7 of 17 existing docs, so the second pass takes the LEADING segment, which is where
 * the sector always sits. The extra precision is not lost, it is simply not the join key.
 *
 * NULL IS THE HONEST ANSWER for what survives both passes, and deliberately preferred over passing
 * the raw value through: an unrecognised string joins to nothing, so storing it would preserve the
 * appearance of a sector while keeping the silent-empty-aggregate bug this block exists to close. A
 * bare INDUSTRY ("Semiconductors") nulls for that reason — a real value, but not a sector.
 */
export function normalizeSector(raw) {
    if (!raw || typeof raw !== 'string') return null
    const s = raw.trim().toLowerCase()
    if (SECTOR_SYNONYMS[s]) return SECTOR_SYNONYMS[s]
    const head = s.split(SECTOR_QUALIFIER)[0]?.trim()
    return (head && head !== s) ? (SECTOR_SYNONYMS[head] ?? null) : null
}

/**
 * How a sector is PRICED — the SPDR Select Sector ETF that stands in for it, and SPY for the
 * benchmark. A sector is an abstraction; attribution needs something with a quote, and this is the
 * standard proxy set every desk uses for exactly that.
 *
 * It lives beside the names rather than in the monitor because more than one caller needs it (the
 * grading loop prices a stance; the strategy desk quotes the group it is discussing), and a second
 * copy would be a second chance for a sector to map to the wrong ticker.
 */
export const SECTOR_ETF = {
    'Basic Materials':        'XLB',
    'Communication Services': 'XLC',
    'Consumer Cyclical':      'XLY',
    'Consumer Defensive':     'XLP',
    'Energy':                 'XLE',
    'Financial Services':     'XLF',
    'Healthcare':             'XLV',
    'Industrials':            'XLI',
    'Real Estate':            'XLRE',
    'Technology':             'XLK',
    'Utilities':              'XLU',
}

/** The benchmark a tilt is measured against, by its name on the doc. */
export const BENCHMARK_PROXY = { SPX: 'SPY' }

/** The tradable proxy for a sector (accepts any spelling normalizeSector accepts), or null. */
export const sectorProxy = (raw) => SECTOR_ETF[normalizeSector(raw)] ?? null
