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

const STATIC  = /import\s*\{([^}]*)\}\s*from\s*'(\.\.?\/[^']+)'/g
const DYNAMIC = /const\s*\{([^}]*)\}\s*=\s*await\s+import\('(\.\.?\/[^']+)'\)/g
const DEFAULT = /import\s+(\w+)\s+from\s+'(\.\.?\/[^']+)'/g
const BARE    = /import\s+'(\.\.?\/[^']+)'/g

/** Every relative import a file makes: [{ names: string[], spec }]. */
export function relativeImports(src) {
    const out = []
    const names = list => list.split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+as\s+/)[0].trim())
    for (const m of src.matchAll(STATIC))  out.push({ names: names(m[1]), spec: m[2] })
    for (const m of src.matchAll(DYNAMIC)) out.push({ names: names(m[1]), spec: m[2] })
    for (const m of src.matchAll(DEFAULT)) out.push({ names: ['default'], spec: m[2] })
    for (const m of src.matchAll(BARE))    out.push({ names: [], spec: m[1] })
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

test('the parser sees the three import shapes the scripts use', () => {
    const src = `
import 'dotenv/config'
import dotenv from 'dotenv'
import { a, b as c } from '../x.js'
import def from './y.js'
const { d, e } = await import('../z.js')
`
    assert.deepEqual(relativeImports(src), [
        { names: ['a', 'b'], spec: '../x.js' },
        { names: ['d', 'e'], spec: '../z.js' },
        { names: ['default'], spec: './y.js' },
    ])
})
