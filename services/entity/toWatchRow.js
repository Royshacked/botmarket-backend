// Present any owner-scoped artifact as ONE watch-list row: "here is a thing you have in the app."
// The list-tier twin of toEnvelope.js beside it — that one gives the EXECUTION path a canonical
// shape, this one gives the REPORTING path a canonical shape.
//
// It sits in services/entity/ even though scans and coverage are not execution-tier entities, for
// the reason entityCrud.service.js already states about itself: being owner-scoped is what
// qualifies a list here, not which collection it sits in.
//
// TRIMMED, HARD, and not only for token cost. A call doc carries `chat_state` — an entire past
// conversation — plus entry_zones, reference_levels, patterns and monitor_state.timeline; a scan
// carries candidates[] AND chat[]. Feeding that to an agent puts a stale transcript in its context
// where it can be read back as current fact, which is a correctness bug rather than a bill. Every
// row keeps `id` + `kind`, so "tell me about the NVDA call" is a targeted read, not a re-list.
//
// WHAT IS DELIBERATELY NOT NORMALIZED:
//   • `status` is the kind's own word, verbatim. Calls, setups and holdings share the ladder in
//     vocabulary.js; coverage has its own (active | thesis_broken | target_hit | retired |
//     watchlist); scans and books have no status at all and report null. Flattening five
//     vocabularies onto one enum would mean maintaining a translation table that lies.
//   • `detail` is per kind. Share the pipe, not the judgment: what matters about a call (levels,
//     R:R) and what matters about a scan (how many names, is it stale) are different questions.
//
// These projectors are PURE and exported individually so the tool adapter, a future REST route and
// a future live component all render from the same fields.

/** Whatever a kind calls its timestamp → ms epoch. Coverage stores ISO strings; entities store ms. */
function _ms(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
        const t = Date.parse(v)
        if (!Number.isNaN(t)) return t
    }
    return null
}

/** One line of human context, capped — never a whole thesis, never a transcript. */
function _title(text, fallback = '', max = 120) {
    const s = typeof text === 'string' ? text.trim() : ''
    if (!s) return fallback
    return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * The zone nearest to being actionable, as plain bounds. Zone shapes differ; only bounds are read.
 *
 * A zone's edges are `lower`/`upper` — BOTH normalizers emit that spelling (setup.schema
 * normalizeZone and kairos.service normalizeZones). This read `low`/`high`, which no zone has ever
 * carried, so `nearestEntry` / `stop` / `firstTp` were null on every setup AND call row ever
 * projected — including the agent-facing watch list, where the levels simply went missing rather
 * than reading wrong. `low`/`high` stay accepted as a fallback in case an unnormalized zone reaches
 * here; the OUTPUT keys are unchanged because userData.tools._zone reads them.
 */
function _firstZone(zones) {
    const z = Array.isArray(zones) ? zones.find(Boolean) : null
    if (!z) return null
    const low  = typeof z.lower === 'number' ? z.lower : (typeof z.low  === 'number' ? z.low  : null)
    const high = typeof z.upper === 'number' ? z.upper : (typeof z.high === 'number' ? z.high : null)
    if (low == null && high == null) return null
    return { low, high }
}

/** A Kairos call → a row. `bias` is the call's word for direction. */
export function callToWatchRow(doc) {
    if (!doc?.id) return null
    return {
        kind: 'call',
        id: doc.id,
        symbol: doc.asset ?? null,
        title: _title(doc.thesis, `${doc.bias ?? ''} ${doc.asset ?? ''}`.trim()),
        direction: doc.bias ?? null,
        status: doc.status ?? null,
        updatedAt: _ms(doc.savedAt) ?? _ms(doc.created_at),
        detail: {
            entryZones: Array.isArray(doc.entry_zones) ? doc.entry_zones.length : 0,
            nearestEntry: _firstZone(doc.entry_zones),
            rr: doc.rr ?? null,
            conviction: doc.conviction ?? null,
            validUntil: doc.valid_until ?? null,
            mode: doc.mode ?? null,
        },
    }
}

/**
 * One scenario, as a row reads it. A setup can hold rival premises — a false break at one level and
 * a break-and-go at another — and a single set of levels would hide the second one entirely, which
 * is the whole reason this array exists.
 */
function _scenarioRow(sc, doc) {
    return {
        id: sc?.id ?? null,
        name: sc?.name ?? null,
        entry: _firstZone(sc?.entry_zones),
        stop: _firstZone(sc?.stop_zones),
        tp: _firstZone(sc?.tp_zones),
        quantity: sc?.quantity ?? null,
        rr: sc?.rr ?? null,
        armed: sc?.id != null && sc.id === (doc?.armed_scenario_id ?? null),
        // The premise's own invalidation axis: 'fired' means this way in is dead while the others
        // may still be live, so a row that showed only the document's status would read as fine.
        invalidation: doc?.monitor_state?.scenarios?.[sc?.id]?.invalidation_status ?? null,
    }
}

