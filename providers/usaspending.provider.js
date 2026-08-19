// USAspending.gov — federal award transactions. The ingest source for the money-flow hunting
// ground (docs/design/opportunist-money-flow.md).
//
// NO API KEY. Public, free, no registration, generous limits. That is most of why this ground was
// chosen first: the wide end of the funnel costs nothing.
//
// ── THREE THINGS VERIFIED AGAINST THE LIVE API, each of which is a trap if got wrong ──
//
// 1. TRANSACTIONS, NEVER AWARDS. `/search/spending_by_award/` returns an award's LIFETIME
//    cumulative value for any award touched in the window — a probe for "the last six weeks"
//    came back with a $48B Lockheed award whose start date was 1993. `Award Amount` there is a
//    running total, not new money. `/search/spending_by_transaction/` returns ONE ACTION with its
//    own `Transaction Amount` (= federal_action_obligation), which is the money actually committed
//    that day. Only the transaction endpoint can answer "what changed".
//
// 2. `sort` IS REQUIRED. Omitting it 400s with "Missing value: 'sort' is a required field" — not
//    a default, an error. Both search endpoints.
//
// 3. THE DAY IS NOT COMPLETE WHEN IT ARRIVES. Agencies have ~3 business days to report, so the
//    current day carries a small, BIASED fraction of its eventual rows. Measured 2026-08-16:
//
//        action_date   rows (contracts)
//        2026-08-11    10,852     settled
//        2026-08-12     8,452     settled
//        2026-08-13     8,239     settled
//        2026-08-14     1,770     ← same-day: ~20% reported
//
//    A loop that fetches "yesterday" once would permanently see that 20%, and would see it skewed
//    toward whichever agencies report fastest. The fix is not here — it is the caller's: sweep a
//    TRAILING WINDOW every run and upsert idempotently on `transaction_key`. This provider is
//    stateless and will happily return the same rows twice; that is the contract, not a bug.
//
// ── THE TWO-CALL FUNNEL ──
// `fetchTransactions` is the firehose (cheap, paged, ~180/day at the default floor). `fetchAwardDetail`
// is the enrichment — PSC/NAICS, period of performance, and the obligated-vs-ceiling pair — and it
// costs one request PER AWARD, so it runs only on what already cleared the materiality gate.

import axios from 'axios'
import { logger } from '../services/logger.service.js'
import { createTtlCache } from '../services/ttlCache.util.js'

const LOG  = '[usaspending]'
const BASE = 'https://api.usaspending.gov/api/v2'

// Procurement contracts only: A (BPA call), B (purchase order), C (delivery order), D (definitive
// contract). Deliberately NOT grants (02–05) or IDVs — grants land overwhelmingly on universities
// and non-profits, which resolve to no ticker, and an IDV is a ceiling to order against rather than
// money committed. Loans (07/08) are a small, high-signal set worth adding later; they are not in
// v1 because they price differently (a DOE loan is financing, not revenue).
export const CONTRACT_TYPES = ['A', 'B', 'C', 'D']

// The API-side size floor. Deliberately BELOW the real materiality gate, because `award_amounts`
// filters on the AWARD's cumulative total rather than this transaction's amount. A transaction is
// normally ≤ its award total so the filter over-includes (safe), but a prior de-obligation can put
// an award total under one of its own actions — the one way it could under-include. Half the gate
// buys enough headroom that the edge case cannot bite, at a cost of ~180 rows/day instead of ~60.
export const PREFILTER_FLOOR_USD = 5_000_000

const MAX_PAGE_SIZE = 100      // API cap
const TIMEOUT_MS    = 30_000

// Award detail is immutable enough to cache hard — a signed contract's PSC, NAICS and period of
// performance do not change intraday, and the same award is re-enriched every time one of its later
// modifications clears the gate.
const _detailCache = createTtlCache({ ttlMs: 12 * 60 * 60 * 1000, max: 500 })

export const usaspendingProvider = { fetchTransactions, fetchAwardDetail }

// ─── pure helpers ─────────────────────────────────────────────────────────────

