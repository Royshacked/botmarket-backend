import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'

import { scannerAgentService } from '../../services/agents/scanner.agent.service.js'

// Argus's build hand-off is a MODE of the trading profile, not a profile of its own: it shares the
// whole screening spine and differs only in what it converges on (one name) and what it emits
// (<kairos_pick>). It used to live INSIDE the trading prompt, so a list-building turn read fifty
// lines telling it to find ONE ticker and not emit a scan_list, and a hand-off turn read the list
// machinery and phase gate it then had to override. It is now its own injected module.
//
// The DESTINATION is the other thing this file guards. The module is a cached block and the desk
// name is per-request, so the name lives in the volatile tail — and the module must not name a desk
// itself. It did, for two months after the trade desk moved its build step from Kairos to Mentor,
// which is how Argus came to tell users their pick was going somewhere it wasn't.

const SPINE   = readFileSync(new URL('../../prompts/scanner_system_prompt.md', import.meta.url), 'utf8')
const HANDOFF = readFileSync(new URL('../../prompts/scanner_mode_handoff.md', import.meta.url), 'utf8')

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
    assert.doesNotMatch(all, /BUILD HAND-OFF/)
    assert.doesNotMatch(all, /kairos_pick/)
    assert.doesNotMatch(all, /find ONE ticker/)
})

test('a hand-off turn gets the module as its own cached block, after the spine', async () => {
    const got = await call({ handoff: true })
    assert.equal(got.systemPrompt.length, 3, 'spine + mode module + dynamic tail')
    assert.match(got.systemPrompt[1].text, /BUILD HAND-OFF MODE — find ONE ticker/)
    assert.match(got.systemPrompt[1].text, /<kairos_pick>/)
    assert.equal(got.systemPrompt[1].cache_control?.type, 'ephemeral')
    // The marker declares the live mode in the volatile tail; the module carries what it means.
    assert.match(got.systemPrompt[2].text, /ACTIVE MODE: BUILD HAND-OFF/)
})

// ── the destination ──────────────────────────────────────────────────────────
test('the destination desk is named in the VOLATILE tail, never the cached module', async () => {
    for (const handoffTo of ['mentor', 'kairos']) {
        const got = await call({ handoff: true, handoffTo })
        const expected = handoffTo === 'mentor' ? /Mentor/ : /Kairos/
        assert.match(got.systemPrompt[2].text, expected, `${handoffTo} unnamed in the tail`)
        // The module may DISTINGUISH the two desks (it tells Argus how they differ, naming both);
        // what it must never do is assert which one sent this user, because it is one shared cached
        // block and that sentence would be wrong for half of them.
        assert.doesNotMatch(got.systemPrompt[1].text, /sent here by (Mentor|Kairos)/,
            'the cached module claims a specific sender')
    }
})

test('the two destinations produce DIFFERENT tails and an IDENTICAL cached module', async () => {
    const toMentor = await call({ handoff: true, handoffTo: 'mentor' })
    const toKairos = await call({ handoff: true, handoffTo: 'kairos' })
    assert.notEqual(toMentor.systemPrompt[2].text, toKairos.systemPrompt[2].text)
    // Byte-identical, or the shared block stops being one cache entry.
    assert.equal(toMentor.systemPrompt[1].text, toKairos.systemPrompt[1].text)
})

test('an unknown or absent destination degrades to generic — never a guessed desk', async () => {
    for (const handoffTo of [null, undefined, 'atlas', 'DROP TABLE']) {
        const tail = (await call({ handoff: true, handoffTo })).systemPrompt[2].text
        assert.match(tail, /the build desk that sent them/)
        assert.doesNotMatch(tail, /\bMentor\b/)
        assert.doesNotMatch(tail, /\bKairos\b/)
    }
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
    assert.doesNotMatch(SPINE, /BUILD HAND-OFF MODE/)
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
    assert.match(HANDOFF, /the same build lens the spine defines in Phase 3/)
})

