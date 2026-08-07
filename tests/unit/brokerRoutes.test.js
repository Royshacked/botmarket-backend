import { test } from 'node:test'
import assert from 'node:assert/strict'

import { brokerRoutes } from '../../api/broker/broker.routes.js'
import { tradesRoutes } from '../../api/trades/trades.routes.js'

// Broker and trades were the last two features holding their handlers inline in the routes file.
// Moving them into controllers is a pure relocation, so what these lock is that it STAYED pure:
// the same paths, the same methods, and — the part that actually matters — the same auth boundary.
//
// The boundary moved shape in the process. Twelve handlers each carried `requireAuth` as their own
// second argument; they now sit behind one `router.use(requireAuth)`. That is equivalent ONLY
// because Express walks the stack in declaration order, so the layer's POSITION is load-bearing:
// `/callback` has to be registered above it. Registering it below would silently start requiring a
// session on the one route that cannot have one — the browser arrives there from the broker's
// domain — and OAuth would break for every broker at once, at the last step of connecting.

const routesOf = router => router.stack
    .filter(l => l.route)
    .map(l => ({
        path: l.route.path,
        methods: Object.keys(l.route.methods).filter(m => l.route.methods[m]).sort(),
    }))

/** Index of the router-level requireAuth layer, or -1. */
const authLayerIndex = router => router.stack.findIndex(l => !l.route && l.name === 'requireAuth')

/** Does this route sit behind the router-level guard, or carry its own? */
function isGuarded(router, path) {
    const authAt = authLayerIndex(router)
    const at = router.stack.findIndex(l => l.route?.path === path)
    assert.notEqual(at, -1, `no such route: ${path}`)
    if (authAt !== -1 && at > authAt) return true
    return router.stack[at].route.stack.some(h => h.name === 'requireAuth')
}

test('every broker route the frontend calls is still registered', () => {
    const actual = routesOf(brokerRoutes)
    assert.deepEqual(actual, [
        { path: '/connect/:type',              methods: ['get'] },
        { path: '/callback',                   methods: ['get'] },
        { path: '/connections',                methods: ['get'] },
        { path: '/connections/:type',          methods: ['delete'] },
        { path: '/connections/:type/account',  methods: ['patch'] },
        { path: '/:type/trading-accounts',     methods: ['get'] },
        { path: '/:type/capabilities',         methods: ['get'] },
        { path: '/:type/account',              methods: ['get'] },
        { path: '/:type/positions',            methods: ['get'] },
        { path: '/:type/positions/:positionId', methods: ['delete'] },
        { path: '/:type/orders',               methods: ['get'] },
        { path: '/:type/orders',               methods: ['post'] },
        { path: '/:type/orders/:orderId',      methods: ['patch'] },
        { path: '/:type/orders/:orderId',      methods: ['delete'] },
    ])
})

test('the OAuth callback is the ONLY unauthenticated broker route', () => {
    const open = routesOf(brokerRoutes)
        .map(r => r.path)
        .filter(p => !isGuarded(brokerRoutes, p))
    assert.deepEqual(open, ['/callback'],
        'a route slipped below/above the requireAuth layer — check the declaration order in broker.routes.js')
})

test('the literal paths are declared before the /:type wildcard', () => {
    // `/connections` and `/callback` would otherwise bind `connections`/`callback` as a broker type.
    const paths = routesOf(brokerRoutes).map(r => r.path)
    const firstWildcard = paths.findIndex(p => p.startsWith('/:type'))
    const literals = ['/connect/:type', '/callback', '/connections', '/connections/:type', '/connections/:type/account']
    for (const lit of literals) {
        assert.ok(paths.indexOf(lit) < firstWildcard, `${lit} must be declared before the /:type routes`)
    }
})

test('trades exposes exactly its two read routes, both guarded', () => {
    assert.deepEqual(routesOf(tradesRoutes), [
        { path: '/stats', methods: ['get'] },
        { path: '/',      methods: ['get'] },
    ])
    // /stats above / — a literal must never sit below a route that could swallow it.
    for (const p of ['/stats', '/']) assert.ok(isGuarded(tradesRoutes, p), `${p} is unauthenticated`)
})