const _num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null)))
const _str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Is this action NEW MONEY, or an administrative touch on a contract we already knew about?
 *
 * `Mod` is '0' (or '' / null) on a base award and 'P00003'-style on a modification. An exercised
 * option is the single most common shape in the feed and it is not news — the money was committed
 * when the base contract was signed, and the market saw it then.
 *
 * PURE, and exported because it is the cheapest gate in the funnel and deserves its own test.
 *
 * NOT SUFFICIENT ON ITS OWN, and the counter-example is at the very top of the live feed: TriWest
 * Healthcare draws ~$800–980M on a FRESH award id every month ("EXPRESS REPORT: JUNE 2026"), each
 * one `Mod: '0'`. Recurring operational drawdowns pass this gate looking like a billion dollars of
 * new business. Killing those needs the recurrence check (a recipient+program history read), which
 * belongs at the materiality stage, not here.
 */
export function isNewMoney(mod) {
    const m = _str(mod)
    return m === null || m === '0'
}

/**
 * One API row → the `flow_event` shape the desk stores. PURE. Returns null when the row carries no
 * usable amount or identity, because a transaction we cannot value cannot be ranked and a
 * transaction we cannot key cannot be deduplicated.
 *
 * `transaction_key` is the dedupe identity for the trailing-window sweep. The award id alone is not
 * unique (an award has many actions) and `internal_id` is a USAspending surrogate that is stable in
 * practice but not contracted, so the key pairs the award with its own modification number — which
 * is what actually identifies an action within an award.
 */
export function normalizeTransaction(row) {
    if (!row || typeof row !== 'object') return null

    const awardId   = _str(row['Award ID'])
    const obligated = _num(row['Transaction Amount'])
    if (!awardId || obligated === null) return null

    const mod = _str(row.Mod) ?? '0'
    return {
        source:          'usaspending',
        transaction_key: `${awardId}::${mod}`,
        award_id:        awardId,
        // The handle the award-detail call needs. Without it a row cannot be enriched, so it is
        // carried even though nothing else reads it.
        award_ref:       _str(row.generated_internal_id),
        action_date:     _str(row['Action Date']),
        obligated_usd:   obligated,
        is_modification: !isNewMoney(mod),
        mod,
        recipient_name:  _str(row['Recipient Name']),
        agency:          _str(row['Awarding Agency']),
        sub_agency:      _str(row['Awarding Sub Agency']),
        description:     _str(row['Transaction Description']),
    }
}

// The field list the search endpoint is asked for. Order is irrelevant to the API but fixed here so
// a diff shows a field being added rather than the whole block moving.
const TX_FIELDS = [
    'Award ID', 'Recipient Name', 'Transaction Amount', 'Action Date',
    'Transaction Description', 'Awarding Agency', 'Awarding Sub Agency', 'Mod',
]

/**
 * Build the search body. PURE and exported — the filter shape is where every one of this file's
 * header traps lives, so it is asserted in tests rather than only exercised over the network.
 */
export function _buildTransactionBody({ from, to, floorUsd = PREFILTER_FLOOR_USD, page = 1, limit = MAX_PAGE_SIZE }) {
    return {
        filters: {
            time_period:      [{ start_date: from, end_date: to, date_type: 'action_date' }],
            award_type_codes: CONTRACT_TYPES,
            award_amounts:    [{ lower_bound: floorUsd }],
        },
        fields: TX_FIELDS,
        page,
        limit: Math.min(limit, MAX_PAGE_SIZE),
        sort:  'Transaction Amount',   // required — see header note 2
        order: 'desc',
    }
}

/**
 * Every contract transaction in [from, to] at or above the size floor, newest money first.
 *
 * Dates are ISO `YYYY-MM-DD` and the range is INCLUSIVE on both ends. Pages until exhausted or
 * until `maxPages`, which exists so a mis-specified range cannot walk tens of thousands of rows;
 * hitting it is logged as a warning rather than passed off as a complete answer, because a silently
 * truncated sweep looks exactly like a quiet week.
 *
 * Returns `[]` on failure, never throws — a source outage must degrade to "no new flow today", not
 * take the ingest loop down. The caller cannot distinguish empty-because-quiet from
 * empty-because-broken, which is why the failure is logged at error level here.
 */