// ── the two branches ─────────────────────────────────────────────────────────
// A named ticker and an empty brief are two different jobs, and the module used to state the
// angle-first rule as an unconditional "your FIRST turn must ask" with the named-ticker branch
// fifty lines further down. A user who typed "tsla" got asked what angle to hunt — a screening
// question about a universe one name wide. Ordering is the fix: the branch is decided FIRST, and
// each rule lives under the branch it belongs to rather than in a shared preamble.
const sectionsOf = (md) => md.split(/^## /m).slice(1).map(s => '## ' + s)
const sectionWith = (md, needle) => sectionsOf(md).find(s => s.includes(needle)) ?? ''

test('the branch fork is decided BEFORE the angle-first rule, not after it', () => {
    const fork  = HANDOFF.indexOf('does it name a specific ticker?')
    const angle = HANDOFF.indexOf('ASK for the scan angle FIRST')
    assert.ok(fork > -1, 'no branch fork')
    assert.ok(angle > -1, 'no angle rule')
    assert.ok(fork < angle, 'the angle rule is read before the branch that may cancel it')
})

test('the angle-first rule lives under the no-ticker branch, never in a shared preamble', () => {
    const owner = sectionWith(HANDOFF, 'ASK for the scan angle FIRST')
    assert.match(owner, /^## FIND-ONE-TICKER/)
})

test('the named-ticker branch forbids the angle question outright', () => {
    const validate = sectionWith(HANDOFF, 'VALIDATE-A-NAME — ')
    assert.match(validate, /Do NOT ask for an angle/)
    // …and it must not send the user away to answer one before any tool has run.
    assert.match(validate, /do \*\*not\*\* open with a\s+question/)
})

// ── the phase tag, per branch ────────────────────────────────────────────────
// `<phase>` is not decoration: the client shows the Phase-1 angle chips off it (ScannerPanel's
// showAngleStrip) and modelRouter routes phase 1 to HAIKU as "thesis extraction". A validate turn
// tagged 1 therefore asked the screening question a SECOND time in the UI after the prose had been
// told not to, and sent the next tool-heavy turn to the cheap model. The branch decides the floor.
test('the validate branch starts at phase 3 and forbids 1 and 2', () => {
    const validate = sectionWith(HANDOFF, 'VALIDATE-A-NAME — ')
    assert.match(validate, /never emit\s+`?<phase>1<\/phase>`?/)
    assert.match(validate, /<phase>3<\/phase>/)
    // …and it says WHY, so the rule survives an edit by someone who never saw the chips.
    assert.match(validate, /strip of screening angles/)
})

test('the find-one branch keeps phase 1 — the chips are help there', () => {
    const find = sectionWith(HANDOFF, 'FIND-ONE-TICKER — ')
    assert.match(find, /Phase 1 is correct here and only here/)
})

test('the overrides list points at the per-branch phase rule', () => {
    const preamble = HANDOFF.split(/^## /m)[0]
    assert.match(preamble, /`<phase>` tag still rides on every response/)
})

// The spine is read on EVERY trading turn, hand-off or not, so a desk name in it reaches users the
// mode module never touches. It named Kairos in four places while the trade desk built with Mentor.
test('the spine never names a build desk — it does not know which one is listening', () => {
    assert.doesNotMatch(SPINE, /\bKairos\b/)
    assert.doesNotMatch(SPINE, /\bMentor\b/)
})

// The module MAY name desks — it has to, to tell Argus how the two differ and to explain why the
// wire tag is spelled `kairos_pick`. What it must not do is name one ALONE: a lone "Kairos" in a
// block both destinations read is the exact shape of the bug this fixes. Checked per paragraph,
// because that is the unit a reader takes a claim from.
test('the module never names one desk without the other', () => {
    for (const para of HANDOFF.split(/\n\s*\n/)) {
        const kairos = /\bKairos\b/.test(para), mentor = /\bMentor\b/.test(para)
        assert.equal(kairos, mentor,
            `a paragraph names ${kairos ? 'Kairos' : 'Mentor'} alone:\n${para.trim()}`)
    }
})
