// The one rule that decides what language every desk writes in.
//   node --test tests/unit/languageRule.test.js
//
// Two things are tested, and the second is the one that will actually fail one day:
//   1. the rule SAYS the right thing (English default; only an explicit ask switches it)
//   2. every desk that mounts a system prompt actually CARRIES it — and a new desk cannot be added
//      without either carrying it or failing this file.
//
// Why it matters more than a tone preference: these agents write when nobody is in the room. A
// headless re-model, a scheduled monitor card, a notification. Those runs have no conversation to
// take a language from, so a rule phrased as "the language of the conversation" binds to nothing and
// the model picks — which is how a ZTS coverage doc got rewritten in Portuguese over an English
// thesis on 2026-08-05, with nobody asking and nothing wrong with the research.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { LANGUAGE_RULE, VENUE_RULE } from '../../services/agentUtils.js'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '../../')
const SERVICES = join(ROOT, 'services')

// Every desk that mounts a BASE system prompt. Mode/profile FRAGMENTS (kairos_mode_*.md,
// scanner_mode_handoff.md) are deliberately absent: they are concatenated onto a base that already
// carries the rule, and appending it again would repeat the same paragraph twice in one request.
const DESKS = [
    'aether.agent.service.js',
    'analyst.agent.service.js',
    'axl.agent.service.js',
    'marketBrief.service.js',
    'mentor.agent.service.js',
    'portfolio.agent.service.js',
    'scanner.agent.service.js',
    'strategy.agent.service.js',
]

// A desk file may sit in services/ (marketBrief) or services/agents/ (the seven agents).
const src = (f) => {
    for (const d of [join(SERVICES, 'agents'), SERVICES]) {
        try { return readFileSync(join(d, f), 'utf-8') } catch { /* try the next */ }
    }
    throw new Error(`desk source not found: ${f}`)
}

// ─── 1. what the rule says ────────────────────────────────────────────────────

test('English is the default, stated as a default and not as a preference', () => {
    assert.match(LANGUAGE_RULE, /LANGUAGE: Write in English\./)
})

test('the default covers SAVED prose, not just the reply', () => {
    // The reply is thrown away; the thesis is not. A rule that only bound the chat would have left
    // the exact ZTS failure — a stored artifact in a language nobody asked for — wide open.
    assert.match(LANGUAGE_RULE, /prose you emit into something that gets saved/)
    assert.match(LANGUAGE_RULE, /thesis/)
})

test('only an EXPLICIT request switches, and writing in another language is not one', () => {
    assert.match(LANGUAGE_RULE, /Switch only when the user EXPLICITLY asks/)
    assert.match(LANGUAGE_RULE, /WRITING to you in another language is not one/)
    assert.match(LANGUAGE_RULE, /keep answering in English until they actually ask/)
})

test('the request itself may be written in any language', () => {
    // The distinction the whole rule turns on: we gate on ASKING, never on the language of the ask.
    // A user who wants Hebrew should not have to request it in English to be understood.
    assert.match(LANGUAGE_RULE, /no matter which language it is written in/)
    assert.match(LANGUAGE_RULE, /תענה לי בעברית/, 'the non-English example is the point — keep one')
})

test('a switch persists for the conversation rather than for one turn', () => {
    assert.match(LANGUAGE_RULE, /stay in that language for the rest of the conversation/)
})

test('enum fields stay canonical English in every language', () => {
    // These are validated values (coverage RATINGS/STATUSES, call sides, horizons). A translated
    // `rating` does not read as a language choice downstream — it reads as an invalid value and
    // normalizes to null.
    assert.match(LANGUAGE_RULE, /canonical English ALWAYS/)
    assert.match(LANGUAGE_RULE, /rating, status, side, horizon, band_basis/)
})

// ─── 2. that every desk carries it ────────────────────────────────────────────

test('every desk appends the rule to its base prompt, exactly once', () => {
    for (const f of DESKS) {
        const s = src(f)
        // `./` from services/ (marketBrief), `../` from services/agents/ — the specifier depends on
        // where the desk lives, which is not what this guard is about.
        assert.match(s, /import \{[^}]*\bLANGUAGE_RULE\b[^}]*\} from '\.\.?\/agentUtils\.js'/, `${f} does not import LANGUAGE_RULE`)
        const uses = s.match(/\+ LANGUAGE_RULE/g) ?? []
        assert.equal(uses.length, 1, `${f} appends LANGUAGE_RULE ${uses.length} times — expected exactly 1`)
    }
})

test('the rule rides on the CACHED prefix, not the volatile tail', () => {
    // It is byte-identical on every request, so it belongs behind the cache_control breakpoint with
    // the static prompt. In the dynamic block it would be re-sent uncached on every turn, forever.
    //
    // Matched through `cachedBlock()` — agentUtils' one spelling of that breakpoint. This guard used
    // to match the raw `cache_control: { type: 'ephemeral' }` object literal at each desk, which is
    // what the literal being written out seven times looked like from here; when the seven were
    // folded into the helper, this test failed on all of them at once while the behaviour was
    // identical. That is the guard working — it just has one form to recognise now instead of seven
    // hand-copies, which is the same reason the helper exists.
    for (const f of DESKS) {
        assert.match(
            src(f),
            /cachedBlock\(\w+\(\) \+ LANGUAGE_RULE(?: \+ VENUE_RULE)?(?: \+ BREVITY_RULE)?\)/,
            `${f} appends LANGUAGE_RULE somewhere other than the cached system-prompt entry`,
        )
    }
})

