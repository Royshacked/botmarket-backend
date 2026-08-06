import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    STATUS, LIVE_POSITION, PAST_ENTRY, PAST_ENTRY_LEGACY, PRE_ENTRY, TERMINAL,
    STATUSES_BY_KIND, statusesFor, isValidStatus, isLivePosition, isPastEntry, isTerminal,
    TRADE_HORIZONS, CALL_HORIZONS, isHorizon,
    ASSET_CLASSES, normalizeAssetClass, isEquityClass,
    SECTORS, normalizeSector,
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

test('the pre-P3b call statuses are gone from the language entirely', () => {
    // They described a call that executed through an idea shadow. Nothing writes them, no document
    // carries them, and while they lingered the gates that tested them silently matched nothing.
    for (const dead of ['in_position', 'confirmed']) {
        assert.ok(!PAST_ENTRY.includes(dead))
        assert.ok(!isPastEntry(dead), `${dead} must not be a status any more`)
        assert.ok(!statusesFor('call').includes(dead), `${dead} must not be in the call vocabulary`)
    }
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

test('every kind speaks the SAME ladder — subsets, never synonyms', () => {
    // The rule that keeps shared code working: two kinds may use different SUBSETS, but the same
    // meaning always has the same word. Every second spelling this project grew — `unarmed` for
    // waiting, `watching` for looking, `ready` for hit — produced the same bug: a gate somewhere
    // kept testing the old word and silently matched nothing.
    const LADDER = ['waiting', 'looking', 'hit', 'long', 'short', 'closed']
    for (const kind of Object.keys(STATUSES_BY_KIND)) {
        for (const s of statusesFor(kind)) {
            assert.ok(LADDER.includes(s) || s === 'resting', `${kind} speaks a private word: ${s}`)
        }
    }
    // No kind may reintroduce a synonym for a rung that already has a word.
    for (const dead of ['unarmed', 'watching', 'ready', 'expiring', 'expired', 'dismissed', 'in_position', 'confirmed']) {
        for (const kind of Object.keys(STATUSES_BY_KIND)) {
            assert.ok(!statusesFor(kind).includes(dead), `${kind} must not speak ${dead}`)
        }
    }
})

test('the kinds differ exactly where their mechanics differ', () => {
    // `resting` is the ONE kind-specific rung, and it earns that: an idea's stop-market entry
    // actually sits AT the broker, which is materially different from being watched. A zone
    // cannot rest as a broker order, so no setup or call has it.
    assert.ok(statusesFor('idea').includes('resting'))
    assert.ok(!statusesFor('setup').includes('resting'))
    assert.ok(!statusesFor('call').includes('resting'))

    // Everything else is shared, including the word for "armed".
    for (const kind of Object.keys(STATUSES_BY_KIND)) {
        assert.ok(statusesFor(kind).includes('looking'), `${kind} missing looking`)
        assert.ok(statusesFor(kind).includes('waiting'), `${kind} missing waiting`)
    }
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

// ── sectors: the join key between per-name research and per-sector data ──────
test('SECTORS is FMP\'s taxonomy, not GICS — the side we cannot change', () => {
    assert.equal(SECTORS.length, 11)
    // The five that differ from GICS. If any of these ever reads like the textbook name, the join
    // against FMP's sector rows has silently broken.
    for (const s of ['Healthcare', 'Basic Materials', 'Financial Services', 'Consumer Defensive', 'Consumer Cyclical']) {
        assert.ok(SECTORS.includes(s), `${s} missing`)
    }
    for (const gics of ['Health Care', 'Materials', 'Financials', 'Consumer Staples', 'Consumer Discretionary']) {
        assert.ok(!SECTORS.includes(gics), `${gics} is the GICS spelling, not FMP's`)
    }
    // Every canonical value must normalize to itself, or storing what we read back breaks.
    for (const s of SECTORS) assert.equal(normalizeSector(s), s)
})

test('normalizeSector: GICS spellings — what an LLM writes from training knowledge', () => {
    assert.equal(normalizeSector('Health Care'), 'Healthcare')
    assert.equal(normalizeSector('Financials'), 'Financial Services')
    assert.equal(normalizeSector('Consumer Staples'), 'Consumer Defensive')
    assert.equal(normalizeSector('Consumer Discretionary'), 'Consumer Cyclical')
    assert.equal(normalizeSector('Materials'), 'Basic Materials')
    assert.equal(normalizeSector('Information Technology'), 'Technology')
    assert.equal(normalizeSector('  TECH  '), 'Technology')     // trimmed + case-folded
})

test('normalizeSector: compound "Sector / Industry" keeps the sector', () => {
    // Not hypothetical — these are the exact strings in the live coverage book. Whole-string
    // matching alone nulled 7 of 17 docs.
    assert.equal(normalizeSector('Technology / Semiconductors'), 'Technology')
    assert.equal(normalizeSector('Healthcare — Biotechnology'), 'Healthcare')
    assert.equal(normalizeSector('Technology — Software Infrastructure'), 'Technology')
    assert.equal(normalizeSector('Healthcare / Medical Instruments & Supplies'), 'Healthcare')
    assert.equal(normalizeSector('Energy / Oil & Gas Equipment & Services'), 'Energy')
    assert.equal(normalizeSector('Healthcare — Animal Health'), 'Healthcare')
    // Other separators the model might reach for.
    assert.equal(normalizeSector('Technology (Semiconductors)'), 'Technology')
    assert.equal(normalizeSector('Financials, Regional Banks'), 'Financial Services')
})

test('normalizeSector: unknown → null, so an empty aggregate is never mistaken for a view', () => {
    assert.equal(normalizeSector('Semiconductors'), null)     // an INDUSTRY is not a sector
    assert.equal(normalizeSector('Biotechnology'), null)
    assert.equal(normalizeSector('Crypto'), null)
    assert.equal(normalizeSector(''), null)
    assert.equal(normalizeSector(null), null)
    assert.equal(normalizeSector(42), null)
})

test('normalizeSector: a whole-string match is never split', () => {
    // 'health-care' contains a separator but matches whole, so the second pass must not run.
    assert.equal(normalizeSector('health-care'), 'Healthcare')
    assert.equal(normalizeSector('Oil & Gas'), 'Energy')
})

test('coverage stamps the canonical sector, and filtering accepts the GICS spelling', async () => {
    const { normalizeCoverage } = await import('../../api/analyst/coverage.service.js')
    // The Analyst's own prompt example writes "Technology"; its live docs write compounds. Both land
    // on one stored word, which is the only reason a per-sector aggregate over the book can work.
    assert.equal(normalizeCoverage({ symbol: 'NVDA', sector: 'Technology / Semiconductors' }).sector, 'Technology')
    assert.equal(normalizeCoverage({ symbol: 'JPM',  sector: 'Financials' }).sector, 'Financial Services')
    assert.equal(normalizeCoverage({ symbol: 'X',    sector: 'Nonsense' }).sector, null)
})
