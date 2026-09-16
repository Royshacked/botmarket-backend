import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Does every script still LOAD? Statically.
//
// scripts/ and the manual harnesses in tests/ are the one corner of the repo nothing checks: eslint
// sees them but cannot know what a module exports, npm test never runs them (they hit live brokers,
// databases and models), and check:archive covers archive/ only. So a sweep that moves an export
// breaks them silently — §10 found four that did not load: one broken by §8's fetchLastPrice move,
// one by the end of the zone gate (70a6039), two naming an orchestrator deleted in July.
//
// STATIC on purpose. A script runs on import (top-level await, process.exit), so this never imports
// a script. It parses the script's import statements — static and `await import()` — resolves each
// RELATIVE specifier to a file, imports THAT module (an app module, safe under the offline suite),
// and asserts every named import exists on it. Bare specifiers (dotenv, mongodb) are not ours.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Every ESM relative-import shape a script uses. COMBINED and NAMESPACE were added after the CR on
// §10 pointed out the guard was blind to them — `import def, { named }` and `import * as x` would
// have skipped an import whose export moved, the exact silence this test exists to break.
const COMBINED  = /import\s+(\w+)\s*,\s*\{([^}]*)\}\s*from\s*'(\.\.?\/[^']+)'/g   // import def, { a, b } from '...'
const NAMESPACE = /import\s*\*\s*as\s+\w+\s+from\s*'(\.\.?\/[^']+)'/g              // import * as x from '...'
const STATIC    = /import\s*\{([^}]*)\}\s*from\s*'(\.\.?\/[^']+)'/g                  // import { a, b } from '...'
const DYNAMIC   = /const\s*\{([^}]*)\}\s*=\s*await\s+import\('(\.\.?\/[^']+)'\)/g
const DEFAULT   = /^import\s+(\w+)\s+from\s+'(\.\.?\/[^']+)'/gm                       // import def from '...' (no comma)
const BARE      = /import\s+'(\.\.?\/[^']+)'/g

/** Every relative import a file makes: [{ names: string[], spec }]. A namespace import names
 *  nothing to check per-export, so it carries []; the module resolution is still verified. */
export function relativeImports(src) {
    const out = []
    const names = list => list.split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+as\s+/)[0].trim())
    // Combined first, and blank its match out, so DEFAULT and STATIC below do not each half-match it.
    let rest = src
    for (const m of src.matchAll(COMBINED)) out.push({ names: ['default', ...names(m[2])], spec: m[3] })
    rest = rest.replace(COMBINED, '')
    for (const m of rest.matchAll(NAMESPACE)) out.push({ names: [], spec: m[1] })
    for (const m of rest.matchAll(STATIC))    out.push({ names: names(m[1]), spec: m[2] })
    for (const m of rest.matchAll(DYNAMIC))   out.push({ names: names(m[1]), spec: m[2] })
    for (const m of rest.matchAll(DEFAULT))   out.push({ names: ['default'], spec: m[2] })
    for (const m of rest.matchAll(BARE))      out.push({ names: [], spec: m[1] })
    return out
}

async function check(file) {
    const src = readFileSync(file, 'utf8')
    const problems = []
    for (const { names, spec } of relativeImports(src)) {
        const target = resolve(dirname(file), spec)
        if (!existsSync(target)) { problems.push(`${spec} — no such module`); continue }
        let mod
        try { mod = await import(pathToFileURL(target).href) }
        catch (err) { problems.push(`${spec} — does not load: ${String(err?.message).split('\n')[0]}`); continue }
        for (const n of names) if (!(n in mod)) problems.push(`'${n}' is not exported by ${spec}`)
    }
    return problems
}

const scripts   = readdirSync(join(ROOT, 'scripts')).filter(f => /\.(mjs|js)$/.test(f)).map(f => join(ROOT, 'scripts', f))
const harnesses = readdirSync(join(ROOT, 'tests')).filter(f => /^test\..*\.js$/.test(f)).map(f => join(ROOT, 'tests', f))

test('every script under scripts/ imports only modules and names that exist', async () => {
    assert.ok(scripts.length > 20, 'the scripts directory is where it was')
    const broken = []
    for (const f of scripts) for (const p of await check(f)) broken.push(`${f.slice(ROOT.length + 1)}: ${p}`)
    assert.deepEqual(broken, [])
})

test('every manual harness under tests/ imports only modules and names that exist', async () => {
    assert.ok(harnesses.length > 0)
    const broken = []
    for (const f of harnesses) for (const p of await check(f)) broken.push(`${f.slice(ROOT.length + 1)}: ${p}`)
    assert.deepEqual(broken, [])
})

test('the parser sees every import shape the scripts use — named, default, combined, namespace, dynamic, bare', () => {
    const src = `
import 'dotenv/config'
import dotenv from 'dotenv'
import { a, b as c } from '../x.js'
import def from './y.js'
import defTwo, { f, g } from '../combined.js'
import * as ns from '../namespace.js'
import './side-effect.js'
const { d, e } = await import('../z.js')
`
    const got = relativeImports(src)
    // order-independent — assert the set of (spec → names)
    const bySpec = Object.fromEntries(got.map(i => [i.spec, i.names]))
    assert.deepEqual(bySpec['../x.js'], ['a', 'b'])
    assert.deepEqual(bySpec['./y.js'], ['default'])
    assert.deepEqual(bySpec['../combined.js'], ['default', 'f', 'g'])
    assert.deepEqual(bySpec['../namespace.js'], [])
    assert.deepEqual(bySpec['./side-effect.js'], [])
    assert.deepEqual(bySpec['../z.js'], ['d', 'e'])
    // and the bare npm imports (dotenv) are not ours to resolve
    assert.equal(got.some(i => i.spec === 'dotenv'), false)
})
