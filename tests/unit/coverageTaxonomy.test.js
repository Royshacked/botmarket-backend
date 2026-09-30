import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeCoverage } from '../../api/analyst/coverage.service.js'
import { normalizeIndustry, normalizeSector } from '../../services/entity/vocabulary.js'

// Where a coverage document's TAXONOMY comes from.
//
// It used to come from the model: Prometheus emits `sector` in its `<coverage>` block, and the
// fundamentals it reads formats the pair as "Technology / Software - Infrastructure". Three
// documents on the book stored that whole string as their sector and were invisible to every
// `$in` match against the eleven — the desk was told Technology had 14 covered names when it had
// 15. A taxonomy transcribed by a model is a taxonomy that drifts.

test('the normalizer canonicalises both grains, and drops what it cannot place', () => {
    const doc = normalizeCoverage({ symbol: 'nvda', sector: 'Information Technology', industry: 'semis' })
    assert.equal(doc.symbol, 'NVDA')
    assert.equal(doc.sector, 'Technology')
    assert.equal(doc.industry, 'Semiconductors', 'the desk vocabulary, not the model\'s spelling')

    const vague = normalizeCoverage({ symbol: 'X', sector: 'Technology', industry: 'the AI trade' })
    assert.equal(vague.industry, null, 'a theme is not an industry')
})

test('a qualified provider string still resolves to its SECTOR, as it always did', () => {
    // The shape that caused the original damage. normalizeSector reads the head of it, which is
    // right here and catastrophic on a tilt row — see resolveBucket.
    const doc = normalizeCoverage({ symbol: 'MSFT', sector: 'Technology - Software Infrastructure' })
    assert.equal(doc.sector, 'Technology')
})

test('a document with no taxonomy at all carries nulls, never guesses', () => {
    const doc = normalizeCoverage({ symbol: 'FOO' })
    assert.equal(doc.sector, null)
    assert.equal(doc.industry, null)
})

// ── the two vocabularies do NOT agree, and must not ──────────────────────────
test('the industry is read WHOLE; only the sector reads a qualified head', () => {
    // These two functions disagree on purpose. Resolving an industry through normalizeSector would
    // answer "Technology" to a string whose subject is semiconductors.
    assert.equal(normalizeSector('Technology - Semiconductors'), 'Technology')
    assert.equal(normalizeIndustry('Semiconductors'), 'Semiconductors')
    assert.equal(normalizeIndustry('Banks - Regional'), 'Banks - Regional', 'never split on its own hyphen')
})
