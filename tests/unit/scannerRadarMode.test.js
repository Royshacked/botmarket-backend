import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'

import { scannerAgentService } from '../../services/agents/scanner.agent.service.js'

// RADAR CUT is Argus's second mode, and the mirror image of the build hand-off: hand-off replaces
// the LIST half of the spine (it converges on one name), radar replaces the DISCOVERY half (the
// universe is given, and it converges on a short list). Both are modes of the trading profile
// rather than profiles of their own, for the same reason — the screening spine is shared and only
// the ends differ.
//
// WHAT THIS FILE GUARDS. Three things, each of which has a way of going quietly wrong:
//   - an ordinary list turn must not see either module, or Argus reads a page telling it the pool
//     already exists when the user just asked it to find one;
//   - the two modes must never both be live, because one ends in <kairos_pick> and the other in
//     <scan_list> and a turn cannot do both;
//   - the module must not carry the universe. It is a cached block, so interpolating a hundred
//     names into it would give every board its own cache entry — the same rule that keeps the
//     hand-off's destination desk out of its module.

const RADAR = readFileSync(new URL('../../prompts/scanner_mode_radar.md', import.meta.url), 'utf8')

const call = (opts) => {
    let got = null
    return scannerAgentService.chatStream({
        messages: [{ role: 'user', content: 'cut this board' }],
        _run: async (args) => { got = args; return 'ok' },
        ...opts,
    }).then(() => got)
}

test('an ordinary list turn never sees the radar module', async () => {
    const got = await call({})
    assert.equal(got.systemPrompt.length, 2, 'spine + dynamic tail only')
    const all = got.systemPrompt.map(b => b.text).join('\n')
    assert.doesNotMatch(all, /RADAR CUT/)
})

test('a radar turn gets the module as its own cached block, after the spine', async () => {
    const got = await call({ radar: true })
    assert.equal(got.systemPrompt.length, 3, 'spine + mode module + dynamic tail')
    assert.match(got.systemPrompt[1].text, /RADAR CUT MODE — a given universe/)
    assert.equal(got.systemPrompt[1].cache_control?.type, 'ephemeral')
    assert.match(got.systemPrompt[2].text, /ACTIVE MODE: RADAR CUT/)
})

test('hand-off WINS when a caller sets both — one ends in a pick, the other in a list', async () => {
    const got = await call({ radar: true, handoff: true })
    assert.equal(got.systemPrompt.length, 3, 'exactly one mode module, never two')
    assert.match(got.systemPrompt[1].text, /BUILD HAND-OFF MODE/)
    assert.doesNotMatch(got.systemPrompt.map(b => b.text).join('\n'), /RADAR CUT/)
})

test('radar is a trading-profile path — the investing screen never enters it', async () => {
    const got = await call({ radar: true, profile: 'investing' })
    assert.equal(got.systemPrompt.length, 2)
    assert.doesNotMatch(got.systemPrompt.map(b => b.text).join('\n'), /RADAR CUT/)
})

test('the breakpoint budget holds: at most two cached system blocks', async () => {
    for (const opts of [{}, { radar: true }, { handoff: true }, { radar: true, handoff: true }]) {
        const got = await call(opts)
        const cached = got.systemPrompt.filter(b => b.cache_control?.type === 'ephemeral').length
        assert.ok(cached <= 2, `${JSON.stringify(opts)} produced ${cached} cached blocks`)
    }
})

// ── the module itself ────────────────────────────────────────────────────────

test('the module sends Argus to the two BATCH calls before any per-name work', () => {
    assert.match(RADAR, /get_earnings_calendar/)
    assert.match(RADAR, /get_quotes/)
    // The ordering is the whole point — per-name tools on a hundred names is what it prevents.
    assert.ok(RADAR.indexOf('get_earnings_calendar') < RADAR.indexOf('get_price_action'),
        'the calendar sweep must be taught before the per-name tools')
})

test('the module tells Argus the stated side is context, never a filter or a rank', () => {
    assert.match(RADAR, /HELPED/)
    assert.match(RADAR, /HURT/)
    assert.match(RADAR, /never a filter and never a rank/)
})

test('the module starts at phase 3 and drops the gate before 4', () => {
    assert.match(RADAR, /Phase 3/)
    assert.match(RADAR, /No phase gate between 3 and 4/)
})

test('the module carries no universe of its own — it is a cached block', () => {
    // A ticker in the module would mean a board baked into the cache prefix. The only capitals
    // allowed are the vocabulary; no ticker-shaped literal belongs here.
    assert.doesNotMatch(RADAR, /<scan_universe>/)
    assert.doesNotMatch(RADAR, /\bNVDA\b|\bAAPL\b|\bTSLA\b/)
})

// ── the board in the tail ────────────────────────────────────────────────────

const BOARD = {
    runs: 16,
    held: 12,
    candidates: [
        { ticker: 'NUE', company: 'Nucor', thesis: 'HURT by Canada (2026-09-20) — imports steel' },
        { ticker: 'XOM', company: 'Exxon', thesis: 'HELPED by Hormuz', returning: true },
    ],
}

test('the board rides in the VOLATILE tail, never the cached module', async () => {
    const got = await call({ radar: true, radarBoard: BOARD })
    const tail = got.systemPrompt[2].text
    assert.match(tail, /THE BOARD — 2 names Aether's events reached across 16 events/)
    assert.match(tail, /12 more held back/)
    assert.match(tail, /- NUE \(Nucor\)/)
    // Never in the cached block: a board baked into the prefix gives every day its own cache entry.
    assert.doesNotMatch(got.systemPrompt[1].text, /\bNUE\b/)
})

test('a returning name is flagged in the board, so Argus can say why it is back', async () => {
    const got = await call({ radar: true, radarBoard: BOARD })
    assert.match(got.systemPrompt[2].text, /XOM \(Exxon\) \[BACK — a new event named it since your last list\]/)
    assert.doesNotMatch(got.systemPrompt[2].text, /NUE \(Nucor\) \[BACK/)
})

test('the board repeats the side rule where the names are, not only in the module', async () => {
    const got = await call({ radar: true, radarBoard: BOARD })
    assert.match(got.systemPrompt[2].text, /context only — not a filter, not a rank/)
})

test('a radar turn with NO board is a later turn of the cut — the tail carries no board', async () => {
    const got = await call({ radar: true })
    assert.match(got.systemPrompt[2].text, /ACTIVE MODE: RADAR CUT/)
    assert.doesNotMatch(got.systemPrompt[2].text, /THE BOARD/)
})

test('an empty board is treated as no board rather than as "the radar found nothing"', async () => {
    const got = await call({ radar: true, radarBoard: { candidates: [], runs: 0 } })
    assert.doesNotMatch(got.systemPrompt[2].text, /THE BOARD/)
})

test('a board without the radar flag is never rendered — the mode is what admits it', async () => {
    const got = await call({ radarBoard: BOARD })
    // \bNUE\b rather than /NUE/: VENUE_RULE is appended to the spine, so a loose match always hits.
    assert.doesNotMatch(got.systemPrompt.map(b => b.text).join('\n'), /THE BOARD|\bNUE\b/)
})
