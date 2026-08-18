import { test } from 'node:test'
import assert from 'node:assert/strict'

import { securityHeaders } from '../../middleware/securityHeaders.middleware.js'

// Two things are worth locking here, and neither is "the headers exist".
//
// The microphone permission is a CARRIED-OVER behaviour: it used to be its own inline middleware in
// server.js, and losing it in the sweep would break voice input into /api/transcribe with no error
// anywhere — the browser simply refuses the mic.
//
// HSTS must stay production-only. Setting it on a dev box pins `localhost` to HTTPS in the
// developer's browser for a year, and every other plain-HTTP project on that port inherits it.

function run() {
    const headers = {}
    const res = { setHeader: (k, v) => { headers[k] = v } }
    let nexted = false
    securityHeaders({}, res, () => { nexted = true })
    return { headers, nexted }
}

test('the hardening headers are set, and the chain continues', () => {
    const { headers, nexted } = run()
    assert.equal(nexted, true, 'a middleware that forgets next() hangs every request')
    assert.equal(headers['X-Content-Type-Options'], 'nosniff')
    assert.equal(headers['X-Frame-Options'], 'DENY')
    assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin')
    assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin')
    assert.equal(headers['X-DNS-Prefetch-Control'], 'off')
})

test('the microphone permission survived the move out of server.js', () => {
    assert.equal(run().headers['Permissions-Policy'], 'microphone=*')
})

test('no Content-Security-Policy is set — turning one on blind white-screens the SPA', () => {
    // Absent ON PURPOSE (see the middleware header). This asserts the decision so that adding a
    // CSP has to be a deliberate change with the app in front of you, not a silent default.
    assert.equal('Content-Security-Policy' in run().headers, false)
})

test('HSTS is production-only', () => {
    const prior = process.env.NODE_ENV
    try {
        process.env.NODE_ENV = 'development'
        assert.equal('Strict-Transport-Security' in run().headers, false)

        process.env.NODE_ENV = 'production'
        assert.match(run().headers['Strict-Transport-Security'], /^max-age=31536000; includeSubDomains$/)
    } finally {
        if (prior === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = prior
    }
})
