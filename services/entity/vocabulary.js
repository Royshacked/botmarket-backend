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
// a DETAIL belong in a field, not a status — price being inside a zone is `armed_leg_id`, not a
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
 *     `armed_leg_id` on a `looking` setup, not a status of its own.
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

/** Past entry: an order exists at the broker, or is awaiting the user's confirm. */
export const isPastEntry = (status) => PAST_ENTRY.includes(status)

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
 * The GRAINS a view can be held at. FMP gives two levels, and its `industry` is already
 * sub-industry fine — `Gold`, `Copper`, `Steel`, `Semiconductors`, `Banks - Regional` and
 * `REIT - Mortgage` are all first-class industries there. A third level would have no vocabulary
 * behind it and nothing to screen with, so there are two.
 */
export const GRAINS = ['sector', 'industry']

/**
 * Every industry the screener knows, keyed to the sector that owns it. Derived from FMP's own
 * `/available-industries` and `/company-screener` on 2026-09-30: 155 of 159 industries, each
 * resolving to exactly ONE sector, with no ambiguous case in the panel.
 *
 * The four left out — `Financial - Diversified`, `Industrial - Capital Goods`,
 * `Real Estate - General`, `General Utilities` — have no actively trading companies at all.
 * Nothing to screen and nothing to price, so a stance on one could be neither handed to Argus nor
 * graded, which makes it a sentence rather than a view.
 *
 * FMP's spellings rather than GICS's, for the reason SECTORS gives and one that weighs more here:
 * a stance written in this vocabulary is a screen Argus can run unchanged. Any other vocabulary
 * needs a mapping layer, and a mapping layer drifts.
 */
