import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { makeDeskStream } from '../../api/_shared/deskStream.util.js'

// The ONE streaming desk turn (makeDeskStream). Every desk's POST /api/<desk>/stream rides it, so
// what these pin holds for all seven: the body parse and its 400s, the argument bag every agent
// gets, the routing gate on every `done`, and a stopped turn sending nothing.

function makeReqRes(body, role = 'user') {
    const res = new EventEmitter()
    res.statusCode = 200
    res.writes = []
    res.ended = false
    res.headers = {}
    res.setHeader    = (k, v) => { res.headers[k] = v }
    res.flushHeaders = () => {}
    res.write  = (chunk) => { res.writes.push(chunk); return true }
    res.end    = () => { res.ended = true }
    res.status = (c) => { res.statusCode = c; return res }
    res.json   = (b) => { res.body = b; res.ended = true; return res }
    const req = new EventEmitter()
    req.body = body
    req.user = { _id: 'u1', role }
    return { req, res }
}

function events(res) {
    return res.writes.join('').split('\n\n').map(block => {
        const ev = block.match(/event: (\w+)/)?.[1]
        const dt = block.match(/data: (.+)/)?.[1]
        return ev ? { event: ev, data: dt ? JSON.parse(dt) : null } : null
    }).filter(Boolean)
}

const deps = { experience: async () => 'novice' }
const hi = { messages: [{ role: 'user', content: 'hi' }] }

test('a bad body is a 400 BEFORE the stream opens — the agent never runs', async () => {
    let ran = false
    const handler = makeDeskStream({ log: '[t]', run: async () => { ran = true; return { reply: 'x' } }, done: r => r }, deps)
    const { req, res } = makeReqRes({ messages: [] })
    await handler(req, res)
    assert.equal(res.statusCode, 400)
    assert.match(res.body.error, /non-empty array/)
    assert.equal(ran, false)
    assert.equal(res.writes.length, 0, 'no SSE frame was written')
})

test("a desk's own parse can refuse with a 400 too", async () => {
    const handler = makeDeskStream({
        log: '[t]', parse: () => ({ error: 'bad seed' }), run: async () => ({ reply: 'x' }), done: r => r,
    }, deps)
    const { req, res } = makeReqRes(hi)
    await handler(req, res)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'bad seed')
})

test("a desk parse that THROWS reaches the error handler — the request never hangs", async () => {
    const handler = makeDeskStream({
        log: '[t]', parse: async () => { throw new Error('mongo down') }, run: async () => ({ reply: 'x' }), done: r => r,
    }, deps)
    const { req, res } = makeReqRes(hi)
    const seen = []
    await handler(req, res, (err) => seen.push(err))
    assert.equal(seen.length, 1)
    assert.match(seen[0].message, /mongo down/)
    assert.equal(res.writes.length, 0, 'no stream was opened')
})

test('the experience read runs alongside the parse, not after it', async () => {
    const order = []
    const handler = makeDeskStream({
        log: '[t]',
        parse: async () => { order.push('parse:start'); await new Promise(r => setTimeout(r, 20)); order.push('parse:end'); return {} },
        run: async () => ({ reply: 'x' }), done: r => r,
    }, { experience: async () => { order.push('experience'); return 'novice' } })
    const { req, res } = makeReqRes(hi)
    await handler(req, res)
    assert.ok(order.indexOf('experience') < order.indexOf('parse:end'), order.join(','))
})

test('the agent gets the common bag: conversation, model, user, audience, signal and the SSE callbacks', async () => {
    let seen = null
    const handler = makeDeskStream({
        log: '[t]',
        parse: (req, turn) => ({ echo: turn.messages.length }),
        run: async ({ common, extras }) => { seen = { common, extras }; return { reply: 'ok' } },
        done: r => ({ reply: r.reply }),
    }, deps)
    const { req, res } = makeReqRes({ ...hi, model: 'claude-sonnet-5' })
    await handler(req, res)
    assert.deepEqual(seen.common.messages, [{ role: 'user', content: 'hi' }])
    assert.equal(seen.common.model, 'claude-sonnet-5')
    assert.equal(seen.common.userId, 'u1')
    assert.equal(seen.common.audience, 'novice')
    assert.ok(seen.common.signal)
    for (const cb of ['onToken', 'onToolStart', 'onReasoning', 'onChart']) assert.equal(typeof seen.common[cb], 'function', cb)
    assert.deepEqual(seen.extras, { echo: 1 })
})

test('every done payload carries the routing fields, validated for the role — a desk cannot forget the gate', async () => {
    const handler = makeDeskStream({
        log: '[t]',
        run: async () => ({ reply: 'go', route: 'research', routeSymbol: 'NVDA' }),
        done: r => ({ reply: r.reply }),
    }, deps)
    const { req, res } = makeReqRes(hi)
    await handler(req, res)
    const done = events(res).find(e => e.event === 'done').data
    assert.equal(done.reply, 'go')
    assert.equal(done.route, 'research')
    assert.equal(done.routeSymbol, 'NVDA')
})

test('an admin-only desk route is dropped for a trader by the same gate', async () => {
    const handler = makeDeskStream({
        log: '[t]', run: async () => ({ reply: 'go', route: 'strategy' }), done: r => ({ reply: r.reply }),
    }, deps)
    const { req, res } = makeReqRes(hi, 'user')
    await handler(req, res)
    assert.equal(events(res).find(e => e.event === 'done').data.route ?? null, null)
})

test('done reads the validated routing when it builds its own payload', async () => {
    let routing = null
    const handler = makeDeskStream({
        log: '[t]', run: async () => ({ reply: 'go', route: 'portfolio' }),
        done: (r, ctx) => { routing = ctx.routing; return { reply: r.reply } },
    }, deps)
    const { req, res } = makeReqRes(hi)
    await handler(req, res)
    assert.equal(routing.route, 'portfolio')
})

test('a run that returns null (the user stopped it) sends an empty done, not a reply', async () => {
    const handler = makeDeskStream({ log: '[t]', run: async () => null, done: () => { throw new Error('must not be called') } }, deps)
    const { req, res } = makeReqRes(hi)
    await handler(req, res)
    assert.deepEqual(events(res).find(e => e.event === 'done').data, {})
})
