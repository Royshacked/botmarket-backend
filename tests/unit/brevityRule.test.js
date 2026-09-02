// The one rule that decides how LONG every desk's reply is.
//   node --test tests/unit/brevityRule.test.js
//
// Sibling of languageRule.test.js, guarding the third rule on the same seam, and written for the
// same reason: the paragraph is authored ONCE in agentUtils and every desk has to carry it.
//
// The history this replaces is the argument for it. Six desks each said something different about
// length — mentor "3–5 sentences", portfolio "keep answers focused", scanner "one tight paragraph
// or a few bullets", axl "a few sentences" — and analyst and strategy said NOTHING, so Prometheus
// and Pythia answered at whatever length the model felt like. Four phrasings and two silences is
// exactly the drift a shared constant exists to end.
//
// Two things are tested, and as with the language rule the second is the one that will fail one day:
//   1. the rule SAYS the right thing (countable caps, substance protected, saved prose exempt)
//   2. every conversational desk CARRIES it — and a new desk cannot be added without carrying it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { BREVITY_RULE } from '../../services/agentUtils.js'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '../../')
const SERVICES = join(ROOT, 'services')

// Every desk a user TALKS to. marketBrief is deliberately absent — see the last test in this file.
const DESKS = [
    'aether.agent.service.js',
    'analyst.agent.service.js',
    'axl.agent.service.js',
    'mentor.agent.service.js',
    'portfolio.agent.service.js',
    'scanner.agent.service.js',
    'strategy.agent.service.js',
]

const src = (f) => {
    for (const d of [join(SERVICES, 'agents'), SERVICES]) {
        try { return readFileSync(join(d, f), 'utf-8') } catch { /* try the next */ }
    }
    throw new Error(`desk source not found: ${f}`)
}

// ─── 1. what the rule says ────────────────────────────────────────────────────

test('the caps are COUNTABLE, not a preference', () => {
    // The whole design turn. "Be concise" is read as a preference and dissolves into the register of
    // the surrounding prompt within a couple of turns; a number the model can check against what it
    // just wrote survives. If someone softens these back into adjectives, this fails.
    assert.match(BREVITY_RULE, /Four sentences or fewer/)
    assert.match(BREVITY_RULE, /Under about 25 words/)
    assert.match(BREVITY_RULE, /Three or more items/)
})

test('the sentence cap is there, not just the reply cap', () => {
    // The actual complaint that started this: replies were not merely long, they were long
    // SENTENCES — clause stacked on clause. A four-sentence cap alone is satisfied by four
    // 60-word sentences, which is the same wall of text with fewer full stops.
    assert.match(BREVITY_RULE, /short means SENTENCES too/)
    assert.match(BREVITY_RULE, /One idea per sentence/)
})

test('bullets are required at a threshold, not merely permitted', () => {
    assert.match(BREVITY_RULE, /the answer is BULLETS/)
    assert.match(BREVITY_RULE, /one line each/)
})

test('SUBSTANCE is protected from the cap in the loudest line in the rule', () => {
    // The failure mode a length rule creates: an agent hits four sentences by dropping the risk
    // warning, and the answer is now short AND wrong. Trading advice is the worst possible place to
    // buy brevity with omission, so the protection is stated in capitals and given its own paragraph.
    assert.match(BREVITY_RULE, /LENGTH IS THE ONLY THING BEING CUT — NEVER THE SUBSTANCE/)
    assert.match(BREVITY_RULE, /is a worse answer, not a shorter one/)
})

test('depth on request is explicitly not a violation', () => {
    // Without this the rule fights every "explain this to me" the app is meant to answer well —
    // including Axl's concept teaching, which is the one place authored text is quoted in full.
    assert.match(BREVITY_RULE, /Depth on request is not a violation/)
    assert.match(BREVITY_RULE, /explain, teach, compare or go deeper/)
})

