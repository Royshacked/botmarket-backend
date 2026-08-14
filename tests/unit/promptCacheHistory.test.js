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
import {
    _stampHistoryCache,
    advanceToolLoopCache,
    _frozenCacheTarget,
    _restampToolLoopCache,
    _compactPriorToolResults,
} from '../../providers/anthropic.provider.js'

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

// The user-first rule is an invariant of the HISTORY, not a side effect of having trimmed. Kairos
// and Mentor used to slice(-8) in the controller, which both defeated the high-water mark above AND
// skipped trimHistory's guard — an even-count slice of a phased Kairos reply (one turn = several
// assistant bubbles) genuinely lands on an assistant. The slice is gone; this holds the rule at the
// one place every agent's history passes through.
test('normalizeMessages opens on a user turn even when nothing is trimmed', () => {
    const out = normalizeMessages([
        { role: 'assistant', content: 'a stale leading reply' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
    ], 50)   // cap far above the input → trimHistory is a no-op, so only this guard can fire
    assert.equal(out[0].role, 'user')
    assert.deepEqual(out, [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
    ])
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

// ── the breakpoint inside the tool loop ───────────────────────────────────────
// The loop appends an assistant tool_use turn and a user tool_result turn per round, all AFTER the
// history stamp, so round 9 re-read rounds 1–8 at full price. Moving the stamp forward fixes that,
// but only as far as the compaction frontier: _compactPriorToolResults REWRITES the newest results
// in place each round, and a breakpoint on bytes that are about to change is a write nothing reads.

// One round = an assistant tool_use turn + a user tool_result turn.
const loop = (history, rounds) => [
    ...history,
    ...Array.from({ length: rounds }, (_, r) => [
        { role: 'assistant', content: [{ type: 'tool_use', id: `t${r}`, name: 'get_candles', input: {} }] },
        { role: 'user',      content: [{ type: 'tool_result', tool_use_id: `t${r}`, content: `result ${r}` }] },
    ]).flat(),
]
const HISTORY = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]

test('shallow loops are left alone — nothing behind the frontier to cache', () => {
    // Rounds 1–2 are both still mutable, so a stamp here would be written and then invalidated.
    assert.equal(_frozenCacheTarget(loop(HISTORY, 0), HISTORY.length), -1)
    assert.equal(_frozenCacheTarget(loop(HISTORY, 1), HISTORY.length), -1)
})

test('from the third round it targets the SECOND-newest tool_result, not the newest', () => {
    // The newest result is rewritten by _compactPriorToolResults at the top of the next round;
    // the one before it was compacted a round ago and is byte-stable. Targeting the newest is the
    // plausible-looking bug this pins against.
    const msgs = loop(HISTORY, 2)                      // [q, a, A1, U1, A2, U2]
    const target = _frozenCacheTarget(msgs, HISTORY.length)
    assert.equal(target, 3)                            // U1, not U2 at index 5
    assert.equal(msgs[target].content[0].tool_use_id, 't0')
})

test('the target advances one round at a time as the loop deepens', () => {
    for (const rounds of [2, 3, 4, 5]) {
        const msgs = loop(HISTORY, rounds)
        const target = _frozenCacheTarget(msgs, HISTORY.length)
        assert.equal(msgs[target].role, 'user', `round ${rounds} landed on a non-user turn`)
        assert.equal(msgs[target].content[0].tool_use_id, `t${rounds - 2}`, `round ${rounds}`)
    }
})

test('a pause_turn round pushes ONE message and the target still lands on a user turn', () => {
    // Index arithmetic would drift out of phase here — a server tool that pauses breaks the
    // assistant/user pairing. This is why the target is scanned for rather than computed.
    const msgs = [...loop(HISTORY, 3), { role: 'assistant', content: [{ type: 'text', text: 'paused' }] }]
    const target = _frozenCacheTarget(msgs, HISTORY.length)
    assert.equal(msgs[target].role, 'user')
    assert.equal(msgs[target].content[0].tool_use_id, 't1')
})

test('history turns are never targeted, however deep the loop', () => {
    // historyLen is the floor: the desk's own turns are handled by _stampHistoryCache.
    const msgs = loop(HISTORY, 4)
    assert.ok(_frozenCacheTarget(msgs, HISTORY.length) >= HISTORY.length)
})

test('restamping MOVES the breakpoint — still exactly one after five rounds', () => {
    // The failure this guards is a 400 in production only, on the longest conversations: a stamp
    // added per round instead of moved blows the four-breakpoint budget somewhere around round 2.
    const msgs = _stampHistoryCache(HISTORY).concat(loop([], 5))
    for (const rounds of [2, 3, 4, 5]) {
        const target = _frozenCacheTarget(msgs.slice(0, HISTORY.length + rounds * 2), HISTORY.length)
        if (target !== -1) _restampToolLoopCache(msgs, target)
        const count = JSON.stringify(msgs).split('cache_control').length - 1
        assert.equal(count, 1, `round ${rounds} left ${count} breakpoints`)
    }
})

test('the stamp lands on the LAST block of the target turn', () => {
    const msgs = loop(HISTORY, 3)
    msgs[3].content.push({ type: 'text', text: 'trailing note' })
    _restampToolLoopCache(msgs, 3)
    assert.equal(msgs[3].content[0].cache_control, undefined)
    assert.deepEqual(msgs[3].content.at(-1).cache_control, { type: 'ephemeral' })
})

test('the history stamp is cleared when the loop takes over', () => {
    // Both live in `messages`, so the loop's stamp has to displace the history one rather than
    // sit alongside it.
    const msgs = _stampHistoryCache(HISTORY).concat(loop([], 3))
    assert.ok(JSON.stringify(msgs[1]).includes('cache_control'), 'history stamp missing to begin with')
    _restampToolLoopCache(msgs, _frozenCacheTarget(msgs, HISTORY.length))
    assert.ok(!JSON.stringify(msgs[1]).includes('cache_control'), 'history stamp survived')
})

// ── the monitors: same mechanism, no compaction ───────────────────────────────
// Hermes and Talos run their own tool loop and never rewrite a result, so nothing is in flux and
// the breakpoint can sit on the NEWEST turn instead of lagging one behind. Same function, one knob.

test('with nothing mutable the breakpoint reaches the newest turn', () => {
    const msgs = loop(HISTORY, 3)
    const deskTarget    = _frozenCacheTarget(msgs, HISTORY.length)                  // compacting loop
    const monitorTarget = _frozenCacheTarget(msgs, HISTORY.length, 0)               // monitor loop
    assert.equal(msgs[deskTarget].content[0].tool_use_id, 't1')
    assert.equal(msgs[monitorTarget].content[0].tool_use_id, 't2', 'monitor should not lag a round')
    assert.ok(monitorTarget > deskTarget, 'mutableTail 0 must reach further than 1')
})

test('a monitor caches from its FIRST tool round, a desk from its second', () => {
    // The monitors open with a single user turn and no history, so one round is enough for them.
    const oneRound = loop(HISTORY, 1)
    assert.equal(_frozenCacheTarget(oneRound, HISTORY.length, 0) !== -1, true)
    assert.equal(_frozenCacheTarget(oneRound, HISTORY.length, 1), -1)
})

test('advanceToolLoopCache is the one entry point and reports whether it moved', () => {
    const msgs = loop(HISTORY, 1)
    assert.equal(advanceToolLoopCache(msgs, HISTORY.length), false, 'too shallow for a compacting loop')
    assert.equal(advanceToolLoopCache(msgs, HISTORY.length, { mutableTail: 0 }), true)
    assert.equal(JSON.stringify(msgs).split('cache_control').length - 1, 1)
})

test('an unusable target is refused rather than half-stamped', () => {
    const msgs = [...HISTORY, { role: 'user', content: [] }]
    assert.equal(_restampToolLoopCache(msgs, 2), false)
    assert.equal(_restampToolLoopCache(msgs, 99), false)
})

// ── the two properties of compaction the design rests on ──────────────────────
// Placing the breakpoint one round behind the tail is only correct because compaction rewrites a
// result exactly ONCE and preserves the stamp when it does. If either stopped holding, the
// breakpoint would sit on bytes that keep changing and every round would pay a write for nothing —
// silently, since a cache miss looks identical to a cache hit from the call site.

const withImage = () => ([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'get_chart', input: {} }] },
    { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 't0',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
    }] },
])

