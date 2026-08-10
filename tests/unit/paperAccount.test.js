import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeAccountId, accountMode, VIRTUAL_MODES } from '../../api/broker/paperBroker.service.js'

// Virtual-account ids encode the mode as a prefix (`<mode>-<userId>-<short>`) so that
// mode-derivation (isPaperIdea / accountMode) works off the id alone, and the short
// suffix lets a user hold several accounts per mode. userId is NOT parsed back out of
// the id, so a hyphenated userId must not confuse the mode prefix.

test('makeAccountId: `<mode>-<userId>-<short>`, mode prefix + unique suffix', () => {
    const id = makeAccountId('paper', 'u1')
    assert.match(id, /^paper-u1-[0-9a-f]{8}$/, 'shape')
    assert.notEqual(makeAccountId('paper', 'u1'), makeAccountId('paper', 'u1'), 'unique per call')
})

test('makeAccountId: manual mode', () => {
    assert.match(makeAccountId('manual', 'u1'), /^manual-u1-[0-9a-f]{8}$/)
})

test('accountMode: reads the mode back from the prefix', () => {
    assert.equal(accountMode(makeAccountId('paper', 'u1')),  'paper')
    assert.equal(accountMode(makeAccountId('manual', 'u1')), 'manual')
})

test('accountMode: a hyphenated userId does not break the prefix', () => {
    const id = makeAccountId('paper', 'user-123')
    assert.match(id, /^paper-user-123-[0-9a-f]{8}$/)
    assert.equal(accountMode(id), 'paper')
})

test('accountMode: non-virtual (real broker) id → null', () => {
    assert.equal(accountMode('12345678'),      null, 'cTrader-style numeric id')
    assert.equal(accountMode('ctrader-1'),     null, 'not a virtual mode prefix')
    assert.equal(accountMode(null),            null)
    assert.equal(accountMode(undefined),       null)
    assert.equal(accountMode(''),              null)
})

test('VIRTUAL_MODES is the paper/manual set', () => {
    assert.deepEqual([...VIRTUAL_MODES].sort(), ['manual', 'paper'])
})

// ─── Cash movements: the drift ritual's other half ──────────────────────────────
//
// Read at SOURCE level, the way statusLiterals.test.js does, because paperBroker talks to the DB
// directly with no injectable seam — so the invariant worth pinning ("a deposit is never P&L") cannot
// be reached behaviourally without a live database. A brittle guard on the one line that matters beats
// no guard on it at all.
// A dividend, deposit, withdrawal or fee happens OUTSIDE any trade. For a book at a bank we cannot
// read (docs/design/adopted-book.md §8) that is the only way the account's cash can ever be right.

test('a cash movement is not P&L, and that is the whole reason it is its own function', () => {
    // Folded into realizedPnl a deposit would inflate the track record by exactly the amount the user
    // paid in — the most flattering possible lie, and undetectable afterwards.
    const src = readFileSync(new URL('../../api/broker/paperBroker.service.js', import.meta.url), 'utf8')
    const fn  = src.slice(src.indexOf('async function adjustCash'), src.indexOf('async function resetAccount'))
    assert.match(fn, /\$inc:\s*\{\s*cashBalance: delta/, 'moves cash')
    assert.ok(!/realizedPnl/.test(fn), 'and never touches realized P&L')
})

test('a cash movement keeps a ledger, because "why is my cash different" is the question', () => {
    const src = readFileSync(new URL('../../api/broker/paperBroker.service.js', import.meta.url), 'utf8')
    const fn  = src.slice(src.indexOf('async function adjustCash'), src.indexOf('async function resetAccount'))
    assert.ok(fn.includes('cashMovements'), 'a bare balance cannot answer it')
    assert.ok(fn.includes('$slice: -200'), 'and the ledger is bounded, not unbounded')
})

test('an overdraw is refused rather than modelled', () => {
    const src = readFileSync(new URL('../../api/broker/paperBroker.service.js', import.meta.url), 'utf8')
    const fn  = src.slice(src.indexOf('async function adjustCash'), src.indexOf('async function resetAccount'))
    assert.ok(/next < 0/.test(fn) && /409/.test(fn), 'negative cash is a margin balance, which this store does not model')
})
