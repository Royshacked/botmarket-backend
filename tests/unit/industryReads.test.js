import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatIndustryReads, readIndustryReads, _setIndustryIO, STALE_DAYS } from '../../api/strategy/industryReads.service.js'
import { TOOLS } from '../../services/agents/strategy.agent.service.js'

// Pythia's industry reads. What must hold: evidence and context are told apart in so many words,
// "no read" is never shown as average, and an old read says it is old.

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const doc = (id, over = {}) => ({
    _id: id, sector: 'Technology', evidence: 0.2, beat: 0.8, surprise: 0.06, momentum: 0.12, momentum_from: 'SMH',
    n: 30, pe: 52.4, pe_z: 1.8, eps_g: 0.4, rev_g: 0.3, computed_at: new Date(NOW - DAY), ...over,
})

test('best evidence first, with the parts and the fund the momentum came from', () => {
    const text = formatIndustryReads([doc('Software - Application', { evidence: -0.3 }), doc('Semiconductors', { evidence: 0.4 })], { nowMs: NOW })
    assert.ok(text.indexOf('Semiconductors') < text.indexOf('Software - Application'))
    assert.match(text, /Semiconductors\s+ev \+0\.40\s+beat\s+\+80% \(n 30\).*mom\s+\+12% \[SMH\]/)
})

test('context is labelled as never sized, and the reasons are stated', () => {
    const text = formatIndustryReads([doc('Semiconductors')], { nowMs: NOW })
    assert.match(text, /context: P\/E 52\.4 \(\+1\.8z vs 5y\)/)
    assert.match(text, /CONTEXT \(never sized\).*Cheapness did NOT pay.*reported growth is priced/)
})

test('an industry with no read is listed apart, never as average', () => {
    const text = formatIndustryReads([doc('Semiconductors'), doc('Shell Companies', { evidence: null })], { nowMs: NOW })
    assert.match(text, /No read \(too few recent reports.*\): Shell Companies\./)
    assert.doesNotMatch(text.split('No read')[0], /Shell Companies/)
})

test('an old read is headed stale', () => {
    const text = formatIndustryReads([doc('Semiconductors', { computed_at: new Date(NOW - (STALE_DAYS + 1) * DAY) })], { nowMs: NOW })
    assert.match(text, /^⚠ STALE INDUSTRY READS — computed 17 days ago/)
})

test('a sector filter narrows, and nothing at all forbids arguing as if measured', () => {
    const docs = [doc('Semiconductors'), doc('Banks - Regional', { sector: 'Financial Services' })]
    assert.doesNotMatch(formatIndustryReads(docs, { sector: 'Technology', nowMs: NOW }), /Banks/)
    assert.match(formatIndustryReads(docs, { sector: 'Narnia', nowMs: NOW }), /No industry reads for sector "Narnia"/)
    assert.match(formatIndustryReads([], { nowMs: NOW }), /not available.*Do not argue/)
})

test('the read goes through the seam, and the desk carries the tool ahead of consult', async () => {
    _setIndustryIO({ reads: async () => [doc('Semiconductors')] })
    assert.equal((await readIndustryReads()).length, 1)
    const tool = TOOLS.find(t => t.name === 'get_industry_reads')
    assert.equal(tool.input_schema.properties.sector.type, 'string')
    assert.equal(TOOLS.at(-1).name, 'consult')
})
