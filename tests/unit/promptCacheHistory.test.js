// The conversation-history prompt cache — one mechanism, every agent.
// Node's built-in harness:  node --test tests/unit/promptCacheHistory.test.js
//
// Two halves that only work together: a history whose PREFIX is stable (agentUtils.trimHistory) and
// a breakpoint at the end of it (anthropic.provider._stampHistoryCache). Either alone is useless —
// a breakpoint over a sliding window pays the write premium every turn and never reads once.
//
// What makes these worth having: every failure here is SILENT. A shifted prefix, a missing stamp,
// or a fifth breakpoint doesn't throw in dev — it just quietly costs 10× or, in the last case, 400s
// in production only once a long enough conversation reaches it.
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeMessages, trimHistory } from '../../services/agentUtils.js'
import { _stampHistoryCache } from '../../providers/anthropic.provider.js'

const turns = n => Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}`,
}))

// ── the stable prefix ─────────────────────────────────────────────────────────

test('history is untouched until it passes the high-water mark', () => {
    // The whole point: between trims the prefix must be byte-identical turn over turn.
    for (const n of [10, 20, 30]) assert.equal(trimHistory(turns(n), 10).length, n)
})

test('past the mark it drops to `keep` in ONE step, not one turn at a time', () => {
    // `keep`, or one fewer when the cut landed on an assistant and the user-first guard took it.
    const out = trimHistory(turns(31), 10)
    assert.ok(out.length === 10 || out.length === 9, `dropped to ${out.length}`)
})

test('the prefix survives a turn being appended — the cache-hit case', () => {
    // A sliding window shifted message[0] on every turn, which is exactly what a prefix match
    // cannot survive. Same first turn before and after => the cached history still reads.
    const before = trimHistory(turns(20), 10)
    const after  = trimHistory(turns(21), 10)
    assert.deepEqual(after[0], before[0])
})

test('a trimmed history still opens on a USER turn', () => {
    // Strictly-alternating history + an even `keep` lands on an assistant whenever the total is
    // odd — which it is on exactly the turns the user just spoke. The API rejects that outright.
    for (const n of [31, 32, 40, 41]) {
        assert.equal(trimHistory(turns(n), 10)[0].role, 'user', `n=${n}`)
    }
})

test('no cap given → never trims (unchanged behaviour)', () => {
    assert.equal(trimHistory(turns(50), 0).length, 50)
    assert.equal(trimHistory(turns(50), undefined).length, 50)
})

test('normalizeMessages still coalesces, then trims on the mark', () => {
    const out = normalizeMessages([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },   // same-role run → ONE turn
    ], 2)
    assert.deepEqual(out, [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a\n\nb' },
    ])
})

// ── the breakpoint ────────────────────────────────────────────────────────────

test('the last history turn carries the breakpoint', () => {
    const out = _stampHistoryCache([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
    ])
    assert.deepEqual(out[2].content, [
        { type: 'text', text: 'latest', cache_control: { type: 'ephemeral' } },
    ])
    assert.equal(out[0].content, 'first')     // everything before it is left alone
    assert.equal(out[1].content, 'reply')
})

test('exactly ONE breakpoint — a second would burn the request budget', () => {
    const json = JSON.stringify(_stampHistoryCache(turns(9)))
    assert.equal(json.split('cache_control').length - 1, 1)
})

test('a first turn is not stamped — nothing to reuse, and the slot is scarce', () => {
    const solo = [{ role: 'user', content: 'hello' }]
    assert.deepEqual(_stampHistoryCache(solo), solo)
    assert.deepEqual(_stampHistoryCache([]), [])
})

test('block-array content is stamped on its LAST block, not flattened', () => {
    const out = _stampHistoryCache([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ])
    assert.equal(out[1].content[0].cache_control, undefined)
    assert.deepEqual(out[1].content[1].cache_control, { type: 'ephemeral' })
})

test('does not mutate the caller’s array — the tool loop appends to it afterwards', () => {
    const input = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]
    const snapshot = JSON.stringify(input)
    _stampHistoryCache(input)
    assert.equal(JSON.stringify(input), snapshot)
})

test('unusable content is passed through rather than half-stamped', () => {
    const odd = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [] }]
    assert.deepEqual(_stampHistoryCache(odd), odd)
})

// ── the four-breakpoint budget ────────────────────────────────────────────────
// The API allows FOUR cache breakpoints per request. The spend is split across three places that
// never see each other: the tool registry (1), an agent's system array (1–2), and the history stamp
// above (1). Nothing at runtime adds them up, and going over does not fail in dev — it fails as a
// 400 in production, on the requests with the longest conversations. So count them here.
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../')
const BREAKPOINT = /cache_control:\s*\{\s*type:\s*'ephemeral'\s*\}/g

test('no agent spends more than 2 of the 4 breakpoints on its system prompt', () => {
    // 2 (system) + 1 (tool list) + 1 (history) = 4, the cap exactly. A third here is one too many.
    const services = readdirSync(join(ROOT, 'services'))
        .filter(f => f.endsWith('.agent.service.js') || f === 'marketBrief.service.js')
    assert.ok(services.length >= 7, 'still finding the agent services')
    for (const f of services) {
        const used = (readFileSync(join(ROOT, 'services', f), 'utf8').match(BREAKPOINT) ?? []).length
        assert.ok(used <= 2, `${f} declares ${used} cache breakpoints; the budget leaves room for 2`)
    }
})

test('the tool registry stamps at most one breakpoint', () => {
    const src = readFileSync(join(ROOT, 'services/agentTools.registry.js'), 'utf8')
    assert.ok((src.match(BREAKPOINT) ?? []).length <= 1)
})
