import { test } from 'node:test'
import assert from 'node:assert/strict'
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
