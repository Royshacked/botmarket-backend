import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    makeGroundingLedger, recordSourced, recordTouched, groundingTier, normTicker,
} from '../../services/scanner.grounding.js'
import { _normalizeScan } from '../../services/scanner.agent.service.js'

// Argus grounding — "names come from the tape, never from memory" (slice 1, A1+B1).

// ── pure ledger / tier ───────────────────────────────────────────────────────
test('normTicker uppercases + trims; non-string → ""', () => {
    assert.equal(normTicker(' nvda '), 'NVDA')
    assert.equal(normTicker(null), '')
    assert.equal(normTicker(42), '')
})

test('groundingTier: sourced (on the tape) > validated (per-name tool) > ungrounded', () => {
    const led = makeGroundingLedger()
    recordSourced(led, 'Top gainers (US, today):\n  AAPL   Apple Inc | NASDAQ | $150 | +5%')
    recordTouched(led, ['TSLA'])
    assert.equal(groundingTier('AAPL', led), 'sourced')     // in discovery text
    assert.equal(groundingTier('tsla', led), 'validated')   // per-name tool ran (case-insensitive input)
    assert.equal(groundingTier('NFLX', led), 'ungrounded')  // neither
})

test('groundingTier: null ledger / empty ticker → ungrounded', () => {
    assert.equal(groundingTier('AAPL', null), 'ungrounded')
    assert.equal(groundingTier('', makeGroundingLedger()), 'ungrounded')
})

test('sourced word-boundary: a substring of a longer symbol does NOT match', () => {
    const led = makeGroundingLedger()
    recordSourced(led, '  AAPL   Apple Inc')
    assert.equal(groundingTier('AAP', led), 'ungrounded')   // AAP ≠ AAPL
    assert.equal(groundingTier('AAPL', led), 'sourced')
})

test('sourced word-boundary: dotted symbols match exactly, not their stem', () => {
    const led = makeGroundingLedger()
    recordSourced(led, '  BRK.B   Berkshire Hathaway')
    assert.equal(groundingTier('BRK.B', led), 'sourced')
    assert.equal(groundingTier('BRK', led), 'ungrounded')   // BRK ≠ BRK.B
})

test('recordTouched ignores blanks/non-strings; recordSourced ignores empty', () => {
    const led = makeGroundingLedger()
    recordTouched(led, ['', null, '  ', 'MSFT'])
    recordSourced(led, '')
    assert.equal(groundingTier('MSFT', led), 'validated')
    assert.equal(led.sourcedText, '')
})

// ── _normalizeScan enforcement (A1: drop ungrounded; B1: accept validated) ────
function cand(ticker, total = 80, extra = {}) {
    return { ticker, direction: 'long', thesis: 't', analysis: 'a',
        score: { total, catalyst: 80, technical: 70, relativeStrength: 60, liquidity: 90 }, ...extra }
}

test('with ledger: ungrounded candidate is dropped; survivors carry their tier', () => {
    const led = makeGroundingLedger()
    recordSourced(led, '  AAPL   Apple Inc')
    recordTouched(led, ['TSLA'])
    const scan = { thesis: 's', direction: 'long', candidates: [cand('AAPL', 80), cand('TSLA', 70), cand('FAKE', 95)] }
    const out = _normalizeScan(scan, null, led)
    assert.deepEqual(out.candidates.map(c => c.ticker), ['AAPL', 'TSLA'])   // FAKE dropped despite top score
    assert.equal(out.candidates.find(c => c.ticker === 'AAPL').grounding, 'sourced')
    assert.equal(out.candidates.find(c => c.ticker === 'TSLA').grounding, 'validated')
})

test('with ledger: an all-ungrounded scan collapses to null (no fabricated list)', () => {
    const led = makeGroundingLedger()
    const scan = { thesis: 's', direction: 'long', candidates: [cand('FAKE', 90), cand('ALSO', 80)] }
    assert.equal(_normalizeScan(scan, null, led), null)
})

test('rehydrated keep:true candidate is exempt from the drop; grounding carries over', () => {
    const led = makeGroundingLedger()   // empty tape — nothing sourced/touched this session
    const editList = { thesis: 's', candidates: [
        { ticker: 'GRND', direction: 'long', thesis: 'kept', analysis: 'prior', grounding: 'sourced' },
    ] }
    const scan = { thesis: 's', direction: 'long', candidates: [{ ticker: 'GRND', keep: true }] }
    const out = _normalizeScan(scan, editList, led)
    assert.deepEqual(out.candidates.map(c => c.ticker), ['GRND'])           // not dropped
    assert.equal(out.candidates[0].grounding, 'sourced')                    // carried from prior save
    assert.equal(out.candidates[0].analysis, 'prior')                      // rehydrated verbatim
})

test('no-ledger path (back-compat): nothing dropped, grounding stays null', () => {
    const scan = { thesis: 's', direction: 'long', candidates: [cand('FAKE', 90)] }
    const out = _normalizeScan(scan)   // no ledger
    assert.deepEqual(out.candidates.map(c => c.ticker), ['FAKE'])
    assert.equal(out.candidates[0].grounding, null)
})
