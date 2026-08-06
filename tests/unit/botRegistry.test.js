import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { BOT_IDS, isBot } from '../../api/chat/chat.service.js'

// The bot registry, guarded — because an unregistered sender does NOT fail.
//
// postBotCard resolves `const bot = isBot(botId) ? botId : BOT_USER_ID`, and BOT_USER_ID is 'axl'.
// So a desk whose id is missing from BOT_IDS still delivers its card — attributed to Axl. Nothing
// throws, nothing logs, and the user reads a message from the wrong agent with no idea why. That is
// exactly what happened when the strategy desk shipped without being registered.

const SERVICES = join(dirname(fileURLToPath(import.meta.url)), '../../services')

test('every botId a notifier declares is a REGISTERED bot', () => {
    const declared = new Set()
    for (const f of readdirSync(SERVICES).filter(f => f.endsWith('.js'))) {
        const src = readFileSync(join(SERVICES, f), 'utf-8')
        // `botId: 'x'` and the ternary form `botId: cond ? 'x' : 'y'`.
        for (const m of src.matchAll(/botId:\s*[^,\n]*?'([a-z_]+)'/g)) declared.add(m[1])
        for (const m of src.matchAll(/botId:\s*[^,\n]*?:\s*'([a-z_]+)'/g)) declared.add(m[1])
    }
    assert.ok(declared.size >= 5, `expected several senders, found ${[...declared]}`)
    for (const id of declared) {
        assert.ok(isBot(id), `botId '${id}' is not in BOT_IDS — its cards would silently post AS AXL`)
    }
})

test('the strategy desk is registered — the regression this file exists for', () => {
    assert.ok(BOT_IDS.includes('strategy'))
    assert.ok(BOT_IDS.includes('analyst'))
})

test('an unknown sender is still treated as not-a-bot', () => {
    // The fallback itself is deliberate (a card must never be lost), so this pins the predicate
    // rather than the fallback: the guard above is what stops the fallback being reached.
    assert.equal(isBot('pythia'), false, 'the BRAND is not the key — keys stay functional')
    assert.equal(isBot(''), false)
    assert.equal(isBot(undefined), false)
})