/**
 * A Mentor setup → a row. Setups carry their own stop/tp zones, which a call leaves to its tree.
 *
 * The flat `nearestEntry`/`stop`/`firstTp`/`rr` are the ARMED scenario's (else the first authored) —
 * they read the document's execution projection, which is exactly that. They are not redundant with
 * `scenarios`: userData.tools._zone reads these keys, and an agent asked "where is my NVDA setup"
 * wants one answer rather than a menu.
 */
export function setupToWatchRow(doc) {
    if (!doc?.id) return null
    const scenarios = Array.isArray(doc.scenarios) ? doc.scenarios : []
    return {
        kind: 'setup',
        id: doc.id,
        symbol: doc.asset ?? null,
        title: _title(doc.thesis, `${doc.direction ?? ''} ${doc.asset ?? ''}`.trim()),
        direction: doc.direction ?? null,
        status: doc.status ?? null,
        updatedAt: _ms(doc.savedAt),
        detail: {
            entryZones: Array.isArray(doc.entry_zones) ? doc.entry_zones.length : 0,
            nearestEntry: _firstZone(doc.entry_zones),
            stop: _firstZone(doc.stop_zones),
            firstTp: _firstZone(doc.tp_zones),
            rr: doc.rr ?? null,
            conviction: doc.conviction ?? null,
            validUntil: doc.valid_until ?? null,
            timeframe: doc.timeframe ?? null,
            scenarios: scenarios.map(sc => _scenarioRow(sc, doc)),
        },
    }
}

/**
 * A portfolio BOOK → a row. Takes the cheap enumeration from listPortfolios, never a computed
 * state: pricing every book to list them would be one broker round-trip per book behind one
 * question. `status` is null because a book has no status of its own — the per-status counts of
 * what is IN it are the honest answer, and they come free with the enumeration.
 */
export function portfolioToWatchRow(book) {
    if (!book?.portfolioId) return null
    return {
        kind: 'portfolio',
        id: book.portfolioId,
        symbol: null,
        title: book.name ?? 'Portfolio',
        direction: null,
        status: null,
        updatedAt: _ms(book.savedAt),
        detail: {
            holdings: book.holdings ?? 0,
            byStatus: book.statuses ?? {},
            symbols: Array.isArray(book.symbols) ? book.symbols : [],
        },
    }
}

/**
 * An Argus scan → a row. A scan has NO symbol — it is a list of candidates — and no status;
 * `stale` (derived on read from its period) is the closest thing it has, and it stays in detail
 * rather than being dressed up as a status word.
 */
export function scanToWatchRow(doc) {
    if (!doc?.id) return null
    return {
        kind: 'scan',
        id: doc.id,
        symbol: null,
        title: _title(doc.thesis, doc.period?.label ?? 'Scan'),
        direction: doc.direction ?? null,
        status: null,
        updatedAt: _ms(doc.updatedAt) ?? _ms(doc.savedAt),
        detail: {
            period: doc.period?.label ?? null,
            candidates: Array.isArray(doc.candidates) ? doc.candidates.length : 0,
            stale: doc.stale === true,
            profile: doc.profile ?? null,
            style: doc.style ?? null,
        },
    }
}

/** A Prometheus coverage → a row. Our target against the Street is the whole point of the artifact. */
export function coverageToWatchRow(doc) {
    if (!doc?.id) return null
    return {
        kind: 'coverage',
        id: doc.id,
        symbol: doc.symbol ?? null,
        title: _title(doc.thesis, doc.symbol ?? 'Coverage'),
        direction: null,
        status: doc.status ?? null,
        updatedAt: _ms(doc.updated_at) ?? _ms(doc.created_at),
        detail: {
            rating: doc.rating ?? null,
            ourPT: doc.price_target?.value ?? null,
            streetPT: doc.gap?.consensus_pt ?? null,
            gapPct: doc.gap?.pct ?? null,
            sector: doc.sector ?? null,
            conviction: doc.conviction ?? null,
        },
    }
}

/** Kind → projector, for callers that map a mixed set. */
export const WATCH_ROW_PROJECTORS = {
    call: callToWatchRow,
    setup: setupToWatchRow,
    portfolio: portfolioToWatchRow,
    scan: scanToWatchRow,
    coverage: coverageToWatchRow,
}
