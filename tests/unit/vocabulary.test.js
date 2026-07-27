import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    STATUS, LIVE_POSITION, PAST_ENTRY, PAST_ENTRY_LEGACY, PRE_ENTRY, TERMINAL,
    STATUSES_BY_KIND, statusesFor, isValidStatus, isLivePosition, isPastEntry, isTerminal,
    TRADE_HORIZONS, CALL_HORIZONS, isHorizon,
    ASSET_CLASSES, normalizeAssetClass, isEquityClass,
} from '../../services/entity/vocabulary.js'
import { ACTIVE_STATUSES } from '../../services/entity/entityRepo.service.js'
import { SETUP_STATUSES } from '../../api/setups/setups.service.js'

// The vocabulary every entity and agent speaks. It replaced 13 status declarations across 8 files
// — including `['long','short']` written three times under three different names. These tests pin
// the words the kind-blind execution path matches on.

// ─── Statuses ─────────────────────────────────────────────────────────────────

test('LIVE_POSITION is exactly what the reconciler matches, and nothing else', () => {
    // The reconciler is kind-blind: it finds entities by status alone. If these words drift from
    // what a kind actually writes, a filled position is never reconciled.
    assert.deepEqual(LIVE_POSITION, ['long', 'short'])
    assert.deepEqual([...ACTIVE_STATUSES], LIVE_POSITION, 'entityRepo must speak the same words')
})

test('past-entry includes hit — an order exists even before the fill', () => {
    assert.deepEqual(PAST_ENTRY, ['hit', 'long', 'short'])
    assert.ok(isPastEntry('hit'))
    assert.ok(!isPastEntry('looking'))
})

test('the legacy pre-P3b call statuses are recognised but never in the modern set', () => {
    assert.ok(isPastEntry('in_position'), 'a pre-cutover call must stay manageable')
    assert.ok(isPastEntry('confirmed'))
    assert.ok(!isPastEntry('in_position', false), 'opt out and the legacy pair is excluded')
    assert.ok(!PAST_ENTRY.includes('in_position'))
})

test('pre-entry and past-entry never overlap', () => {
    // An entity is either being watched or has an order out — never both.
    for (const s of PRE_ENTRY) assert.ok(!isPastEntry(s), s)
    for (const s of PAST_ENTRY_LEGACY) assert.ok(!PRE_ENTRY.includes(s), s)
})

test('closed is terminal and belongs to no other group', () => {
    assert.deepEqual(TERMINAL, ['closed'])
    assert.ok(isTerminal('closed'))
    assert.ok(!isPastEntry('closed') && !PRE_ENTRY.includes('closed'))
})

test('each kind gets a SUBSET, not its own vocabulary', () => {
    // Every kind-specific status must exist in the shared enum — otherwise it is a private word
    // the execution path cannot understand.
    const all = new Set(Object.values(STATUS).concat(['confirmed', 'in_position']))
    for (const [kind, list] of Object.entries(STATUSES_BY_KIND)) {
        for (const s of list) assert.ok(all.has(s), `${kind}: "${s}" is not in the shared enum`)
    }
})

test('the kinds differ exactly where their mechanics differ', () => {
    // A setup has no `resting` (a zone cannot rest as a broker order) and no `watching` (the card
    // fires on any verdict, so a trip resolves to `hit` in one wake). An idea is the mirror image.
    assert.ok(statusesFor('idea').includes('resting'))
    assert.ok(!statusesFor('setup').includes('resting'))
    assert.ok(!statusesFor('setup').includes('watching'))
    assert.ok(statusesFor('call').includes('watching'))
})

test('the setup service and the vocabulary agree', () => {
    assert.deepEqual([...SETUP_STATUSES].sort(), statusesFor('setup').slice().sort())
})

test('every kind converges on the execution vocabulary after entry', () => {
    // This convergence is what lets one reconciler serve every kind.
    for (const kind of Object.keys(STATUSES_BY_KIND)) {
        for (const s of LIVE_POSITION) assert.ok(statusesFor(kind).includes(s), `${kind} missing ${s}`)
        assert.ok(statusesFor(kind).includes('hit'), `${kind} missing hit`)
        assert.ok(statusesFor(kind).includes('closed'), `${kind} missing closed`)
    }
})

