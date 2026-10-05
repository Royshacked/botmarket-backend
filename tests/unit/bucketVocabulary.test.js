import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SECTORS, INDUSTRIES, INDUSTRY_SECTOR } from '../../services/entity/vocabulary.js'

// The vocabulary a view is held in, at either grain. The whole point of these tests is the ONE
// failure that has no symptom: an industry row silently resolving to its sector, which publishes a
// bet on many times more of the market than the author wrote and grades it against the wrong fund.

// ── the taxonomy ─────────────────────────────────────────────────────────────

test('every industry belongs to exactly one sector, and that sector is a real one', () => {
    assert.equal(INDUSTRIES.length, 155)
    for (const [industry, sector] of Object.entries(INDUSTRY_SECTOR)) {
        assert.ok(SECTORS.includes(sector), `${industry} maps to "${sector}", which is not a sector`)
    }
})

// ── resolution: the industry must win ────────────────────────────────────────
