import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATUSES_BY_KIND, statusesFor } from '../../services/entity/vocabulary.js'
import { _nextStatus as talosNextStatus } from '../../monitoring/talos.monitor.service.js'
import { _nextStatus as hermesNextStatus } from '../../monitoring/hermes.monitor.service.js'

// THE GUARD. Six status bugs shipped in this codebase and every one had the same shape: a word was
// renamed, a `status === '...'` somewhere kept testing the old spelling, and NOTHING failed — the
// gate just stopped matching. Silently.
//
//   • `in_position`  — rejected every management action on a live call, and let dismiss terminate
//                      a call whose position was open at the broker
//   • `in_position`  — kept a live call's levels off its own chart
//   • `looking`      — left the Setups hub permanently reading "0 watched"
//   • `hit`          — would have refused every setup confirm once setups moved to `ready`
//   • `unarmed`/`ready` — left the confirm dialog gating on a status nothing wrote
//
// vocabulary.js already knew the right answer in every case. Nothing asked it. This does: any
// status literal compared in the entity paths must be a word some kind actually speaks.

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

// Entity-status surfaces only. Broker ORDER statuses ('working', 'open', 'filled') and the chat
// CARD lifecycle ('pending', 'done', 'dismissed') are separate vocabularies with their own words.
const SCAN = [
    'api/trade-ideas', 'api/setups', 'api/kairos', 'api/portfolio',
    'services/entity', 'services/kairos.handoff.service.js', 'services/portfolioState.service.js',
    'monitoring/minos.monitor.service.js', 'monitoring/hermes.monitor.service.js',
    'monitoring/talos.monitor.service.js', 'monitoring/execution.reconciler.js',
]

// Words that are legitimately compared against `.status` in these files but belong to another
// vocabulary. Each needs a reason — an unexplained entry here is how a real drift gets hidden.
const NOT_ENTITY_STATUSES = new Set([
    'working',            // broker ORDER state (exitOrders / reconciler)
    'cancelled',          // broker ORDER state — written onto brokerOrders[].status, not the entity
    'open',               // broker POSITION state
    'filled',             // broker ORDER fill
    'awaiting_manual_fill', 'manual_filling', 'awaiting_confirm', 'awaiting_market', 'placed',
                          // `orderState`, not `status` — a separate field with its own words
    'building',           // client-side draft pseudo-status, never persisted
])

function walk(p) {
    const abs = join(ROOT, p)
    if (statSync(abs).isFile()) return [abs]
    return readdirSync(abs).flatMap(f => (f.endsWith('.js') ? [join(abs, f)] : []))
}

test('every status literal in the entity paths is a word some kind actually speaks', () => {
    const known = new Set(Object.values(STATUSES_BY_KIND).flat())
    const offenders = []

    for (const file of SCAN.flatMap(walk)) {
        const src = readFileSync(file, 'utf8')
        // `status === 'x'`, `status !== 'x'`, and `status: 'x'` in a query/update position.
        for (const m of src.matchAll(/\bstatus['"]?\s*(?:===|!==|:)\s*'([a-z_]+)'/g)) {
            const word = m[1]
            if (known.has(word) || NOT_ENTITY_STATUSES.has(word)) continue
            const line = src.slice(0, m.index).split('\n').length
            offenders.push(`${relative(ROOT, file)}:${line} → '${word}'`)
        }
    }

    assert.deepEqual(offenders, [],
        'these compare a status the vocabulary does not declare — either the word is stale (the ' +
        'gate silently matches nothing) or it belongs in STATUSES_BY_KIND:\n  ' + offenders.join('\n  '))
})

test('the retired synonyms cannot come back without this failing', () => {
    // Every one of these was a second spelling of a rung that already had a word.
    const known = new Set(Object.values(STATUSES_BY_KIND).flat())
    for (const dead of ['unarmed', 'watching', 'ready', 'expiring', 'expired', 'dismissed', 'in_position', 'confirmed']) {
        assert.ok(!known.has(dead), `'${dead}' is back in the vocabulary — it is a synonym, not a rung`)
    }
})

// The textual scan above only sees COMPARISONS (`status === 'x'`). It cannot see a status being
// PRODUCED — `return 'ready'` from a transition function reads like any other string. That is the
// exact shape the setup rename used to introduce `ready`, so the producers are checked directly:
// drive every verdict through them and assert the output is a word the kind actually speaks.
const VERDICTS = ['enter', 'wait', 'stand_aside', 'edit', 'let_expire', 'garbled_nonsense']
const REASONS  = ['zone_trip', 'expiry_review', 'scheduled']

test('_nextStatus can only ever produce a status its kind declares', () => {
    for (const [kind, nextStatus] of [['setup', talosNextStatus], ['call', hermesNextStatus]]) {
        const allowed = statusesFor(kind)
        for (const v of VERDICTS) {
            for (const r of REASONS) {
                const out = nextStatus(v, r)
                assert.ok(allowed.includes(out),
                    `${kind}: _nextStatus('${v}', '${r}') → '${out}', which ${kind} does not speak`)
            }
        }
    }
})
