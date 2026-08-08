import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { BOT_IDS, isBot, botForKind, RETIRED_BOT_IDS, isRetiredBot } from '../../api/chat/chat.service.js'

// The bot registry, guarded — because an unregistered sender does NOT fail.
//
// postBotCard resolves `const bot = isBot(botId) ? botId : BOT_USER_ID`, and BOT_USER_ID is 'axl'.
// So a desk whose id is missing from BOT_IDS still delivers its card — attributed to Axl. Nothing
// throws, nothing logs, and the user reads a message from the wrong agent with no idea why. That is
// exactly what happened when the strategy desk shipped without being registered.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

// Recursive: the notifiers live in `services/` AND `monitoring/`, and the desks moved into
// `services/agents/` + `services/tools/` subfolders — a flat readdir of one folder silently
// stopped covering most of them.
function _jsFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory()             ? _jsFiles(join(dir, e.name))
        : e.name.endsWith('.js')    ? [join(dir, e.name)]
        :                             []
    )
}

test('every botId a notifier declares is a REGISTERED bot', () => {
    const declared = new Set()
    for (const f of [..._jsFiles(join(ROOT, 'services')), ..._jsFiles(join(ROOT, 'monitoring'))]) {
        const src = readFileSync(f, 'utf-8')
        // `botId: 'x'` and the ternary form `botId: cond ? 'x' : 'y'`.
        for (const m of src.matchAll(/botId:\s*[^,\n]*?'([a-z_]+)'/g)) declared.add(m[1])
        for (const m of src.matchAll(/botId:\s*[^,\n]*?:\s*'([a-z_]+)'/g)) declared.add(m[1])
    }
    // The floor is low because most senders are now DERIVED (botForKind) rather than literal —
    // the test below covers that path. This one only has to catch a hardcoded stray.
    assert.ok(declared.size >= 4, `expected several senders, found ${[...declared]}`)
    for (const id of declared) {
        assert.ok(isBot(id), `botId '${id}' is not in BOT_IDS — its cards would silently post AS AXL`)
    }
})

test('the strategy desk is registered — the regression this file exists for', () => {
    assert.ok(BOT_IDS.includes('strategy'))
    assert.ok(BOT_IDS.includes('analyst'))
})

// The kind→bot map is the other way a card picks its sender (the kind-blind services — the
// market-open sweep, the manual fill/exit cards, the position monitor — all go through it), so it
// needs the same guard: an unregistered value there posts as Axl with no warning.
test('every kind routes to a REGISTERED bot', () => {
    for (const kind of ['idea', 'call', 'setup', 'portfolio_item', 'nonsense', null, undefined]) {
        assert.ok(isBot(botForKind(kind)), `kind '${kind}' → '${botForKind(kind)}' is not a registered bot`)
    }
    assert.equal(botForKind('call'),           'kairos')
    assert.equal(botForKind('setup'),          'mentor')
    assert.equal(botForKind('portfolio_item'), 'portfolio')
})

test('a RETIRED bot is not a bot — and its kind falls back to Axl', () => {
    // Removing 'idea' from BOT_IDS is what empties the sidebar feed; the fallback is what stops
    // that from also swallowing the cards a legacy idea still produces.
    assert.deepEqual(RETIRED_BOT_IDS, ['idea'])
    assert.equal(isRetiredBot('idea'), true)
    assert.equal(isBot('idea'), false, 'a retired desk must not be re-registered — its feed is gone')
    assert.equal(botForKind('idea'), 'axl')
})

test('an unknown sender is still treated as not-a-bot', () => {
    // The fallback itself is deliberate (a card must never be lost), so this pins the predicate
    // rather than the fallback: the guard above is what stops the fallback being reached.
    assert.equal(isBot('pythia'), false, 'the BRAND is not the key — keys stay functional')
    assert.equal(isBot(''), false)
    assert.equal(isBot(undefined), false)
})
