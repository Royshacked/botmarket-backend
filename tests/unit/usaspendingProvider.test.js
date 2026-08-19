import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    isNewMoney, normalizeTransaction, normalizeAwardDetail, _buildTransactionBody,
    CONTRACT_TYPES, PREFILTER_FLOOR_USD,
} from '../../providers/usaspending.provider.js'

// The money-flow ingest source (docs/design/opportunist-money-flow.md §2). Every case below is a
// trap the live API actually sets — the fixtures are trimmed copies of real responses, not
// invented shapes.

// ─── isNewMoney ───────────────────────────────────────────────────────────────

test('isNewMoney: a base award is new money, a modification is not', () => {
    assert.equal(isNewMoney('0'), true)
    assert.equal(isNewMoney('P00009'), false)   // "EXERCISING THE OPTION PERIOD" — live row
    assert.equal(isNewMoney('A00001'), false)
})

test('isNewMoney: absent/blank Mod is treated as a base award', () => {
    // The field is omitted on some rows. Treating that as a modification would silently discard
    // real awards, which is the more expensive of the two mistakes.
    assert.equal(isNewMoney(null), true)
    assert.equal(isNewMoney(undefined), true)
    assert.equal(isNewMoney('   '), true)
})

// ─── normalizeTransaction ─────────────────────────────────────────────────────

const TX = {
    'Award ID': '70CDCR26C00000021',
    'Recipient Name': 'EASTERN AIR EXPRESS LLC',
    'Transaction Amount': 215521664.0,
    'Action Date': '2026-08-12',
    'Transaction Description': 'GOVERNMENT FURNISHED AIRCRAFT (GFA) OPERATIONAL SUPPORT',
    'Awarding Agency': 'Department of Homeland Security',
    Mod: '0',
    generated_internal_id: 'CONT_AWD_70CDCR26C00000021_7012_-NONE-_-NONE-',
}

test('normalizeTransaction: maps a live row to the flow_event shape', () => {
    const ev = normalizeTransaction(TX)
    assert.equal(ev.source, 'usaspending')
    assert.equal(ev.award_id, '70CDCR26C00000021')
    assert.equal(ev.obligated_usd, 215521664.0)
    assert.equal(ev.is_modification, false)
    assert.equal(ev.recipient_name, 'EASTERN AIR EXPRESS LLC')
    assert.equal(ev.award_ref, 'CONT_AWD_70CDCR26C00000021_7012_-NONE-_-NONE-')
})

test('normalizeTransaction: transaction_key separates actions within one award', () => {
    // The award id alone is NOT unique — an award has many actions, and the trailing-window sweep
    // re-sees all of them. Keying on the award would collapse a year of modifications into one row.
    const base = normalizeTransaction(TX)
    const mod  = normalizeTransaction({ ...TX, Mod: 'P00003', 'Transaction Amount': 1000 })
    assert.equal(base.transaction_key, '70CDCR26C00000021::0')
    assert.equal(mod.transaction_key,  '70CDCR26C00000021::P00003')
    assert.notEqual(base.transaction_key, mod.transaction_key)
})

test('normalizeTransaction: the same row twice yields the same key (idempotent sweep)', () => {
    assert.equal(normalizeTransaction(TX).transaction_key, normalizeTransaction({ ...TX }).transaction_key)
})

test('normalizeTransaction: a de-obligation keeps its negative amount', () => {
    // Live: "was modified for the amount of -$15,788.3". Coercing this to 0 or dropping it would
    // lose the fact that money came BACK — which is a signal, not noise.
    const ev = normalizeTransaction({ ...TX, 'Transaction Amount': -15788.3, Mod: 'P00003' })
    assert.equal(ev.obligated_usd, -15788.3)
    assert.equal(ev.is_modification, true)
})

test('normalizeTransaction: unusable rows are dropped, not half-built', () => {
    assert.equal(normalizeTransaction(null), null)
    assert.equal(normalizeTransaction({}), null)
    assert.equal(normalizeTransaction({ ...TX, 'Award ID': null }), null)          // unkeyable
    assert.equal(normalizeTransaction({ ...TX, 'Transaction Amount': null }), null) // unrankable
})

test('normalizeTransaction: a zero-dollar action survives normalization', () => {
    // Zero is a real value (an administrative action) and must not be confused with absent — the
    // gate decides whether to keep it, the normalizer does not get a vote.
    assert.equal(normalizeTransaction({ ...TX, 'Transaction Amount': 0 }).obligated_usd, 0)
})

// ─── _buildTransactionBody ────────────────────────────────────────────────────

test('_buildTransactionBody: carries the required sort key', () => {
    // Omitting `sort` is a 400 from the API, not a default. Asserted here so the failure surfaces
    // in a unit run rather than at 5pm in the ingest loop.
    const body = _buildTransactionBody({ from: '2026-08-10', to: '2026-08-16' })
    assert.equal(body.sort, 'Transaction Amount')
    assert.equal(body.order, 'desc')
})