test('an unknown kind or status is rejected rather than defaulted', () => {
    assert.deepEqual(statusesFor('nope'), [])
    assert.equal(isValidStatus('setup', 'resting'), false)
    assert.equal(isValidStatus('nope', 'long'), false)
    assert.equal(isLivePosition(undefined), false)
})

// ─── Horizons ─────────────────────────────────────────────────────────────────

test('one horizon ladder, ordered by holding period', () => {
    assert.deepEqual(TRADE_HORIZONS, ['intraday', 'day', 'swing', 'long term'])
})

test('a call cannot be long term — the narrowing is a SUBSET, not a second list', () => {
    // Kairos builds a moment to act on, not a multi-month hold.
    assert.deepEqual(CALL_HORIZONS, ['intraday', 'day', 'swing'])
    for (const h of CALL_HORIZONS) assert.ok(TRADE_HORIZONS.includes(h), `${h} drifted off the ladder`)
    assert.ok(!CALL_HORIZONS.includes('long term'))
})

test('isHorizon rejects near-misses', () => {
    assert.ok(isHorizon('long term'))
    assert.ok(!isHorizon('longterm'))
    assert.ok(!isHorizon('scalp'), 'scalping is deliberately not a horizon')
    assert.ok(!isHorizon(undefined))
})

// ─── Asset classes ────────────────────────────────────────────────────────────

test('the synonyms every consumer had grown its own map for now resolve in one place', () => {
    // market.service accepted stock/stocks/equity/equities/etf; eventRisk accepted a different
    // set. Both drifted from what the prompts actually emit.
    assert.equal(normalizeAssetClass('equity'), 'stock')
    assert.equal(normalizeAssetClass('equities'), 'stock')
    assert.equal(normalizeAssetClass('stocks'), 'stock')
    assert.equal(normalizeAssetClass('future'), 'futures')
    assert.equal(normalizeAssetClass('fx'), 'forex')
    assert.equal(normalizeAssetClass('cryptocurrency'), 'crypto')
})

test('normalisation is case- and whitespace-insensitive', () => {
    // An agent emitting "Equity " used to be stored verbatim, matching nothing downstream.
    assert.equal(normalizeAssetClass('  Equity '), 'stock')
    assert.equal(normalizeAssetClass('CRYPTO'), 'crypto')
})

test('an unrecognised class becomes null — the documented fall-back-to-symbol path', () => {
    // null is what every consumer already treats as "guess from the ticker", so an unknown value
    // degrades onto a safe path instead of being stored as a word nothing matches.
    for (const bad of ['shares of AAPL', 'bond', '', null, undefined, 42]) {
        assert.equal(normalizeAssetClass(bad), null, String(bad))
    }
})

test('every canonical class normalises to itself', () => {
    for (const c of ASSET_CLASSES) assert.equal(normalizeAssetClass(c), c)
})

test('equity-like covers stocks and ETFs only — where earnings and options exist', () => {
    assert.ok(isEquityClass('stock') && isEquityClass('etf') && isEquityClass('equity'))
    assert.ok(!isEquityClass('crypto') && !isEquityClass('futures') && !isEquityClass('forex'))
    assert.ok(!isEquityClass(null))
})

// ─── Boundary wiring ──────────────────────────────────────────────────────────

test('the reconciler and every kind agree on what a live position is called', async () => {
    // The reconciler finds entities by status alone, with no idea what kind they are. If its list
    // and a kind's list ever diverge, that kind's fills stop being reconciled — silently.
    const { ACTIVE_STATUSES } = await import('../../services/entity/entityRepo.service.js')
    assert.deepEqual([...ACTIVE_STATUSES], LIVE_POSITION)
    for (const kind of Object.keys(STATUSES_BY_KIND)) {
        for (const s of LIVE_POSITION) {
            assert.ok(statusesFor(kind).includes(s), `${kind} cannot express "${s}"`)
        }
    }
})

test('asset_class is canonicalised at the setup boundary, not absorbed downstream', async () => {
    const { normalizeSetup } = await import('../../services/setup.schema.js')
    // Kairos's schema says "equity"; the prompts say "stock". Both must land on one stored word.
    assert.equal(normalizeSetup({ asset: 'NVDA', asset_class: 'equity' }).asset_class, 'stock')
    assert.equal(normalizeSetup({ asset: 'BTC', asset_class: ' CRYPTO ' }).asset_class, 'crypto')
    assert.equal(normalizeSetup({ asset: 'X', asset_class: 'bond' }).asset_class, null)
})
