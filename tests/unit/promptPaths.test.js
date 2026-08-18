// Every prompt a service loads must actually EXIST at the path it names.
//
// This guard exists because the failure it catches is invisible to every other check. Prompt
// loading is lazy (`makePromptLoader` reads on first call, not at import), so a wrong path is not
// an import error, not a lint error, and not a test failure — it is an ENOENT on the first real
// user turn, at the one moment a desk is supposed to answer. Moving the seven desks into
// `services/agents/` (2026-08-07) broke exactly this way, and moving the prompts into `prompts/`
// could have broken it the same way again.
//
// It reads the SOURCE rather than importing the services on purpose: importing a desk pulls in
// providers and config, so the check would then depend on the environment it is meant to be
// independent of. A regex over `join(__dirname, '….md')` sees every call site whether or not the
// module it lives in can be constructed here.

import test   from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve, relative, sep } from 'path'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '../../')
const SERVICES = join(ROOT, 'services')

/** Every .js under services/, at any depth (the desks sit one level down, in agents/). */
function jsFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = join(dir, e.name)
        return e.isDirectory() ? jsFiles(p) : (e.name.endsWith('.js') ? [p] : [])
    })
}

/** Every `join(__dirname, '<rel>.md')` in the service tree, resolved to an absolute path. */
function promptCallSites() {
    return jsFiles(SERVICES).flatMap(file =>
        [...readFileSync(file, 'utf8').matchAll(/join\(__dirname,\s*'([^']*\.md)'\)/g)]
            .map(m => ({ file, rel: m[1], abs: resolve(dirname(file), m[1]) })),
    )
}

test('every prompt path a service names resolves to a real file', () => {
    const sites = promptCallSites()

    // If this drops to zero the regex has stopped matching and the guard is passing while blind —
    // the same "scans a directory and sees nothing" failure the desk guard was written against.
    // 14 before Kairos was archived (2026-08-18); its base prompt and three mode fragments left
    // services/ together. Lower the floor WITH a removal, never to make a red test green.
    assert.ok(sites.length >= 10,
        `only ${sites.length} prompt call sites found — the scan stopped working`)

    const missing = sites
        .filter(s => !existsSync(s.abs))
        .map(s => `${relative(ROOT, s.file).split(sep).join('/')} → ${s.rel}`)

    assert.deepEqual(missing, [],
        `a service loads a prompt that is not there. Lazy loading means this surfaces as an ENOENT ` +
        `on a live turn, not here — fix the path or move the file back.`)
})

test('prompts live in prompts/, not scattered at the repo root', () => {
    // The convention, enforced: a new desk that drops its prompt beside the source or back at the
    // root still WORKS, which is why nothing else would catch it — and then the next person looking
    // for "the prompts" finds only some of them.
    const strays = promptCallSites()
        .filter(s => !relative(ROOT, s.abs).split(sep).join('/').startsWith('prompts/'))
        .map(s => `${relative(ROOT, s.file).split(sep).join('/')} → ${s.rel}`)

    assert.deepEqual(strays, [], 'a service loads a prompt from outside prompts/')
})

test('nothing in prompts/ is orphaned', () => {
    // The other direction: a prompt no service loads is either dead weight or a live desk wired to
    // the wrong file. Both are worth a failing test rather than a file nobody can account for.
    const loaded = new Set(promptCallSites().map(s => resolve(s.abs)))
    const orphans = readdirSync(join(ROOT, 'prompts'))
        .filter(f => f.endsWith('.md'))
        .filter(f => !loaded.has(resolve(join(ROOT, 'prompts', f))))

    assert.deepEqual(orphans, [],
        'a file in prompts/ is loaded by nothing — delete it, or wire up the desk that wants it')
})
