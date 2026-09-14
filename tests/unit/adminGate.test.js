import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { requireAdmin } from '../../middleware/auth.middleware.js'
import { visibleConversationsFor, ADMIN_BOT_IDS, RETIRED_BOT_IDS } from '../../api/chat/chat.service.js'

// Pythia is admin-only (2026-09-14): the chat, the tilt log, the Forecasts board and the social
// feed. The server owns the gate — the client hiding a desk is a courtesy, not a rule — so these
// tests pin the three server-side pieces: the middleware, the route file that mounts it on EVERY
// strategy route, and the thread filter that keeps a demoted admin from reading the house desk
// through a thread the role no longer entitles them to.

const here = dirname(fileURLToPath(import.meta.url))
const routesSrc = readFileSync(join(here, '../../api/strategy/strategy.routes.js'), 'utf8')
const scannerSrc = readFileSync(join(here, '../../api/scanner/scanner.routes.js'), 'utf8')
const mentorSrc  = readFileSync(join(here, '../../api/mentor/mentor.routes.js'), 'utf8')
const setupsSrc  = readFileSync(join(here, '../../api/setups/setups.routes.js'), 'utf8')

// ── the middleware ───────────────────────────────────────────────────────────

function _res() {
    const r = { code: null, body: null }
    r.status = c => { r.code = c; return r }
    r.json   = b => { r.body = b; return r }
    return r
}

test('requireAdmin: an admin token passes', () => {
    let called = false
    requireAdmin({ user: { role: 'admin' } }, _res(), () => { called = true })
    assert.equal(called, true)
})

test('requireAdmin: a trader, a role-less token, and no user at all are all 403', () => {
    for (const req of [{ user: { role: 'trader' } }, { user: {} }, {}]) {
        let called = false
        const res = _res()
        requireAdmin(req, res, () => { called = true })
        assert.equal(called, false)
        assert.equal(res.code, 403)
    }
})

// ── the strategy router mounts it before ANY route ───────────────────────────

test('strategy routes: requireAdmin is router-wide, ahead of every route', () => {
    const gate  = routesSrc.indexOf('router.use(requireAdmin)')
    const first = routesSrc.indexOf('router.post(')
    const firstGet = routesSrc.indexOf('router.get(')
    assert.ok(gate > 0, 'router.use(requireAdmin) is present')
    assert.ok(gate < first && gate < firstGet, 'the gate is mounted before the first route')
    // and the reads are no longer the broadcast they used to be
    assert.doesNotMatch(routesSrc, /router\.get\([^\n]*requireAuth\b/)
})

// ── Argus and Mentor are the same desks for everyone ─────────────────────────

// Decided 2026-09-14 with the other desks: the scan desk and the trade desk have no admin side.
// Scans and setups are owner-scoped (each user sees their own, admins included), the streams are
// open, Talos watches every user's setups alike, and a trader reaches Argus through Atlas's sleeve
// hop as well. Pinned so a gate cannot slip into a router unnoticed.
test('scanner, mentor and setups routes: authenticated, never admin-gated', () => {
    for (const src of [scannerSrc, mentorSrc, setupsSrc]) {
        assert.match(src, /router\.use\(requireAuth\)/)
        assert.doesNotMatch(src, /requireAdmin/)
    }
})

// ── the thread filter ────────────────────────────────────────────────────────

const axl      = { id: 'c1', participants: ['u1', 'axl'] }
const pythia   = { id: 'c2', participants: ['u1', 'strategy'] }
const retired  = { id: 'c3', participants: ['u1', 'idea'] }
const human    = { id: 'c4', participants: ['u1', 'u2'] }

test('the strategy and analyst feeds are the admin-only ones; idea stays the retired one', () => {
    assert.deepEqual(ADMIN_BOT_IDS, ['strategy', 'analyst'])
    assert.deepEqual(RETIRED_BOT_IDS, ['idea'])
})

test('visibleConversationsFor: an admin sees every live thread, still never a retired one', () => {
    assert.deepEqual(visibleConversationsFor([axl, pythia, retired, human], 'admin').map(c => c.id), ['c1', 'c2', 'c4'])
})

test('visibleConversationsFor: a trader (or a role-less legacy token) never sees the Pythia thread', () => {
    for (const role of ['trader', null, undefined]) {
        assert.deepEqual(visibleConversationsFor([axl, pythia, retired, human], role).map(c => c.id), ['c1', 'c4'])
    }
})

test('visibleConversationsFor: tolerant of a non-array', () => {
    assert.deepEqual(visibleConversationsFor(null, 'admin'), [])
})