// ─── 3. the venue rule, which rides the same seam for the same reasons ────────
// Same shape as the language rule and the same failure mode: one paragraph, authored once, that has
// to be on every desk that can be asked "are we in paper or live?". Wired as a constant rather than
// eight prompt paragraphs because eight copies drift, and a desk asking for something another desk
// was handed is the exact bug this fixes.
//
// TWO desks are deliberately absent, and the list below is the record of why — both write for
// EVERYBODY at once, so they have no user whose venue could be read: marketBrief and strategy
// (Pythia) are broadcasts, and neither carries the venue TOOLS either, for the same reason.
const VENUE_DESKS = DESKS.filter(f => !['aether.agent.service.js', 'marketBrief.service.js', 'strategy.agent.service.js'].includes(f))

test('every desk that has a user carries the venue rule, exactly once', () => {
    for (const f of VENUE_DESKS) {
        const s = src(f)
        assert.match(s, /import \{[^}]*\bVENUE_RULE\b[^}]*\} from '\.\.?\/agentUtils\.js'/, `${f} does not import VENUE_RULE`)
        const uses = s.match(/\+ VENUE_RULE/g) ?? []
        assert.equal(uses.length, 1, `${f} appends VENUE_RULE ${uses.length} times — expected exactly 1`)
    }
})

test('a broadcast desk carries NO venue rule — it has no user to read one for', () => {
    for (const f of ['aether.agent.service.js', 'marketBrief.service.js', 'strategy.agent.service.js']) {
        assert.doesNotMatch(src(f), /VENUE_RULE/,
            `${f} writes for every user at once; a venue block there would be one user's book leaking into a broadcast`)
    }
})

test('the venue rule forbids ASKING, not DECIDING', () => {
    // The line it must not cross. Venue FACTS are the app's and may be enforced in code; what a desk
    // DOES with them stays the desk's judgment, and a rule that blurred the two would stop agents
    // asking the questions they SHOULD ask (which account fits, is this cash enough).
    assert.match(VENUE_RULE, /NEVER ASK/)
    assert.match(VENUE_RULE, /available to deploy/, 'the free-cash number is named, and named the same way everywhere')
    assert.match(VENUE_RULE, /never against balance/, 'and the trap it exists to prevent is stated')
    assert.match(VENUE_RULE, /is still yours|still your judgment|that is your judgment/i,
        'the decide-half must survive: this rule governs facts, not choices')
})

test('the rule names THREE workspaces and keeps manual distinct from both neighbours', () => {
    // Manual is real money at an institution the app cannot reach, built and monitored exactly like
    // paper. Collapsed into live, a desk claims the app placed an order nobody placed; collapsed
    // into paper, it discusses real money as practice. Both directions are named so neither is left
    // to inference.
    assert.match(VENUE_RULE, /THREE WORKSPACES/)
    assert.match(VENUE_RULE, /MANUAL is real money/)
    assert.match(VENUE_RULE, /built and monitored exactly like paper/)
    assert.match(VENUE_RULE, /Never collapse manual into live/)
    assert.match(VENUE_RULE, /its money is real/)
})

test('a NEW desk cannot be added without carrying the rule', () => {
    // The completeness guard. DESKS above is hand-written, so on its own it would silently miss the
    // ninth agent. Anything under services/ that loads a *_system_prompt.md (or the market brief)
    // is mounting a base prompt and must be on the list.
    //
    // The path must be QUOTED to count — a file that merely NAMES a prompt in a comment is not
    // mounting it (scanner.grounding.js cites `scanner_system_prompt.md L11` to explain which
    // doctrine it backs), and a prose mention is not a reason to demand the rule.
    const MOUNTS_BASE_PROMPT = /['"][^'"]*(_system_prompt|market_brief_prompt)\.md['"]/
    // Both directories: the desks moved to services/agents/ (2026-08-07) but marketBrief.service
    // mounts a base prompt from services/ and is a desk for this rule's purposes. Scanning only one
    // would let the guard pass while seeing nothing.
    const dirs = [SERVICES, join(SERVICES, 'agents')]
    const mounts = dirs
        .flatMap(d => readdirSync(d).filter(f => f.endsWith('.js')).map(f => ({ d, f })))
        .filter(({ d, f }) => MOUNTS_BASE_PROMPT.test(readFileSync(join(d, f), 'utf-8')))
        .map(({ f }) => f)
        .sort()
    assert.deepEqual(mounts, [...DESKS].sort(),
        'a service mounts a base system prompt but is not on the DESKS list (add it, and give it LANGUAGE_RULE)')
})
