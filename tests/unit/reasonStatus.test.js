import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reasonToStatus, sendReason, SHARED_REASONS } from '../../api/_shared/reason.util.js'

// THE GUARD, in the same spirit as statusLiterals: a refusal that means one thing must ANSWER one
// thing. Three controllers each hand-rolled their own reason→status ladder and had already drifted
// apart — deleting an entity holding a live broker position was 409 on /api/trade-ideas and 400 on
// /api/setups, and `already_closed` (409) and `closed_is_terminal` (400) were the same refusal
// spelled twice. Nothing failed, because nothing compared the three ladders.

// A minimal express `res` double: records what was answered.
function fakeRes() {
    const out = {}
    return {
        out,
        status(code) { out.status = code; return this },
        send(body)   { out.body = body; return this },
    }
}

// ── The shared table ──────────────────────────────────────────────────────────

test('a live broker position is a CONFLICT, and says which one in a slug', () => {
    const res = fakeRes()
    sendReason(res, 'in_position')
    assert.equal(res.out.status, 409)
    assert.equal(res.out.body.reason, 'in_position')      // clients branch on this, never on prose
    assert.match(res.out.body.error, /close the position first/i)
})

test('the two spellings of "it is already finished" answer alike', () => {
    assert.equal(reasonToStatus('already_closed'), 409)
    assert.equal(reasonToStatus('closed_is_terminal'), 409)
})

test('reaching the entity vs the entity refusing are different answers', () => {
    assert.equal(reasonToStatus('not_found'), 404)
    assert.equal(reasonToStatus('forbidden'), 403)
    assert.equal(reasonToStatus('invalid_status'), 400)
})

// ── Route-owned reasons ───────────────────────────────────────────────────────

test('an unclaimed reason takes the fallback and still carries its slug', () => {
    const res = fakeRes()
    sendReason(res, 'no_trigger_price', { fallback: 500, fallbackMessage: 'Failed to update idea' })
    assert.equal(res.out.status, 500)
    assert.deepEqual(res.out.body, { error: 'Failed to update idea', reason: 'no_trigger_price' })
})

test('an override re-words a shared reason but keeps its status', () => {
    // Manual mode calls `already_placed` "already filled" — the wording is the route's, the 409 is
    // everyone's. An override that changed the STATUS would be a disagreement between kinds.
    const res = fakeRes()
    sendReason(res, 'already_placed', { overrides: { already_placed: [409, 'Already filled'] } })
    assert.equal(res.out.status, 409)
    assert.equal(res.out.body.error, 'Already filled')
})

test('a matcher override claims a whole prefix family (the setup Generate gate)', () => {
    const gate = (r) => (r?.startsWith('missing_') ? [400, r] : null)
    const res = fakeRes()
    sendReason(res, 'missing_stop_zone', { overrides: gate, fallback: 500 })
    assert.equal(res.out.status, 400)
    assert.equal(res.out.body.error, 'missing_stop_zone')
})

test('a matcher that claims nothing falls through to the shared table, not the fallback', () => {
    const gate = (r) => (r?.startsWith('missing_') ? [400, r] : null)
    assert.equal(reasonToStatus('in_position', 500, gate), 409)
})

// ── No controller decides a shared reason for itself ──────────────────────────

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

function controllerFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) controllerFiles(full, out)
        else if (name.endsWith('.controller.js')) out.push(full)
    }
    return out
}

test('no controller hard-codes a status for a reason the shared table owns', () => {
    const shared = Object.keys(SHARED_REASONS)
    const offenders = []

    for (const file of controllerFiles(join(ROOT, 'api'))) {
        const src = readFileSync(file, 'utf8')
        const rel = relative(ROOT, file)
        // Strip line comments before matching: a comment that MENTIONS a reason is documentation,
        // and flagging it would push people to stop writing the comments.
        const code = src.replace(/^\s*\/\/.*$/gm, '')

        for (const reason of shared) {
            // Shape 1 — the branch: `if (result.reason === 'in_position') return res.status(...)`.
            if (new RegExp(`reason\\s*===\\s*'${reason}'`).test(code)) {
                offenders.push(`${rel} branches on '${reason}'`)
            }
            // Shape 2 — THE TABLE, and the reason this guard was widened. The three original
            // offenders were converted INTO exactly this: a controller-local
            // `{ not_found: [404, 'No such view'] }` looked up by a local `_fail`. It decides the
            // status just as firmly as the branch did, and the first version of this test could not
            // see it — so `strategy.controller` sat here redefining a shared reason, and answering
            // WITHOUT the `reason` slug every other route sends, from the day it was written.
            //
            // Passing a table to sendReason as `overrides` is still fine: that re-words a reason and
            // keeps its status. What this catches is a table the controller reads ITSELF.
            if (new RegExp(`\\b${reason}\\s*:\\s*\\[\\s*\\d{3}`).test(code) && !/sendReason/.test(code)) {
                offenders.push(`${rel} keeps its own status table for '${reason}'`)
            }
        }
    }

    assert.deepEqual(offenders, [], `answer these through sendReason instead:\n${offenders.join('\n')}`)
})