export const INDUSTRY_SECTOR = {
    // Basic Materials
    "Steel": "Basic Materials",
    "Silver": "Basic Materials",
    "Other Precious Metals": "Basic Materials",
    "Gold": "Basic Materials",
    "Copper": "Basic Materials",
    "Aluminum": "Basic Materials",
    "Paper, Lumber & Forest Products": "Basic Materials",
    "Industrial Materials": "Basic Materials",
    "Construction Materials": "Basic Materials",
    "Chemicals - Specialty": "Basic Materials",
    "Chemicals": "Basic Materials",
    "Agricultural Inputs": "Basic Materials",
    // Communication Services
    "Telecommunications Services": "Communication Services",
    "Internet Content & Information": "Communication Services",
    "Publishing": "Communication Services",
    "Broadcasting": "Communication Services",
    "Advertising Agencies": "Communication Services",
    "Entertainment": "Communication Services",
    // Consumer Cyclical
    "Travel Lodging": "Consumer Cyclical",
    "Travel Services": "Consumer Cyclical",
    "Specialty Retail": "Consumer Cyclical",
    "Luxury Goods": "Consumer Cyclical",
    "Home Improvement": "Consumer Cyclical",
    "Residential Construction": "Consumer Cyclical",
    "Department Stores": "Consumer Cyclical",
    "Personal Products & Services": "Consumer Cyclical",
    "Leisure": "Consumer Cyclical",
    "Gambling, Resorts & Casinos": "Consumer Cyclical",
    "Furnishings, Fixtures & Appliances": "Consumer Cyclical",
    "Restaurants": "Consumer Cyclical",
    "Auto - Parts": "Consumer Cyclical",
    "Auto - Manufacturers": "Consumer Cyclical",
    "Auto - Recreational Vehicles": "Consumer Cyclical",
    "Auto - Dealerships": "Consumer Cyclical",
    "Apparel - Retail": "Consumer Cyclical",
    "Apparel - Manufacturers": "Consumer Cyclical",
    "Apparel - Footwear & Accessories": "Consumer Cyclical",
    "Packaging & Containers": "Consumer Cyclical",
    // Consumer Defensive
    "Tobacco": "Consumer Defensive",
    "Grocery Stores": "Consumer Defensive",
    "Discount Stores": "Consumer Defensive",
    "Household & Personal Products": "Consumer Defensive",
    "Packaged Foods": "Consumer Defensive",
    "Food Distribution": "Consumer Defensive",
    "Food Confectioners": "Consumer Defensive",
    "Agricultural Farm Products": "Consumer Defensive",
    "Education & Training Services": "Consumer Defensive",
    "Beverages - Wineries & Distilleries": "Consumer Defensive",
    "Beverages - Non-Alcoholic": "Consumer Defensive",
    "Beverages - Alcoholic": "Consumer Defensive",
    // Energy
    "Uranium": "Energy",
    "Solar": "Energy",
    "Oil & Gas Refining & Marketing": "Energy",
    "Oil & Gas Midstream": "Energy",
    "Oil & Gas Integrated": "Energy",
    "Oil & Gas Exploration & Production": "Energy",
    "Oil & Gas Equipment & Services": "Energy",
    "Oil & Gas Energy": "Energy",
    "Oil & Gas Drilling": "Energy",
    "Coal": "Energy",
    // Financial Services
    "Shell Companies": "Financial Services",
    "Investment - Banking & Investment Services": "Financial Services",
    "Insurance - Specialty": "Financial Services",
    "Insurance - Reinsurance": "Financial Services",
    "Insurance - Property & Casualty": "Financial Services",
    "Insurance - Life": "Financial Services",
    "Insurance - Diversified": "Financial Services",
    "Insurance - Brokers": "Financial Services",
    "Financial - Mortgages": "Financial Services",
    "Financial - Data & Stock Exchanges": "Financial Services",
    "Financial - Credit Services": "Financial Services",
    "Financial - Conglomerates": "Financial Services",
    "Financial - Capital Markets": "Financial Services",
    "Banks - Regional": "Financial Services",
    "Banks - Diversified": "Financial Services",
    "Banks": "Financial Services",
    "Asset Management": "Financial Services",
    "Asset Management - Bonds": "Financial Services",
    "Asset Management - Income": "Financial Services",
    "Asset Management - Leveraged": "Financial Services",
    "Asset Management - Cryptocurrency": "Financial Services",
    "Asset Management - Global": "Financial Services",
    // Healthcare
    "Medical - Specialties": "Healthcare",
    "Medical - Pharmaceuticals": "Healthcare",
    "Medical - Instruments & Supplies": "Healthcare",
    "Medical - Healthcare Plans": "Healthcare",
    "Medical - Healthcare Information Services": "Healthcare",
    "Medical - Equipment & Services": "Healthcare",
    "Medical - Distribution": "Healthcare",
    "Medical - Diagnostics & Research": "Healthcare",
    "Medical - Devices": "Healthcare",
    "Medical - Care Facilities": "Healthcare",
    "Drug Manufacturers - Specialty & Generic": "Healthcare",
    "Drug Manufacturers - General": "Healthcare",
    "Biotechnology": "Healthcare",
    // Industrials
    "Waste Management": "Industrials",
    "Trucking": "Industrials",
    "Railroads": "Industrials",
    "Aerospace & Defense": "Industrials",
    "Marine Shipping": "Industrials",
    "Integrated Freight & Logistics": "Industrials",
    "Airlines, Airports & Air Services": "Industrials",
    "General Transportation": "Industrials",
    "Manufacturing - Tools & Accessories": "Industrials",
    "Manufacturing - Textiles": "Industrials",
    "Manufacturing - Miscellaneous": "Industrials",
    "Manufacturing - Metal Fabrication": "Industrials",
    "Industrial - Distribution": "Industrials",
    "Industrial - Specialties": "Industrials",
    "Industrial - Pollution & Treatment Controls": "Industrials",
    "Environmental Services": "Industrials",
    "Industrial - Machinery": "Industrials",
    "Industrial - Infrastructure Operations": "Industrials",
    "Consulting Services": "Industrials",
    "Business Equipment & Supplies": "Industrials",
    "Staffing & Employment Services": "Industrials",
    "Rental & Leasing Services": "Industrials",
    "Engineering & Construction": "Industrials",
    "Security & Protection Services": "Industrials",
    "Specialty Business Services": "Industrials",
    "Construction": "Industrials",
    "Conglomerates": "Industrials",
    "Electrical Equipment & Parts": "Industrials",
    "Agricultural - Machinery": "Industrials",
    "Agricultural - Commodities/Milling": "Industrials",
    // Real Estate
    "REIT - Specialty": "Real Estate",
    "REIT - Retail": "Real Estate",
    "REIT - Residential": "Real Estate",
    "REIT - Office": "Real Estate",
    "REIT - Mortgage": "Real Estate",
    "REIT - Industrial": "Real Estate",
    "REIT - Hotel & Motel": "Real Estate",
    "REIT - Healthcare Facilities": "Real Estate",
    "REIT - Diversified": "Real Estate",
    "Real Estate - Services": "Real Estate",
    "Real Estate - Diversified": "Real Estate",
    "Real Estate - Development": "Real Estate",
    // Technology
    "Information Technology Services": "Technology",
    "Hardware, Equipment & Parts": "Technology",
    "Computer Hardware": "Technology",
    "Electronic Gaming & Multimedia": "Technology",
    "Software - Services": "Technology",
    "Software - Infrastructure": "Technology",
    "Software - Application": "Technology",
    "Semiconductors": "Technology",
    "Media & Entertainment": "Technology",
    "Communication Equipment": "Technology",
    "Technology Distributors": "Technology",
    "Consumer Electronics": "Technology",
    // Utilities
    "Renewable Utilities": "Utilities",
    "Regulated Water": "Utilities",
    "Regulated Gas": "Utilities",
    "Regulated Electric": "Utilities",
    "Independent Power Producers": "Utilities",
    "Diversified Utilities": "Utilities",
}