async function fetchTransactions({ from, to, floorUsd = PREFILTER_FLOOR_USD, maxPages = 20 } = {}) {
    if (!from || !to) {
        logger.warn(LOG, 'fetchTransactions called without a date range', { from, to })
        return []
    }

    const out = []
    try {
        for (let page = 1; page <= maxPages; page++) {
            const body = _buildTransactionBody({ from, to, floorUsd, page })
            const { data } = await axios.post(`${BASE}/search/spending_by_transaction/`, body, { timeout: TIMEOUT_MS })

            const rows = Array.isArray(data?.results) ? data.results : []
            for (const r of rows) {
                const ev = normalizeTransaction(r)
                if (ev) out.push(ev)
            }
            if (!data?.page_metadata?.hasNext) {
                logger.info(LOG, 'transactions fetched', { from, to, floorUsd, rows: out.length, pages: page })
                return out
            }
            if (page === maxPages) {
                logger.warn(LOG, 'page cap hit — the sweep is INCOMPLETE, widen maxPages or narrow the range',
                    { from, to, floorUsd, rows: out.length, maxPages })
            }
        }
        return out
    } catch (err) {
        logger.error(LOG, 'transaction fetch failed', { from, to, message: err.message, status: err.response?.status })
        return []
    }
}

/**
 * Enrichment for ONE award — what was bought, and over how long. Runs only on gate survivors.
 *
 * The obligated/ceiling pair is the reason this call exists at all:
 *   `total_obligation`     215,521,664   money actually committed
 *   `base_and_all_options` 327,938,162   the headline number, if every option is exercised
 *
 * Both are returned and they must never be conflated. A materiality ratio built on the ceiling
 * inflates every multi-option contract by its own optionality and would put the most speculative
 * awards at the top of the list — trap #1 in the design doc, and the easiest fake thesis to build.
 *
 * Null on any failure. An award we cannot enrich is one we cannot annualize, and a candidate that
 * cannot be annualized must not be surfaced.
 */
async function fetchAwardDetail(awardRef) {
    const ref = _str(awardRef)
    if (!ref) return null

    const hit = _detailCache.get(ref)
    if (hit !== undefined) return hit

    try {
        const { data } = await axios.get(`${BASE}/awards/${encodeURIComponent(ref)}/`, { timeout: TIMEOUT_MS })
        const detail = normalizeAwardDetail(data)
        // Only a real answer is cached. Pinning a null for twelve hours would turn one malformed
        // response into a whole day of "this award cannot be enriched", and the row would be dropped
        // at the gate every time the sweep re-saw it.
        if (detail) _detailCache.set(ref, detail)
        return detail
    } catch (err) {
        logger.warn(LOG, 'award detail fetch failed', { ref, message: err.message, status: err.response?.status })
        return null
    }
}

/**
 * Award-detail payload → the enrichment fields. PURE.
 *
 * `pop_start` falls back to `date_signed`: a contract with no stated start begins when it is signed,
 * and the alternative is a null that would silently disable the annualizer.
 */
export function normalizeAwardDetail(data) {
    if (!data || typeof data !== 'object') return null
    const c = data.latest_transaction_contract_data ?? {}
    const pop = data.period_of_performance ?? {}

    return {
        award_ref:        _str(data.generated_unique_award_id),
        obligated_usd:    _num(data.total_obligation),
        ceiling_usd:      _num(data.base_and_all_options),   // NEVER the numerator — see above
        date_signed:      _str(data.date_signed),
        pop_start:        _str(pop.start_date) ?? _str(data.date_signed),
        // TWO horizons, and the annualizer must use the first. `end_date` is the base period the
        // OBLIGATED money buys; `potential_end_date` extends to the last exercisable option and
        // pairs with the ceiling. Annualizing obligated money over the potential end understates
        // the ratio by exactly the optionality — the mirror of the ceiling trap, in the denominator.
        pop_end:          _str(pop.end_date),
        pop_potential_end: _str(pop.potential_end_date)?.slice(0, 10) ?? null,
        psc:              _str(c.product_or_service_code),
        psc_description:  _str(c.product_or_service_description),
        naics:            _str(c.naics),
        naics_description:_str(c.naics_description),
        // Recipient identity for the resolver. UEI is the stable key the curated ticker map is
        // built on; the name is fuzzy-matched only when the UEI is unknown.
        recipient_name:   _str(data.recipient?.recipient_name),
        recipient_uei:    _str(data.recipient?.recipient_uei),
        recipient_parent: _str(data.recipient?.parent_recipient_name),
        parent_uei:       _str(data.recipient?.parent_recipient_uei),
        description:      _str(data.description),
    }
}

/** Test seam — the detail cache is module-level and would leak between cases. */
export function _clearDetailCache() { _detailCache.clear?.() }
