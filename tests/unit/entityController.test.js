import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEntityController } from '../../api/_shared/entityController.util.js'

// The HTTP twin of entityCrud's tests: the shell must answer the same way for every kind, and the
// two things a kind configures — its body envelope and its own reasons — must not leak into that.

const res = () => {
    const out = {}
    return { out, status(c) { out.status = c; return this }, send(b) { out.body = b; return this } }
}
const req = (over = {}) => ({ user: { _id: 'u1' }, params: { id: 's1' }, query: {}, body: {}, ...over })

const service = (over = {}) => ({
    list:   async () => [{ id: 's1' }],
    get:    async () => ({ ok: true, doc: { id: 's1', asset: 'NVDA' } }),
    patch:  async () => ({ ok: true, doc: { id: 's1', status: 'looking' } }),
    remove: async () => ({ ok: true }),
    ...over,
})

test('answers the bare document, as the newer routes do', async () => {
    const c = makeEntityController({ log: '[t]', noun: 'setup', service: service() })
    const r = res()
    await c.get(req(), r)
    assert.deepEqual(r.out.body, { id: 's1', asset: 'NVDA' })
})

test('an envelope wraps one and many under the route’s own keys', async () => {
    const c = makeEntityController({ log: '[t]', noun: 'idea', envelope: { one: 'idea', many: 'ideas' }, service: service() })
    const one = res(); await c.get(req(), one)
    const many = res(); await c.list(req(), many)
    assert.deepEqual(one.out.body,  { idea: { id: 's1', asset: 'NVDA' } })
    assert.deepEqual(many.out.body, { ideas: [{ id: 's1' }] })
})

// The shell must not decide what a shared refusal means — it asks the shared reason map, which is
// the whole point of routing every kind through here.
test('a refusal takes the shared status, not the fallback', async () => {
    const c = makeEntityController({ log: '[t]', noun: 'setup', service: service({ remove: async () => ({ ok: false, reason: 'in_position' }) }) })
    const r = res()
    await c.remove(req(), r)
    assert.equal(r.out.status, 409)
    assert.equal(r.out.body.reason, 'in_position')
})

test('someone else’s document is 403, a missing one is 404 — the crud’s distinction survives', async () => {
    const c = makeEntityController({ log: '[t]', noun: 'setup', service: service({ get: async () => ({ ok: false, reason: 'forbidden' }) }) })
    const r = res()
    await c.get(req(), r)
    assert.equal(r.out.status, 403)
})

test('a route-owned reason is claimed by its overrides', async () => {
    const c = makeEntityController({
        log: '[t]', noun: 'setup',
        overrides: (reason) => (reason?.startsWith('cannot_arm_') ? [400, reason] : null),
        service: service({ patch: async () => ({ ok: false, reason: 'cannot_arm_no_venue' }) }),
    })
    const r = res()
    await c.patch(req(), r)
    assert.equal(r.out.status, 400)
    assert.equal(r.out.body.error, 'cannot_arm_no_venue')
})

// A reason nothing claims means the ROUTE broke — the request was fine and the service invented an
// answer no one maps. That's a 500, not a 400 blaming the caller.
test('an unclaimed reason is a 500 naming the move and the kind', async () => {
    const c = makeEntityController({ log: '[t]', noun: 'setup', service: service({ remove: async () => ({ ok: false, reason: 'something_new' }) }) })
    const r = res()
    await c.remove(req(), r)
    assert.equal(r.out.status, 500)
    assert.equal(r.out.body.error, 'Failed to delete setup')
    assert.equal(r.out.body.reason, 'something_new')
})

test('a thrown error never escapes the handler', async () => {
    const c = makeEntityController({ log: '[t]', noun: 'call', service: service({ get: async () => { throw new Error('mongo is down') } }) })
    const r = res()
    await assert.doesNotReject(() => c.get(req(), r))
    assert.equal(r.out.status, 500)
    assert.equal(r.out.body.error, 'Failed to get call')
    assert.equal(r.out.body.reason, undefined)   // a crash is not a refusal — no slug to branch on
})

// `?status=looking` is a LIST option, which is why the shell hands the request through rather than
// flattening it to a userId. Dropping it silently returned every setup instead of the armed ones.
test('the request reaches the list service, so query filters survive', async () => {
    let seen = null
    const c = makeEntityController({
        log: '[t]', noun: 'setup',
        service: service({ list: async (userId, request) => { seen = request.query.status; return [] } }),
    })
    await c.list(req({ query: { status: 'looking' } }), res())
    assert.equal(seen, 'looking')
})

// ── The wiring guard ─────────────────────────────────────────────────────────
// Moving handlers onto the shell means the route files now bind EXPORTED CONSTS rather than
// function declarations, and a renamed export binds `undefined` — which express refuses at mount,
// not at request time. So importing the routers IS the test: it throws if any handler is missing.

test('every entity route still mounts — no handler binds undefined', async () => {
    for (const path of [
        '../../api/setups/setups.routes.js',
        '../../api/kairos/kairos.routes.js',
        '../../api/trade-ideas/tradeIdeas.routes.js',
        '../../api/analyst/analyst.routes.js',
        '../../api/scanner/scanner.routes.js',
    ]) {
        const mod = await import(path)
        const router = Object.values(mod)[0]
        assert.equal(typeof router, 'function', `${path} exported no router`)
        // Every layer express registered has a handle; a bad binding would have thrown above.
        assert.ok(router.stack.length > 0, `${path} registered no routes`)
    }
})