/** Every industry name, in FMP's own spelling. */
export const INDUSTRIES = Object.freeze(Object.keys(INDUSTRY_SECTOR))

const _INDUSTRY_BY_LOWER = new Map(INDUSTRIES.map(i => [i.toLowerCase(), i]))

// The shorthands a desk actually reaches for. Deliberately thin: FMP's spelling IS the vocabulary,
// and every alias here is one more place the two can drift apart.
const INDUSTRY_SYNONYMS = {
    'semis': 'Semiconductors', 'semiconductor': 'Semiconductors',
    'biotech': 'Biotechnology',
    'homebuilders': 'Residential Construction', 'homebuilding': 'Residential Construction',
    'regional banks': 'Banks - Regional',
    'gold miners': 'Gold', 'copper miners': 'Copper',
    'airlines': 'Airlines, Airports & Air Services',
    'e&p': 'Oil & Gas Exploration & Production',
    'oil services': 'Oil & Gas Equipment & Services',
    'midstream': 'Oil & Gas Midstream',
    'mortgage reits': 'REIT - Mortgage',
    'medical devices': 'Medical - Devices',
    'pharma': 'Medical - Pharmaceuticals', 'pharmaceuticals': 'Medical - Pharmaceuticals',
    'aerospace': 'Aerospace & Defense', 'defense': 'Aerospace & Defense',
}

/**
 * An industry from the vocabulary, or null. Matched on the WHOLE string.
 *
 * Deliberately NOT normalizeSector's qualifier split, and that difference is load-bearing. This
 * module takes the HEAD of a qualified string when resolving a sector, which is right when a
 * provider hands back `Technology - Semiconductors` and the answer wanted is Technology — and
 * catastrophic here, where the tail is the entire point. An industry resolved through it would
 * silently publish a semis call as a bet on all of Technology.
 */
export function normalizeIndustry(raw) {
    if (!raw || typeof raw !== 'string') return null
    const s = raw.trim().toLowerCase()
    const whole = _INDUSTRY_BY_LOWER.get(s) ?? INDUSTRY_SYNONYMS[s]
    if (whole) return whole

    // A QUALIFIED string ("Technology - Semiconductors") names its sector and then narrows it, so
    // the tail is the claim and the head is context. Tried only after the whole string fails, so a
    // legitimately hyphenated name ("Banks - Regional", "Oil & Gas Midstream") is never split.
    //
    // The tail is tried before the sector fallback deliberately. Reading the HEAD of that string —
    // which is what normalizeSector does, correctly, for its own purpose — would answer Technology
    // to a sentence whose subject is semiconductors.
    const tail = s.split(SECTOR_QUALIFIER).slice(1).join(' ').trim()
    return (tail && (_INDUSTRY_BY_LOWER.get(tail) ?? INDUSTRY_SYNONYMS[tail])) || null
}

/**
 * What a view is held ON, at whichever grain it is held → `{ grain, bucket }`, or null. Pure.
 *
 * INDUSTRY FIRST, and the order is the whole function. A row naming an industry has to resolve to
 * that industry; falling through to its sector would publish a bet on many times more of the
 * market than the author wrote, priced against the wrong fund, with nothing downstream able to
 * tell the difference.
 */
export function resolveBucket(raw) {
    const industry = normalizeIndustry(raw)
    if (industry) return { grain: 'industry', bucket: industry }
    const sector = normalizeSector(raw)
    return sector ? { grain: 'sector', bucket: sector } : null
}