test('compaction rewrites a result once, then leaves it byte-identical', () => {
    const msgs = withImage()
    _compactPriorToolResults(msgs)
    const afterFirst = JSON.stringify(msgs)
    assert.ok(!afterFirst.includes('"image"'), 'first pass should have dropped the image')

    _compactPriorToolResults(msgs)
    _compactPriorToolResults(msgs)
    assert.equal(JSON.stringify(msgs), afterFirst, 'compaction is not idempotent — frontier moves')
})

test('compaction preserves the breakpoint on a block it rewrites', () => {
    // The stamp rides ON the tool_result block, which compaction rebuilds via spread. If that ever
    // became a fresh object literal, the breakpoint would vanish and the loop would silently stop
    // caching.
    const msgs = withImage()
    _restampToolLoopCache(msgs, 2)
    _compactPriorToolResults(msgs)

    assert.deepEqual(msgs[2].content.at(-1).cache_control, { type: 'ephemeral' })
    assert.equal(JSON.stringify(msgs).split('cache_control').length - 1, 1)
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
    // services/agents/ since 2026-08-07; marketBrief.service stayed in services/ and counts too.
    const files = [
        ...readdirSync(join(ROOT, 'services/agents')).filter(f => f.endsWith('.agent.service.js'))
            .map(f => join(ROOT, 'services/agents', f)),
        join(ROOT, 'services/marketBrief.service.js'),
    ]
    assert.ok(files.length >= 7, 'still finding the agent services')
    for (const f of files) {
        const used = (readFileSync(f, 'utf8').match(BREAKPOINT) ?? []).length
        assert.ok(used <= 2, `${f} declares ${used} cache breakpoints; the budget leaves room for 2`)
    }
})

test('the tool registry stamps at most one breakpoint', () => {
    const src = readFileSync(join(ROOT, 'services/agentTools.registry.js'), 'utf8')
    assert.ok((src.match(BREAKPOINT) ?? []).length <= 1)
})