test('_buildTransactionBody: filters to contracts on action_date, inclusive', () => {
    const body = _buildTransactionBody({ from: '2026-08-10', to: '2026-08-16' })
    assert.deepEqual(body.filters.award_type_codes, CONTRACT_TYPES)
    assert.deepEqual(body.filters.time_period, [
        { start_date: '2026-08-10', end_date: '2026-08-16', date_type: 'action_date' },
    ])
})

test('_buildTransactionBody: the API-side floor sits below the materiality gate', () => {
    const body = _buildTransactionBody({ from: '2026-08-10', to: '2026-08-16' })
    assert.equal(body.filters.award_amounts[0].lower_bound, PREFILTER_FLOOR_USD)
    // `award_amounts` filters on the award TOTAL, not this transaction — so the floor must leave
    // headroom, or a de-obligated award could hide a transaction we wanted.
    assert.ok(PREFILTER_FLOOR_USD < 10_000_000, 'prefilter must undercut the $10M gate')
})

test('_buildTransactionBody: page size is capped at the API maximum', () => {
    assert.equal(_buildTransactionBody({ from: 'a', to: 'b', limit: 5000 }).limit, 100)
    assert.equal(_buildTransactionBody({ from: 'a', to: 'b', limit: 25 }).limit, 25)
})

// ─── normalizeAwardDetail ─────────────────────────────────────────────────────

const DETAIL = {
    generated_unique_award_id: 'CONT_AWD_70CDCR26C00000021_7012_-NONE-_-NONE-',
    total_obligation: 215521664.0,
    base_and_all_options: 327938162.0,
    date_signed: '2026-08-12',
    description: 'GOVERNMENT FURNISHED AIRCRAFT (GFA) OPERATIONAL SUPPORT',
    period_of_performance: {
        start_date: '2026-08-12', end_date: '2027-08-11',
        potential_end_date: '2028-02-11 00:00:00',
    },
    latest_transaction_contract_data: {
        product_or_service_code: 'V211', naics: '481211',
        naics_description: 'NONSCHEDULED CHARTERED PASSENGER AIR TRANSPORTATION',
        product_or_service_description: 'TRANSPORTATION/TRAVEL/RELOCATION- TRAVEL/LODGING/RECRUITMENT: AIR PASSENGER',
    },
    recipient: {
        recipient_name: 'EASTERN AIR EXPRESS LLC', recipient_uei: 'QKELA8U9HRQ1',
        parent_recipient_name: 'EASTERN AIR EXPRESS LLC', parent_recipient_uei: 'QKELA8U9HRQ1',
    },
}

test('normalizeAwardDetail: keeps obligated and ceiling as separate numbers', () => {
    // Trap #1. These differ by $112M on this one award; conflating them inflates every
    // multi-option contract by its own optionality.
    const d = normalizeAwardDetail(DETAIL)
    assert.equal(d.obligated_usd, 215521664.0)
    assert.equal(d.ceiling_usd,   327938162.0)
    assert.notEqual(d.obligated_usd, d.ceiling_usd)
})

test('normalizeAwardDetail: base period and potential end are both kept, and differ', () => {
    // The annualizer pairs obligated money with `pop_end`. `pop_potential_end` belongs to the
    // ceiling; using it as the denominator understates the ratio by the optionality.
    const d = normalizeAwardDetail(DETAIL)
    assert.equal(d.pop_start, '2026-08-12')
    assert.equal(d.pop_end,   '2027-08-11')
    assert.equal(d.pop_potential_end, '2028-02-11')   // time component trimmed
})

test('normalizeAwardDetail: pop_start falls back to date_signed', () => {
    // A null start would silently disable the annualizer; a contract with no stated start begins
    // when it was signed.
    const d = normalizeAwardDetail({ ...DETAIL, period_of_performance: { end_date: '2027-08-11' } })
    assert.equal(d.pop_start, '2026-08-12')
})

test('normalizeAwardDetail: carries the resolver keys', () => {
    const d = normalizeAwardDetail(DETAIL)
    assert.equal(d.recipient_uei, 'QKELA8U9HRQ1')
    assert.equal(d.parent_uei,    'QKELA8U9HRQ1')
    assert.equal(d.psc,   'V211')
    assert.equal(d.naics, '481211')
})

test('normalizeAwardDetail: survives a payload with no contract or recipient block', () => {
    const d = normalizeAwardDetail({ generated_unique_award_id: 'X', total_obligation: 5 })
    assert.equal(d.award_ref, 'X')
    assert.equal(d.psc, null)
    assert.equal(d.recipient_uei, null)
    assert.equal(d.pop_end, null)
})

test('normalizeAwardDetail: a non-object payload is null, never a half-built detail', () => {
    assert.equal(normalizeAwardDetail(null), null)
    assert.equal(normalizeAwardDetail('nope'), null)
})