/** The sector that owns a bucket — itself when the bucket IS a sector. Null when unrecognised. */
export function parentSector(raw) {
    const r = resolveBucket(raw)
    if (!r) return null
    return r.grain === 'sector' ? r.bucket : (INDUSTRY_SECTOR[r.bucket] ?? null)
}

/**
 * How a bucket is PRICED — ONE table across both grains, because a stance is graded the same way
 * whichever grain it sits at, and a second table would be a second chance to map a bucket to the
 * wrong ticker. Sectors are the SPDR Select Sector funds; industries are the nearest liquid fund.
 *
 * `weighting` and `exact` are recorded rather than assumed, because each distorts a grade in a way
 * that is invisible once it is booked:
 *   - `weighting: 'equal'` graded against a cap-weighted benchmark books part of a size factor as
 *     an industry call. Where a cap-weighted twin exists it is taken (IBB over XBI, SMH over XSD,
 *     ITB over XHB); where none does, the row carries the caveat instead of pretending.
 *   - `exact: false` means the fund spans more than this one industry — IGV is all software, KIE
 *     every insurance line. The bucket named and the thing graded are then near, not equal.
 *
 * Every symbol here was fetched through fetchLastPrice on 2026-09-30.
 */
export const BUCKET_PROXY = {
    // sectors — SPDR Select Sector, cap-weighted, and exact by construction
    'Basic Materials':        { symbol: 'XLB',  weighting: 'cap', exact: true },
    'Communication Services': { symbol: 'XLC',  weighting: 'cap', exact: true },
    'Consumer Cyclical':      { symbol: 'XLY',  weighting: 'cap', exact: true },
    'Consumer Defensive':     { symbol: 'XLP',  weighting: 'cap', exact: true },
    'Energy':                 { symbol: 'XLE',  weighting: 'cap', exact: true },
    'Financial Services':     { symbol: 'XLF',  weighting: 'cap', exact: true },
    'Healthcare':             { symbol: 'XLV',  weighting: 'cap', exact: true },
    'Industrials':            { symbol: 'XLI',  weighting: 'cap', exact: true },
    'Real Estate':            { symbol: 'XLRE', weighting: 'cap', exact: true },
    'Technology':             { symbol: 'XLK',  weighting: 'cap', exact: true },
    'Utilities':              { symbol: 'XLU',  weighting: 'cap', exact: true },

    // industries
    'Semiconductors':                     { symbol: 'SMH',  weighting: 'cap',   exact: true },
    'Software - Infrastructure':          { symbol: 'IGV',  weighting: 'cap',   exact: false },
    'Software - Application':             { symbol: 'XSW',  weighting: 'equal', exact: false },
    'Internet Content & Information':     { symbol: 'FDN',  weighting: 'cap',   exact: false },
    'Biotechnology':                      { symbol: 'IBB',  weighting: 'cap',   exact: true },
    'Medical - Devices':                  { symbol: 'IHI',  weighting: 'cap',   exact: true },
    'Medical - Pharmaceuticals':          { symbol: 'XPH',  weighting: 'equal', exact: true },
    'Medical - Care Facilities':          { symbol: 'IHF',  weighting: 'cap',   exact: false },
    'Banks - Regional':                   { symbol: 'KRE',  weighting: 'equal', exact: true },
    'Banks - Diversified':                { symbol: 'KBWB', weighting: 'cap',   exact: false },
    'Insurance - Property & Casualty':    { symbol: 'KIE',  weighting: 'equal', exact: false },
    'Financial - Capital Markets':        { symbol: 'IAI',  weighting: 'cap',   exact: false },
    // IEO over XOP: the cap-weighted twin, same rule as IBB over XBI.
    'Oil & Gas Exploration & Production': { symbol: 'IEO',  weighting: 'cap',   exact: true },
    'Oil & Gas Equipment & Services':     { symbol: 'OIH',  weighting: 'cap',   exact: true },
    'Oil & Gas Midstream':                { symbol: 'AMLP', weighting: 'cap',   exact: true },
    'Gold':                               { symbol: 'GDX',  weighting: 'cap',   exact: true },
    'Copper':                             { symbol: 'COPX', weighting: 'cap',   exact: true },
    'Steel':                              { symbol: 'SLX',  weighting: 'cap',   exact: true },
    'Residential Construction':           { symbol: 'ITB',  weighting: 'cap',   exact: true },
    'Specialty Retail':                   { symbol: 'XRT',  weighting: 'equal', exact: false },
    'Aerospace & Defense':                { symbol: 'ITA',  weighting: 'cap',   exact: true },
    'Airlines, Airports & Air Services':  { symbol: 'JETS', weighting: 'cap',   exact: true },
    'REIT - Mortgage':                    { symbol: 'REM',  weighting: 'cap',   exact: true },
    'REIT - Residential':                 { symbol: 'REZ',  weighting: 'cap',   exact: false },
    'REIT - Industrial':                  { symbol: 'INDS', weighting: 'cap',   exact: true },
    'Telecommunications Services':        { symbol: 'XTL',  weighting: 'equal', exact: false },

    // Added 2026-09-30 after an all-155 probe showed 129 industries graded on their SECTOR's fund —
    // an industry call scored exactly like a sector call. Each fund was checked live for AUM and
    // volume; fit is judged from the fund's mandate (FMP's holdings endpoint is not on our plan).
    //
    // ONE FUND MAY STAND FOR SEVERAL INDUSTRIES here, and every such row is `exact: false`. A stance
    // on Railroads graded on IYT is partly a transport call; that is still closer to the bet than
    // XLI, and the row says which fund it was. Small funds (under ~$0.4B, or thin volume) are kept
    // on purpose and marked in the comment: noisier tracking beats grading on the wrong layer.
    'Silver':                             { symbol: 'SIL',  weighting: 'cap',   exact: true },
    'Other Precious Metals':              { symbol: 'XME',  weighting: 'equal', exact: false },
    'Aluminum':                           { symbol: 'XME',  weighting: 'equal', exact: false },
    'Industrial Materials':               { symbol: 'XME',  weighting: 'equal', exact: false },
    'Paper, Lumber & Forest Products':    { symbol: 'WOOD', weighting: 'cap',   exact: false },  // small, global
    'Agricultural Inputs':                { symbol: 'MOO',  weighting: 'cap',   exact: false },
    'Agricultural Farm Products':         { symbol: 'MOO',  weighting: 'cap',   exact: false },
    'Agricultural - Machinery':           { symbol: 'MOO',  weighting: 'cap',   exact: false },

    'Uranium':                            { symbol: 'URNM', weighting: 'cap',   exact: true },
    'Solar':                              { symbol: 'TAN',  weighting: 'cap',   exact: true },
    'Oil & Gas Refining & Marketing':     { symbol: 'CRAK', weighting: 'cap',   exact: false },  // global
    'Oil & Gas Drilling':                 { symbol: 'XES',  weighting: 'equal', exact: false },  // small

    'Banks':                              { symbol: 'KBE',  weighting: 'equal', exact: false },
    'Asset Management':                   { symbol: 'KCE',  weighting: 'equal', exact: false },
    'Investment - Banking & Investment Services': { symbol: 'KCE', weighting: 'equal', exact: false },
    'Financial - Data & Stock Exchanges': { symbol: 'KCE',  weighting: 'equal', exact: false },
    'Insurance - Life':                   { symbol: 'KIE',  weighting: 'equal', exact: false },
    'Insurance - Reinsurance':            { symbol: 'KIE',  weighting: 'equal', exact: false },
    'Insurance - Brokers':                { symbol: 'KIE',  weighting: 'equal', exact: false },
    'Insurance - Specialty':              { symbol: 'KIE',  weighting: 'equal', exact: false },
    'Insurance - Diversified':            { symbol: 'KIE',  weighting: 'equal', exact: false },
    'Financial - Credit Services':        { symbol: 'IPAY', weighting: 'cap',   exact: false },  // small, payments

    'Drug Manufacturers - General':       { symbol: 'IHE',  weighting: 'cap',   exact: true },
    'Medical - Healthcare Plans':         { symbol: 'IHF',  weighting: 'cap',   exact: false },
    'Medical - Distribution':             { symbol: 'IHF',  weighting: 'cap',   exact: false },
    'Medical - Instruments & Supplies':   { symbol: 'IHI',  weighting: 'cap',   exact: false },
    'Medical - Equipment & Services':     { symbol: 'IHI',  weighting: 'cap',   exact: false },

    'Railroads':                          { symbol: 'IYT',  weighting: 'cap',   exact: false },
    'Trucking':                           { symbol: 'IYT',  weighting: 'cap',   exact: false },
    'Integrated Freight & Logistics':     { symbol: 'IYT',  weighting: 'cap',   exact: false },
    'General Transportation':             { symbol: 'IYT',  weighting: 'cap',   exact: false },
    'Marine Shipping':                    { symbol: 'BOAT', weighting: 'cap',   exact: false },  // small, global
    'Waste Management':                   { symbol: 'EVX',  weighting: 'equal', exact: false },  // small, thin
    'Environmental Services':             { symbol: 'EVX',  weighting: 'equal', exact: false },  // small, thin
    'Engineering & Construction':         { symbol: 'PAVE', weighting: 'cap',   exact: false },
    'Industrial - Infrastructure Operations': { symbol: 'PAVE', weighting: 'cap', exact: false },
    'Construction':                       { symbol: 'PAVE', weighting: 'cap',   exact: false },
    'Construction Materials':             { symbol: 'PAVE', weighting: 'cap',   exact: false },
    'Electrical Equipment & Parts':       { symbol: 'GRID', weighting: 'cap',   exact: false },

    'Home Improvement':                   { symbol: 'XHB',  weighting: 'equal', exact: false },
    'Furnishings, Fixtures & Appliances': { symbol: 'XHB',  weighting: 'equal', exact: false },
    // PEJ is tiered, not cap-weighted; 'equal' is the nearer of the two labels. Small.
    'Leisure':                            { symbol: 'PEJ',  weighting: 'equal', exact: false },
    'Travel Services':                    { symbol: 'PEJ',  weighting: 'equal', exact: false },
    'Travel Lodging':                     { symbol: 'PEJ',  weighting: 'equal', exact: false },
    'Entertainment':                      { symbol: 'PEJ',  weighting: 'equal', exact: false },

    'Communication Equipment':            { symbol: 'IYZ',  weighting: 'cap',   exact: false },
    'Electronic Gaming & Multimedia':     { symbol: 'ESPO', weighting: 'cap',   exact: true },   // small
    'REIT - Specialty':                   { symbol: 'SRVR', weighting: 'cap',   exact: false },  // small
    'Regulated Water':                    { symbol: 'PHO',  weighting: 'cap',   exact: false },
    'Renewable Utilities':                { symbol: 'ICLN', weighting: 'cap',   exact: false },  // global
}

