import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    GRAINS, SECTORS, INDUSTRIES, INDUSTRY_SECTOR, BUCKET_PROXY, PRICEABLE_BUCKETS,
    normalizeIndustry, normalizeSector, resolveBucket, parentSector, proxyFor, proxyMeta, tradableProxy,
} from '../../services/entity/vocabulary.js'

// The vocabulary a view is held in, at either grain. The whole point of these tests is the ONE
// failure that has no symptom: an industry row silently resolving to its sector, which publishes a
// bet on many times more of the market than the author wrote and grades it against the wrong fund.

// ── the taxonomy ─────────────────────────────────────────────────────────────
test('two grains, because the provider has two and its industries are already fine-grained', () => {
    assert.deepEqual(GRAINS, ['sector', 'industry'])
    // If these stopped being first-class industries, a third grain would be needed. They are why
    // it is not: this is sub-industry granularity under an "industry" name.
    for (const fine of ['Gold', 'Copper', 'Steel', 'Semiconductors', 'Banks - Regional', 'REIT - Mortgage']) {
        assert.ok(INDUSTRIES.includes(fine), `${fine} must be a first-class industry`)
    }
})

test('every industry belongs to exactly one sector, and that sector is a real one', () => {
    assert.equal(INDUSTRIES.length, 155)
    for (const [industry, sector] of Object.entries(INDUSTRY_SECTOR)) {
        assert.ok(SECTORS.includes(sector), `${industry} maps to "${sector}", which is not a sector`)
    }
})

// ── resolution: the industry must win ────────────────────────────────────────
test('an industry resolves as an INDUSTRY, never widened to its sector', () => {
    assert.deepEqual(resolveBucket('Semiconductors'), { grain: 'industry', bucket: 'Semiconductors' })
    assert.deepEqual(resolveBucket('Gold'), { grain: 'industry', bucket: 'Gold' })
    assert.equal(parentSector('Semiconductors'), 'Technology')
    assert.equal(parentSector('Gold'), 'Basic Materials')
})

test('a QUALIFIED string keeps its tail — the narrowing is the claim', () => {
    // normalizeSector reads the HEAD of these, correctly, for its own purpose. Reading them the
    // same way here would answer "Technology" to a sentence whose subject is semiconductors.
    for (const raw of ['Technology - Semiconductors', 'Technology — Semiconductors', 'Technology / Semiconductors']) {
        assert.deepEqual(resolveBucket(raw), { grain: 'industry', bucket: 'Semiconductors' }, raw)
    }
    assert.deepEqual(resolveBucket('Healthcare / Biotechnology'), { grain: 'industry', bucket: 'Biotechnology' })
    // …and the sector reading of the same string is unchanged, because coverage still needs it.
    assert.equal(normalizeSector('Technology - Semiconductors'), 'Technology')
})

test('a hyphenated INDUSTRY name is never split by the qualifier rule', () => {
    // The whole string is tried first precisely so these survive. Split, they would resolve to
    // "Banks"/"Oil" or to nothing.
    for (const name of ['Banks - Regional', 'Oil & Gas Midstream', 'Medical - Devices', 'REIT - Mortgage', 'Software - Infrastructure']) {
        assert.deepEqual(resolveBucket(name), { grain: 'industry', bucket: name }, name)
    }
})

test('a sector still resolves as a sector, in any spelling normalizeSector takes', () => {
    assert.deepEqual(resolveBucket('Energy'), { grain: 'sector', bucket: 'Energy' })
    assert.deepEqual(resolveBucket('Financials'), { grain: 'sector', bucket: 'Financial Services' })
    assert.deepEqual(resolveBucket('Health Care'), { grain: 'sector', bucket: 'Healthcare' })
    assert.equal(parentSector('Financials'), 'Financial Services', 'a sector is its own parent')
})

test('a qualified string whose tail means nothing falls back to the sector', () => {
    assert.deepEqual(resolveBucket('Technology / nonsense'), { grain: 'sector', bucket: 'Technology' })
})

test('the shorthands a desk reaches for resolve; anything else is null, never a guess', () => {
    assert.equal(normalizeIndustry('semis'), 'Semiconductors')
    assert.equal(normalizeIndustry('homebuilders'), 'Residential Construction')
    assert.equal(normalizeIndustry('airlines'), 'Airlines, Airports & Air Services')
    assert.equal(normalizeIndustry('SEMIS'), 'Semiconductors', 'case does not matter')

    for (const junk of ['AI', 'the energy transition', '', null, undefined, 42, {}]) {
        assert.equal(normalizeIndustry(junk), null)
        assert.equal(resolveBucket(junk), null)
        assert.equal(parentSector(junk), null)
        assert.equal(proxyFor(junk), null)
    }
})

// ── pricing ──────────────────────────────────────────────────────────────────
test('every priceable bucket is a real bucket, and every sector has a proxy', () => {
    for (const bucket of PRICEABLE_BUCKETS) {
        const r = resolveBucket(bucket)
        assert.ok(r, `${bucket} carries a proxy but does not resolve`)
        if (r.grain === 'industry') assert.ok(INDUSTRIES.includes(bucket), bucket)
        else assert.ok(SECTORS.includes(bucket), bucket)
    }
    // A sector stance must always be publishable — that is what makes sector the fallback grain.
    for (const sector of SECTORS) assert.ok(proxyFor(sector), `${sector} has no proxy`)
})

