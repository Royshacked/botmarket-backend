import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'

import { scannerAgentService } from '../../services/agents/scanner.agent.service.js'

// Argus's Kairos hand-off is a MODE of the trading profile, not a profile of its own: it shares the
// whole screening spine and differs only in what it converges on (one name) and what it emits
// (<kairos_pick>). It used to live INSIDE the trading prompt, so a list-building turn read fifty
// lines telling it to find ONE ticker and not emit a scan_list, and a hand-off turn read the list
// machinery and phase gate it then had to override. It is now its own injected module.

const SPINE   = readFileSync(new URL('../../scanner_system_prompt.md', import.meta.url), 'utf8')
const HANDOFF = readFileSync(new URL('../../scanner_mode_handoff.md', import.meta.url), 'utf8')

const call = (opts) => {
    let got = null
    return scannerAgentService.chatStream({
        messages: [{ role: 'user', content: 'find me one' }],
        _run: async (args) => { got = args; return 'ok' },
        ...opts,
    }).then(() => got)
}

test('a list turn never sees the hand-off module', async () => {
    const got = await call({})
    assert.equal(got.systemPrompt.length, 2, 'spine + dynamic tail only')
    const all = got.systemPrompt.map(b => b.text).join('\n')
    assert.doesNotMatch(all, /KAIROS HAND-OFF/)
    assert.doesNotMatch(all, /kairos_pick/)
    assert.doesNotMatch(all, /find ONE ticker/)
})

test('a hand-off turn gets the module as its own cached block, after the spine', async () => {
    const got = await call({ handoff: true })
    assert.equal(got.systemPrompt.length, 3, 'spine + mode module + dynamic tail')
    assert.match(got.systemPrompt[1].text, /KAIROS HAND-OFF MODE — find ONE ticker/)
    assert.match(got.systemPrompt[1].text, /<kairos_pick>/)
    assert.equal(got.systemPrompt[1].cache_control?.type, 'ephemeral')
    // The marker declares the live mode in the volatile tail; the module carries what it means.
    assert.match(got.systemPrompt[2].text, /ACTIVE MODE: KAIROS HAND-OFF/)
})

// BREAKPOINT BUDGET: four per request — tools take one, _stampHistoryCache takes one, so the system
// prompt may spend at most two. A third here is a prod-only 400.
test('at most two cache breakpoints in the system prompt, in either mode', async () => {
    for (const handoff of [false, true]) {
        const got = await call({ handoff })
        const marked = got.systemPrompt.filter(b => b.cache_control).length
        assert.ok(marked <= 2, `${marked} breakpoints with handoff=${handoff}`)
    }
})

test('the hand-off is a TRADING path — the investing profile never gets the module', async () => {
    const got = await call({ handoff: true, profile: 'investing' })
    assert.equal(got.systemPrompt.length, 2)
    assert.doesNotMatch(got.systemPrompt.map(b => b.text).join('\n'), /kairos_pick/)
})

// ── the two files, as text ───────────────────────────────────────────────────
test('the spine no longer carries the hand-off section', () => {
    assert.doesNotMatch(SPINE, /KAIROS HAND-OFF MODE/)
    assert.doesNotMatch(SPINE, /VALIDATE-A-NAME/)
    assert.doesNotMatch(SPINE, /kairos_pick/)
    // …but it keeps what BOTH modes use: the screening spine and the shared lens vocabulary.
    assert.match(SPINE, /HOW YOU SCAN — the professional spine/)
    assert.match(SPINE, /Set `recommended_mode`/)
})

test('the module states what it overrides rather than silently contradicting the spine', () => {
    assert.match(HANDOFF, /REPLACES the list-building shape/)
    assert.match(HANDOFF, /never\s+`?<scan_list>`?/)
    assert.match(HANDOFF, /VALIDATE-A-NAME/)
    // recommended_mode is DEFINED once, in the spine's Phase 3 — the module points at it instead of
    // carrying a second copy that can drift.
    assert.match(HANDOFF, /the same Kairos build lens the spine defines in Phase 3/)
})
