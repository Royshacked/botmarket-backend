import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

// THE regression guard for a bug this suite let through once.
//
// `startLoop(name, loop)` refuses anything without BOTH start and stop, logs, and returns false —
// which is right, since a loop that cannot be stopped is a loop shutdown will strand. But the
// refusal is a log line at boot, not a crash: when `execution.reconciler` turned out to export
// `{ start, handleExecution, placeExits }` and no `stop`, registering it silently meant THE
// RECONCILER NEVER STARTED. Broker fills would stop being reconciled against entity state, in
// production, with the only evidence one warning in the boot log.
//
// Static analysis rather than imports, following statusLiterals.test.js: several monitor modules
// build provider clients at module scope, and the unit suite runs offline.

const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8')

/** Every `startLoop('name', serviceIdentifier)` in the boot sequence. */
function registeredLoops() {
    return [...server.matchAll(/startLoop\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)]
        .map(([, name, ident]) => ({ name, ident }))
}

/** The object literal a module exports under `export const <ident> = { … }`. */
function exportedLiteral(ident) {
    // Loop services live under monitoring/ by convention; scheduler-type services that run
    // as background loops but belong in services/ are also accepted.
    const dirs = [
        new URL('../../monitoring/', import.meta.url),
        new URL('../../services/', import.meta.url),
    ]
    for (const dir of dirs) {
        for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
            const src = readFileSync(new URL(file, dir), 'utf8')
            const at = src.indexOf(`export const ${ident} = {`)
            if (at === -1) continue
            // Balance braces from the opening one so a nested literal cannot end the match early.
            const open = src.indexOf('{', at)
            let depth = 0
            for (let i = open; i < src.length; i++) {
                if (src[i] === '{') depth++
                else if (src[i] === '}' && --depth === 0) return { file, body: src.slice(open, i + 1) }
            }
        }
    }
    return null
}

test('server.js registers the full fleet', () => {
    // A loop dropped from the boot sequence is invisible at runtime — nothing fails, the work just
    // stops happening. Pinning the roster makes a removal a deliberate edit to this list.
    assert.deepEqual(registeredLoops().map(l => l.name).sort(), [
        // hermes left on 2026-08-18 with Kairos — see archive/README.md. 'exits' and 'entries'
        // arrived the same day: the two halves of what Minos used to do, deliberately split so
        // neither can be switched off with the other.
        // 'guardSweep' is Talos's tier-0 (docs/desks/talos-guards.md) and belongs on this list for
        // the reason the list exists: it is the only thing watching price between Talos's own reads,
        // so switching it off would not fail anywhere — armed setups would simply stop being seen.
        'aetherScheduler', 'coverage', 'entries', 'exits', 'guardSweep', 'marketBrief', 'marketOpen', 'paperEquity',
        'paperFill', 'paperMark', 'reconciler', 'talos', 'themis', 'tilt',
    ])
})

test('every registered loop exposes BOTH start and stop, or it silently never starts', () => {
    for (const { name, ident } of registeredLoops()) {
        const found = exportedLiteral(ident)
        assert.ok(found, `${name}: no "export const ${ident} = {" found under monitoring/`)
        assert.match(found.body, /(^|[{,\s])start\s*[:(,}]/,
            `${name} (${found.file}) exports no start`)
        assert.match(found.body, /(^|[{,\s])stop\s*[:(,}]/,
            `${name} (${found.file}) exports no stop — startLoop would refuse it and it would NEVER RUN`)
    }
})
