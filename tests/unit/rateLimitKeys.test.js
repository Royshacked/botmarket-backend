import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import { _byIp, _bySession } from '../../middleware/rateLimit.middleware.js'

// The rate-limit KEY GENERATORS — the cost ceiling's identity. The session key is where the care
// is: it hashes the cookie (so live credentials do not sit in an in-memory map for the window), and
// it falls back to the IP for an unauthenticated request. Neither had a test.

test('_byIp: an IPv6 address is collapsed to its subnet — one subscriber is not 10^19 buckets', () => {
    // ipKeyGenerator masks the host bits (a /56 prefix); addresses within it must share a bucket.
    const a = _byIp({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' })
    const b = _byIp({ ip: '2001:db8:1:2:1111:2222:3333:4444' })
    assert.equal(a, b, 'same subnet → same key')
    assert.match(a, /\/\d+$/, 'the key is a masked prefix, not the raw address')
    const c = _byIp({ ip: '2001:dead:beef::1' })
    assert.notEqual(a, c, 'a different subnet → a different key')
})

test('_byIp: a v4 address is its own key', () => {
    assert.notEqual(_byIp({ ip: '1.2.3.4' }), _byIp({ ip: '1.2.3.5' }))
})

test('_bySession: the key is a truncated sha256 of the cookie, never the cookie itself', () => {
    const token = 'a.jwt.value.that.must.not.be.stored'
    const key = _bySession({ cookies: { token }, ip: '1.2.3.4' })
    const expected = 's:' + createHash('sha256').update(token).digest('base64url').slice(0, 22)
    assert.equal(key, expected)
    assert.ok(!key.includes(token), 'the raw token never appears in the key')
})

test('_bySession: same cookie → same bucket, different cookies → different buckets', () => {
    const k1 = _bySession({ cookies: { token: 'aaa' }, ip: '9.9.9.9' })
    const k2 = _bySession({ cookies: { token: 'aaa' }, ip: '8.8.8.8' })
    const k3 = _bySession({ cookies: { token: 'bbb' }, ip: '9.9.9.9' })
    assert.equal(k1, k2, 'the session, not the IP, is the bucket for an authed request')
    assert.notEqual(k1, k3)
})

test('_bySession: no cookie falls back to the IP key — an office NAT is not one shared bucket at the door', () => {
    // Without a token the session limiter keys on IP, exactly as _byIp would.
    const noCookie = _bySession({ cookies: {}, ip: '1.2.3.4' })
    assert.equal(noCookie, _byIp({ ip: '1.2.3.4' }))
    assert.equal(_bySession({ ip: '1.2.3.4' }), _byIp({ ip: '1.2.3.4' }), 'no cookies object at all')
})