/** What the benchmark itself is priced with. */
export const BENCHMARK_PROXY = { SPX: 'SPY' }

/**
 * What a bucket is GRADED against, falling back to its parent when it has no fund of its own →
 * `{ symbol, weighting, exact, stands_for }` | null.
 *
 * THE CASCADE, and it is the design: the finest bucket that can be priced, not the finest bucket
 * that exists. A view on Publishing is a real view; there is no Publishing fund, so it is graded
 * against Communication Services and the row says so. `stands_for` names the bucket the fund
 * actually represents whenever that is not the row's own, and `exact` goes false with it — a
 * parent's fund covering a child is the widest version of "this fund spans more than the bucket".
 *
 * What this REPLACES is a refusal. Refusing a table because one bucket had no fund made the desk
 * responsible for knowing which of 155 industries are priceable, which nothing tells it, so the
 * only safe table was one of sectors. Naming the bucket you mean and being graded against the
 * closest instrument that exists is strictly more information than being pushed back up a level.
 */
export function tradableProxy(raw) {
    const r = resolveBucket(raw)
    if (!r) return null

    const own = BUCKET_PROXY[r.bucket]
    if (own) return { ...own, stands_for: null }

    // One hop: an industry with no fund is graded against its sector's. The sectors all have one,
    // so the cascade terminates — a bucket that reaches here with nothing is a vocabulary bug, and
    // null says so rather than inventing a benchmark.
    const parent = r.grain === 'industry' ? INDUSTRY_SECTOR[r.bucket] : null
    const up = parent ? BUCKET_PROXY[parent] : null
    return up ? { ...up, exact: false, stands_for: parent } : null
}

/** The tradable proxy's SYMBOL for a bucket, after the cascade. */
export function proxyFor(raw) {
    return tradableProxy(raw)?.symbol ?? null
}

/** The proxy's caveats — `{ symbol, weighting, exact, stands_for }` — for a row that records them. */
export function proxyMeta(raw) {
    return tradableProxy(raw)
}

/** Buckets that can be graded at all: a stance needs a price, so one without a proxy is not one. */
export const PRICEABLE_BUCKETS = Object.freeze(Object.keys(BUCKET_PROXY))
