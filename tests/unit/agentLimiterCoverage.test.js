import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// EVERY ENDPOINT THAT BUYS TOKENS IS RATE-LIMITED — checked, not remembered.
//
// server.js pins `agentLimiter` to the stream paths by listing the desks. That list is correct
// today and it is the kind that goes stale in silence: a seventh desk ships, its `POST /stream` is
// mounted like every other route, and the only thing missing is one entry in an array three
// hundred lines away. Nothing fails. The endpoint simply runs on the general API limiter — which
// exists to stop scraping, not to bound spend — so a loop against it buys model turns until
// somebody reads a bill.
//
// The same failure shape `loopContract` guards for background loops (a service without `stop()`
// silently never runs) and `promptPaths` guards for prompts. This is that guard for spend.
//
// It works from the SOURCE rather than by booting the app: mounting order is what makes the
// limiter effective at all (Express runs middleware in mount order, so a limiter registered after
// its router never sees the request), and that ordering is a property of the file.

const ROOT      = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const SERVER    = readFileSync(join(ROOT, 'server.js'), 'utf8')
const API_DIR   = join(ROOT, 'api')

/** Every path handed to `agentLimiter`, including the ones built in the desk loop. */
function limitedPaths() {
    const paths = new Set()

    // The desk loop: `for (const desk of ['axl', ...]) app.use(`/api/${desk}/stream`, agentLimiter)`
    const loop = SERVER.match(/for\s*\(\s*const\s+desk\s+of\s*\[([^\]]*)\]/)
    const tmpl = SERVER.match(/app\.use\(\s*`([^`]*\$\{desk\}[^`]*)`\s*,\s*agentLimiter\s*\)/)
    if (loop && tmpl) {
        for (const raw of loop[1].split(',')) {
            const desk = raw.trim().replace(/^['"]|['"]$/g, '')
            if (desk) paths.add(tmpl[1].replace('${desk}', desk))
        }
    }

    // Any explicitly listed path: `app.use('/api/axl/brief/stream', agentLimiter)`
    for (const m of SERVER.matchAll(/app\.use\(\s*['"]([^'"]+)['"]\s*,\s*agentLimiter\s*\)/g)) paths.add(m[1])

    return paths
}

/** feature folder → the prefix server.js actually mounts its router at. */
function mountPrefixes() {
    const byRouter = new Map()   // routerName → folder
    for (const m of SERVER.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*['"]\.\/api\/([^/]+)\/[^'"]+['"]/g)) {
        byRouter.set(m[1], m[2])
    }
    const byFolder = new Map()   // folder → mount path
    for (const m of SERVER.matchAll(/app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+Routes)\s*\)/g)) {
        const folder = byRouter.get(m[2])
        if (folder) byFolder.set(folder, m[1])
    }
    return byFolder
}

/** Every streaming endpoint the API actually exposes, as its full mounted path. */
function streamEndpoints() {
    const mounts = mountPrefixes()
    const found  = []

    for (const folder of readdirSync(API_DIR)) {
        const file = join(API_DIR, folder, `${folder}.routes.js`)
        if (!existsSync(file)) continue
        const src = readFileSync(file, 'utf8')
        for (const m of src.matchAll(/router\.post\(\s*['"]([^'"]*stream[^'"]*)['"]/g)) {
            const prefix = mounts.get(folder)
            // A router nothing mounts cannot be reached, so it cannot be abused either.
            if (prefix) found.push({ folder, path: `${prefix}${m[1]}`.replace(/\/$/, '') })
        }
    }
    return found
}

test('every streaming endpoint is behind the agent rate limiter', () => {
    const limited  = limitedPaths()
    const streams  = streamEndpoints()

    // Guard the guard: if the parsing above ever stops finding anything, this test would pass by
    // vacuously checking nothing — the exact way a file-walking test rots into decoration.
    assert.ok(streams.length >= 6, `expected to find the desks' stream routes, found ${streams.length}`)
    assert.ok(limited.size >= 6, `expected to parse the limiter list, found ${limited.size}`)

    const unlimited = streams.filter(s => !limited.has(s.path))
    assert.deepEqual(unlimited.map(s => s.path), [],
        'these endpoints buy model turns with no spend limit — add them to the agentLimiter block in server.js')
})

test('the limiter is mounted BEFORE the desk routers it protects', () => {
    // Express runs middleware in mount order, so a limiter registered after its route never sees the
    // request. The block carries a comment saying so; this is that comment made enforceable.
    //
    // Against the DESK routers specifically, not every router: `/api/health` is mounted ahead of all
    // the limiters on purpose, so that a probe still answers while the app is being hammered. An
    // earlier draft of this test compared against the first router of any kind and failed on exactly
    // that — the deliberate exception looked like the bug.
    const firstLimiter = SERVER.search(/app\.use\([^)]*agentLimiter\s*\)/)
    assert.ok(firstLimiter > -1, 'no agentLimiter mount found')

    const deskFolders = new Set(streamEndpoints().map(s => s.folder))
    const byRouter    = new Map()
    for (const m of SERVER.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*['"]\.\/api\/([^/]+)\/[^'"]+['"]/g)) {
        byRouter.set(m[1], m[2])
    }

    const late = []
    for (const m of SERVER.matchAll(/app\.use\(\s*['"][^'"]+['"]\s*,\s*(\w+Routes)\s*\)/g)) {
        if (!deskFolders.has(byRouter.get(m[1]))) continue
        if (m.index < firstLimiter) late.push(m[1])
    }
    assert.deepEqual(late, [], 'these desk routers are mounted ahead of agentLimiter, so it never runs for them')
})

test('a limited path that no route serves is dead weight, and says so', () => {
    // The other direction: a desk archived without tidying leaves a limiter pointing at nothing.
    // Harmless, but it is how the list stops describing the app — and this list is only useful for
    // as long as it does. Kairos was archived in 2026-08 and its entry went with it, which is the
    // behaviour being pinned.
    const served = new Set(streamEndpoints().map(s => s.path))
    const stale  = [...limitedPaths()].filter(p => !served.has(p))
    assert.deepEqual(stale, [], 'these paths are rate-limited but no router serves them')
})