test('a proxy carries the two things that would otherwise distort a grade silently', () => {
    // Equal-weighting against a cap-weighted benchmark books part of a size factor as an industry
    // call; a fund that spans several industries is not the bucket it is standing in for. Both are
    // recorded so a row can admit them, rather than assumed away.
    for (const [bucket, meta] of Object.entries(BUCKET_PROXY)) {
        assert.match(meta.symbol, /^[A-Z]{2,5}$/, bucket)
        assert.ok(['cap', 'equal'].includes(meta.weighting), `${bucket} weighting`)
        assert.equal(typeof meta.exact, 'boolean', `${bucket} exact`)
    }
    // The sector funds are cap-weighted and exact by construction — the benchmark is built the
    // same way, so nothing is smuggled in.
    for (const sector of SECTORS) {
        assert.equal(BUCKET_PROXY[sector].weighting, 'cap', sector)
        assert.equal(BUCKET_PROXY[sector].exact, true, sector)
    }
})

test('the cap-weighted twin is the one taken, where one exists', () => {
    // XBI/XSD/XHB are equal-weighted and would book small-cap-vs-large-cap as a biotech, semis or
    // homebuilder call. Each has a cap-weighted sibling, and the sibling is what is graded.
    assert.equal(proxyFor('Biotechnology'), 'IBB')
    assert.equal(proxyFor('Semiconductors'), 'SMH')
    assert.equal(proxyFor('Residential Construction'), 'ITB')
    assert.equal(proxyFor('Oil & Gas Exploration & Production'), 'IEO')
})

test('a fund standing for several industries is exact for at most ONE of them', () => {
    // IYT grades Railroads, Trucking and Logistics alike. That is closer than XLI, but a row graded
    // on it is partly a transport call, and `exact: true` would hide that from everyone reading it.
    // A fund may still be exact for the one industry it was built for — IHI is Medical - Devices.
    const users = {}
    for (const [bucket, meta] of Object.entries(BUCKET_PROXY)) (users[meta.symbol] ??= []).push(bucket)
    for (const [symbol, buckets] of Object.entries(users)) {
        const exact = buckets.filter(b => BUCKET_PROXY[b].exact)
        assert.ok(exact.length <= 1, `${symbol} claims to be exact for ${exact.join(', ')}`)
    }
})

test('most industries are graded on a fund of their own grain, not their sector\'s', () => {
    // 129 of 155 used to fall through to the sector fund, scoring an industry call as a sector call.
    const own = INDUSTRIES.filter(i => BUCKET_PROXY[i])
    assert.ok(own.length >= 75, `only ${own.length} industries have their own fund`)
})

test('proxyFor and proxyMeta answer for the same bucket, at either grain', () => {
    assert.equal(proxyFor('semis'), 'SMH')
    assert.equal(proxyMeta('semis').symbol, 'SMH')
    assert.equal(proxyFor('Technology'), 'XLK')
    assert.equal(proxyMeta('Technology').exact, true)
})

// ── the cascade ────────────────────────────────────────────────────────────
//
// The design: "Sub-industry where a proxy exists, industry where it doesn't, sector where neither
// does." What was built refused any table holding a bucket with no fund, and the prompt said so —
// which made the desk responsible for knowing which of 155 industries are priceable. Nothing tells
// it, so the only safe table was one of sectors, and eight live runs produced exactly that.

test('a bucket with NO fund of its own is graded against its sector\'s', () => {
    const p = tradableProxy('Publishing')
    assert.equal(p.symbol, 'XLC')
    assert.equal(p.stands_for, 'Communication Services', 'the row records which fund stood in')
    assert.equal(p.exact, false, 'a parent covering a child is the widest kind of inexact')
})

test('a bucket WITH its own fund does not cascade, and says it did not', () => {
    const p = tradableProxy('Semiconductors')
    assert.equal(p.symbol, 'SMH')
    assert.equal(p.stands_for, null)
    assert.equal(p.exact, true)
})

test('EVERY industry in the vocabulary is publishable, which is the point', () => {
    // The refusal made 129 of the 155 unusable. A view on any real industry is now a view that can
    // be taken and graded, against the closest instrument that exists.
    const unpriceable = INDUSTRIES.filter(i => !proxyFor(i))
    assert.deepEqual(unpriceable, [], 'no industry should be unpublishable')
})

test('a sector never cascades — it is where the cascade stops', () => {
    for (const sector of SECTORS) {
        const p = tradableProxy(sector)
        assert.equal(p.stands_for, null, sector)
        assert.equal(p.exact, true, sector)
    }
})

test('proxyFor and proxyMeta both answer through the cascade', () => {
    assert.equal(proxyFor('Publishing'), 'XLC')
    assert.equal(proxyMeta('Publishing').stands_for, 'Communication Services')
    assert.equal(proxyFor('nonsense'), null, 'but a bucket that does not resolve still has nothing')
    assert.equal(proxyMeta('nonsense'), null)
})
