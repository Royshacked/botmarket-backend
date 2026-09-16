import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { errorHandler, makeHandle } from '../../api/_shared/handle.util.js'
import { httpError } from '../../services/httpError.util.js'
import { fakeRes, runHandler } from '../helpers/http.js'

// What an error may tell the client — the rule decided in the §9 review (2026-09-16), pinned.
//
// The handler used to answer every error with `err.message`, and the client shows `data.error` in a
// toast: a duplicate username rendered the Mongo E11000 line — database, collection, index — to the
// user. And it honoured ANY `err.status`, including the one http.util stamps from a provider, so a
// Finnhub 429 inside a read would have answered the client 429 "finnhub 429".

const req = { method: 'GET', originalUrl: '/api/x' }
const savedEnv = process.env.NODE_ENV
afterEach(() => { if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv })

test('an error minted with httpError answers with its status and its sentence, in production too', () => {
    process.env.NODE_ENV = 'production'
    const res = fakeRes()
    errorHandler(httpError(409, 'Username already exists'), req, res, () => {})
    assert.equal(res.statusCode, 409)
    assert.deepEqual(res.body, { error: 'Username already exists' })
})

test('a bare throw is a 500 whose sentence stays inside in production', () => {
    process.env.NODE_ENV = 'production'
    const res = fakeRes()
    errorHandler(new Error('E11000 duplicate key error collection: test.users index: username_1'), req, res, () => {})
    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.body, { error: 'Internal server error' })
})

test('in development the 500 carries the message — the developer is the reader', () => {
    process.env.NODE_ENV = 'development'
    const res = fakeRes()
    errorHandler(new Error('ENOMEM: spawn failed'), req, res, () => {})
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.error, 'ENOMEM: spawn failed')
})

test("a PROVIDER's status is not ours — an un-exposed err.status is answered as a 500", () => {
    process.env.NODE_ENV = 'production'
    // The shape http.util.getJson throws: status stamped, nothing said about exposing it.
    const providerErr = Object.assign(new Error('finnhub 429'), { status: 429, body: { error: 'rate limited' } })
    const res = fakeRes()
    errorHandler(providerErr, req, res, () => {})
    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.body, { error: 'Internal server error' })
})

test("body-parser's malformed-JSON error (status 400, expose true) is answered like ours", () => {
    process.env.NODE_ENV = 'production'
    const res = fakeRes()
    errorHandler(Object.assign(new SyntaxError('Unexpected token } in JSON'), { status: 400, expose: true, type: 'entity.parse.failed' }), req, res, () => {})
    assert.equal(res.statusCode, 400)
    assert.match(res.body.error, /Unexpected token/)
})

test('an exposed status outside 400–599 is not trusted', () => {
    const res = fakeRes()
    errorHandler(Object.assign(new Error('odd'), { status: 42, expose: true }), req, res, () => {})
    assert.equal(res.statusCode, 500)
})

test('headers already sent: nothing to write — the error is passed on for Express to close the socket', () => {
    const res = fakeRes(); res.headersSent = true
    let passed = null
    errorHandler(new Error('late'), req, res, e => { passed = e })
    assert.equal(passed?.message, 'late')
    assert.equal(res.body, null)
})

test('httpError carries extra fields, so a refusal can name its reason', () => {
    const err = httpError(409, 'not ready', { reason: 'not_ready', state: 'queued' })
    assert.equal(err.status, 409)
    assert.equal(err.expose, true)
    assert.equal(err.reason, 'not_ready')
    assert.equal(err.state, 'queued')
})

test('makeHandle → errorHandler: the whole pipe, end to end — via the shared runHandler', async () => {
    process.env.NODE_ENV = 'production'
    const handle = makeHandle('[test]')
    const handler = handle('boom', async () => { throw httpError(404, 'Thread not found') })
    const res = await runHandler(handler, {}, { url: '/api/x' })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.body, { error: 'Thread not found' })
})