test('SAVED prose is exempt — the cap governs the spoken reply only', () => {
    // The boundary that keeps this from damaging artifacts. A `thesis` or `kill_criteria` written to
    // four sentences is not a tighter document, it is an incomplete one, and unlike a chat reply it
    // persists. Note this is the OPPOSITE boundary to LANGUAGE_RULE, which deliberately DOES reach
    // saved prose — the two rules bound different things and must not be "made consistent".
    assert.match(BREVITY_RULE, /governs the reply you SPEAK/)
    assert.match(BREVITY_RULE, /thesis, kill-criteria, a rationale/)
    assert.match(BREVITY_RULE, /is not capped here/)
})

test('the rule practises what it preaches', () => {
    // A brevity rule written in 40-word sentences teaches the model the opposite of what it says —
    // the prompt's own register is a style prior the model reads whether or not we meant it to.
    // The prose lines are held to roughly the cap they impose; the bullets are the cap itself.
    const longest = BREVITY_RULE
        .split('\n')
        .filter(l => l.trim() && !l.trim().startsWith('-'))
        .flatMap(l => l.split(/(?<=[.!?])\s+/))
        .map(s => s.trim().split(/\s+/).length)
        .reduce((a, b) => Math.max(a, b), 0)
    assert.ok(longest <= 40, `the brevity rule's own longest sentence is ${longest} words — practise it`)
})

// ─── 2. that every desk carries it ────────────────────────────────────────────

test('every conversational desk appends the rule to its base prompt, exactly once', () => {
    for (const f of DESKS) {
        const s = src(f)
        assert.match(s, /import \{[^}]*\bBREVITY_RULE\b[^}]*\} from '\.\.?\/agentUtils\.js'/, `${f} does not import BREVITY_RULE`)
        const uses = s.match(/\+ BREVITY_RULE/g) ?? []
        assert.equal(uses.length, 1, `${f} appends BREVITY_RULE ${uses.length} times — expected exactly 1`)
    }
})

test('it rides the CACHED prefix, and rides it LAST', () => {
    // Byte-identical on every request, so it belongs behind the cache_control breakpoint with the
    // static prompt rather than in the volatile tail where it would be re-sent uncached forever.
    // Last in the chain on purpose: it is the rule most likely to be contradicted by something
    // earlier in a 500-line desk prompt, and the closing instruction is the one that sticks.
    for (const f of DESKS) {
        assert.match(
            src(f),
            /cachedBlock\(\w+\(\) \+ LANGUAGE_RULE(?: \+ VENUE_RULE)? \+ BREVITY_RULE\)/,
            `${f} appends BREVITY_RULE somewhere other than the end of the cached system-prompt entry`,
        )
    }
})

test('the market brief carries NO brevity rule — it is an authored broadcast with its own spec', () => {
    // market_brief_prompt.md commissions 250–350 words of prose with short headings, read once by
    // every user. A four-sentence cap would fight that spec directly, and the brief is not a reply
    // to anyone — there is no conversation for it to be too long in.
    assert.doesNotMatch(src('marketBrief.service.js'), /BREVITY_RULE/,
        'the brief is written to a word count, not to a chat cap')
})

test('a NEW desk cannot be added without carrying the rule', () => {
    // The completeness guard, mirroring languageRule.test.js: DESKS above is hand-written, so on its
    // own it would silently miss the next agent. Anything under services/ that mounts a base
    // *_system_prompt.md is a conversational desk and belongs on the list.
    //
    // The path must be QUOTED to count — a file that merely NAMES a prompt in a comment is not
    // mounting it (scanner.grounding.js cites `scanner_system_prompt.md L11` in prose).
    const MOUNTS_BASE_PROMPT = /['"][^'"]*_system_prompt\.md['"]/
    const dirs = [SERVICES, join(SERVICES, 'agents')]
    const mounts = dirs
        .flatMap(d => readdirSync(d).filter(f => f.endsWith('.js')).map(f => ({ d, f })))
        .filter(({ d, f }) => MOUNTS_BASE_PROMPT.test(readFileSync(join(d, f), 'utf-8')))
        .map(({ f }) => f)
        .sort()
    assert.deepEqual(mounts, [...DESKS].sort(),
        'a service mounts a base system prompt but is not on the DESKS list (add it, and give it BREVITY_RULE)')
})
