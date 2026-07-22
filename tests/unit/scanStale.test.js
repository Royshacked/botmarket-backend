import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _stampStale } from '../../api/scanner/scan.service.js'

// #7: a period-bound scan whose end date has passed is STALE — a non-destructive,
// derived-on-read flag so the UI can badge it. Nothing is deleted.
const TODAY = '2026-07-22'

test('stale: period.end before today → stale true', () => {
    const s = _stampStale({ period: { label: 'Last week', end: '2026-07-04' } }, TODAY)
    assert.equal(s.stale, true)
})

test('stale: period.end today or in the future → stale false', () => {
    assert.equal(_stampStale({ period: { end: TODAY } }, TODAY).stale, false)          // today is not past
    assert.equal(_stampStale({ period: { end: '2026-12-31' } }, TODAY).stale, false)
})

test('stale: open-ended list (no end date) is never stale', () => {
    assert.equal(_stampStale({ period: { end: null } }, TODAY).stale, false)
    assert.equal(_stampStale({ period: {} }, TODAY).stale, false)
    assert.equal(_stampStale({ thesis: 'no period' }, TODAY).stale, false)
})

test('stale: the flag is added without mutating or dropping other fields', () => {
    const scan = { id: 'scan_1', thesis: 't', period: { end: '2026-07-04' }, candidates: [{ ticker: 'X' }] }
    const out = _stampStale(scan, TODAY)
    assert.equal(out.stale, true)
    assert.equal(out.thesis, 't')
    assert.deepEqual(out.candidates, [{ ticker: 'X' }])
    assert.equal('stale' in scan, false)   // original untouched (non-destructive, not stored)
})

test('stale: non-object input is returned untouched', () => {
    assert.equal(_stampStale(null, TODAY), null)
    assert.equal(_stampStale(undefined, TODAY), undefined)
})
