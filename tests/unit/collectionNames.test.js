import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A GUARD, in the same family as the shared-reason guard on the controllers: it fails the build
// rather than describing a convention nobody can enforce by reading.
//
// THE RULE. A physical collection name is written down ONCE, by the module that owns the schema,
// and every other reader imports it. `entityCollection.ENTITIES` and `user.model.COLLECTION` were
// already doing this; six other names were not, and the copies straddled the api/ ↔ monitoring/
// boundary — 'coverage' in the coverage service AND its monitor, 'tilt' in both, 'paperOrders' and
// 'paperPositions' in the paper broker AND the loops that drain them, plus 'trades' and
// 'portfolio_chats' typed inline by a cross-module reader.
//
// Why a duplicate is worse than untidy: nothing FAILS when the two copies disagree. A rename lands
// in one file, the other keeps reading a collection that no longer receives writes, and the symptom
// is a monitor that quietly watches nothing.

// fileURLToPath, not `.pathname` — the repo path contains a space, which a URL percent-encodes.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DIRS = ['api', 'services', 'monitoring', 'providers']

// A dead module is not a second source of truth for anything, but it still LOOKS like one to a
// reader. Listed explicitly so removing the file removes the exemption with it.
const IGNORED_FILES = new Set([
    'entityStore.service.js',   // the kind-blind store seam — no consumers (ENTITY_MODEL P0)
])

function sourceFiles(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) { sourceFiles(full, acc); continue }
        if (name.endsWith('.js') && !IGNORED_FILES.has(name)) acc.push(full)
    }
    return acc
}

// `db.collection('literal')` — a name typed at the call site instead of imported.
const INLINE_CALL = /\.collection\(\s*'([a-z_A-Z]+)'\s*\)/g
// `const NAME = 'literal'` where the literal looks like a collection this app owns. Matching on the
// declaration (rather than every string in the file) keeps prose and enum values out of it.
const DECLARED = /^\s*(?:export\s+)?const\s+[A-Z_]+\s*=\s*'([a-z][a-zA-Z_]*)'\s*(?:\/\/.*)?$/gm

// The declared names that ARE collections. Anything not on this list is some other constant that
// happens to be an uppercase string, so the guard stays quiet about it.
const COLLECTIONS = new Set([
    'entities', 'users', 'user_experience', 'coverage', 'tilt', 'trades', 'threads', 'scans',
    'scanner_chats', 'portfolio_chats', 'brokerConnections', 'token_usage',
    'chat_conversations', 'chat_messages',
    'paperAccounts', 'paperPositions', 'paperOrders', 'paperEquity',
])

test('every collection name is declared in exactly one module', () => {
    const declaredIn = new Map()   // name → [file, ...]

    for (const dir of DIRS) {
        for (const file of sourceFiles(join(ROOT, dir))) {
            const src = readFileSync(file, 'utf-8')
            for (const m of src.matchAll(DECLARED)) {
                if (!COLLECTIONS.has(m[1])) continue
                const rel = file.slice(ROOT.length).replace(/\\/g, '/')
                if (!declaredIn.has(m[1])) declaredIn.set(m[1], [])
                declaredIn.get(m[1]).push(rel)
            }
        }
    }

    const dupes = [...declaredIn].filter(([, files]) => files.length > 1)
    assert.deepEqual(dupes, [],
        `these collection names are declared in more than one module — import the owner's export instead:\n` +
        dupes.map(([n, f]) => `  '${n}' in ${f.join(' AND ')}`).join('\n'))
})

test('no module names a collection inline at a db.collection() call site', () => {
    const offenders = []

    for (const dir of DIRS) {
        for (const file of sourceFiles(join(ROOT, dir))) {
            const src = readFileSync(file, 'utf-8')
            for (const m of src.matchAll(INLINE_CALL)) {
                if (!COLLECTIONS.has(m[1])) continue
                offenders.push(`${file.slice(ROOT.length).replace(/\\/g, '/')} → db.collection('${m[1]}')`)
            }
        }
    }

    assert.deepEqual(offenders, [],
        `a collection named inline at the call site cannot be renamed in one place:\n  ${offenders.join('\n  ')}`)
})

test('the guard is actually looking at this repo', () => {
    // Cheap self-check: if the traversal silently found nothing (a bad ROOT on some platform), both
    // assertions above would pass vacuously and the guard would be decorative.
    const files = DIRS.flatMap(d => sourceFiles(join(ROOT, d)))
    assert.ok(files.length > 100, `expected to scan the backend, saw ${files.length} files`)
    assert.ok(files.some(f => f.endsWith('tradeCapture.service.js')))
})
