import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTtlCache } from '../../services/ttlCache.util.js'

test('ttlCache: stores and returns a value within ttl', () => {
    const c = createTtlCache({ ttlMs: 10_000 })
    c.set('a', 42)
    assert.equal(c.get('a'), 42)
    assert.equal(c.get('missing'), undefined)
})

test('ttlCache: expired entries return undefined', () => {
    const c = createTtlCache({ ttlMs: -1 })   // everything is already stale
    c.set('a', 1)
    assert.equal(c.get('a'), undefined)
})

test('ttlCache: evicts the oldest entry past max (not a full clear)', () => {
    const c = createTtlCache({ ttlMs: 10_000, max: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)                 // 'a' is the oldest → evicted
    assert.equal(c.get('a'), undefined)
    assert.equal(c.get('b'), 2)
    assert.equal(c.get('c'), 3)
})

// set() returns the stored value so callers can `return cache.set(k, await compute())`
// in one line — the shape chartImgCache + portfolioState now use.
test('ttlCache: set returns the stored value', () => {
    const c = createTtlCache({ ttlMs: 10_000 })
    assert.equal(c.set('a', 'png'), 'png')
})

// paperExecution's FMP negative-cache is "a fresh entry means suppressed; expiry IS the
// retry" — it guards on `!cache.get(sym)`, so a stale read must be falsy AND self-evicting.
test('ttlCache: a stale read evicts, so presence alone never suppresses forever', () => {
    const c = createTtlCache({ ttlMs: -1 })   // everything is already stale
    c.set('AVGO', true)
    assert.equal(c.get('AVGO'), undefined, 'stale entry must not read as suppressed')
    assert.equal(c.delete('AVGO'), false, 'the stale read already removed it')
})
