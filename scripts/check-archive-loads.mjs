/**
 * Does every archived module still LOAD?
 *
 * `archive/README.md` promises the desks in here are "kept whole so a desk can come back as a
 * decision rather than as an archaeology project". The archive imports ~40 symbols from the LIVE
 * tree, so a dead-code sweep that deletes an export nothing live reaches can quietly break it —
 * and nothing notices, because `npm test` and eslint both skip `archive/**` by design.
 *
 * This is a SCRIPT, not a test, on purpose: running the archive under `npm test` would undo the
 * reason its tests were moved out of `tests/unit/` in the first place. Run it after any sweep that
 * removes an export:  npm run check:archive
 *
 * It only checks that each file IMPORTS. Behavioural drift against a live service it calls is a
 * revival-time question, and the ones known today are listed in `archive/README.md`.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARCHIVE = join(ROOT, 'archive')

function walk(dir) {
    return readdirSync(dir).flatMap(name => {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) return walk(full)
        return full.endsWith('.js') ? [full] : []
    })
}

// A test file RUNS its assertions on import, so a failed assertion would read as a load failure.
// Only module resolution is in scope here.
const isTest = f => f.endsWith('.test.js')

const files = walk(ARCHIVE).sort()
const broken = []

for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    try {
        await import(pathToFileURL(file).href)
        console.log(`  ok   ${rel}`)
    } catch (err) {
        const loadFailure = err instanceof SyntaxError || err?.code === 'ERR_MODULE_NOT_FOUND'
        if (!loadFailure && isTest(file)) {
            console.log(`  ran  ${rel}  (assertion drift, not a load failure)`)
            continue
        }
        broken.push({ rel, message: err?.message ?? String(err) })
        console.log(`  FAIL ${rel}`)
    }
}

console.log(`\n${files.length - broken.length}/${files.length} archived modules load.`)
if (broken.length) {
    console.log('\nBroken — a live export these reach was renamed or removed:')
    for (const b of broken) console.log(`\n  ${b.rel}\n    ${b.message}`)
    process.exit(1)
}
// Importing an archived TEST file runs its assertions, and node's test runner sets a non-zero exit
// code of its own when one fails. That is drift against a live service, not a broken import, so it
// must not fail this check — exit explicitly on the answer this script actually computed.
process.exit(0)
