import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { getConcept, listConcepts, allConcepts, normalizeKey } from '../../services/concepts.service.js'

// The authored concept set — the explanations a beginner reads verbatim.
//
// Two kinds of test here. The first is ordinary parsing and lookup. The second is CONTENT
// STRUCTURE: cheap proxies that stop the set quietly decaying into a dictionary of one-liners,
// because the thing that makes it teaching is the parts a dictionary leaves out — what it costs
// you, and the mistake people actually make.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(__dirname, '../../concepts.md'), 'utf8')

// ─── normalisation ────────────────────────────────────────────────────────────

test('case, spaces, hyphens and underscores all collapse to the same key', () => {
    const forms = ['stop loss', 'Stop Loss', 'STOP-LOSS', 'stop_loss', '  stop loss  ']
    const keys = forms.map(normalizeKey)
    assert.equal(new Set(keys).size, 1, forms.join(' / '))
})

test('a plural resolves to the singular', () => {
    assert.equal(normalizeKey('stops'), normalizeKey('stop'))
})

test('a word ending in "ss" keeps its s — a loss must not become a "los"', () => {
    assert.equal(normalizeKey('loss'), 'loss')
})

test('a very short input is left alone rather than stripped to nothing', () => {
    assert.equal(normalizeKey('r'), 'r')
    assert.equal(normalizeKey(''), '')
    assert.equal(normalizeKey(null), '')
})

// ─── lookup ───────────────────────────────────────────────────────────────────

test('the file parses into the full set', () => {
    const keys = listConcepts()
    assert.ok(keys.length >= 15, `expected the authored set, got ${keys.length}`)
    assert.equal(new Set(keys).size, keys.length, 'no duplicate keys')
})

test('a concept resolves by its own key', () => {
    assert.equal(getConcept('stop')?.key, 'stop')
    assert.equal(getConcept('drawdown')?.key, 'drawdown')
})

test('the aliases people actually type resolve', () => {
    // Each of these is a phrase a real beginner would use, mapped from the app's own card copy.
    assert.equal(getConcept('stop loss')?.key, 'stop')
    assert.equal(getConcept('R')?.key, 'r-multiple')
    assert.equal(getConcept('buy market')?.key, 'market-vs-limit')
    assert.equal(getConcept('stopped out')?.key, 'why-a-stop-is-not-a-failure')
    assert.equal(getConcept('paper trading')?.key, 'paper-vs-live')
})

test('an unknown concept returns null rather than throwing — a miss is a normal answer', () => {
    assert.equal(getConcept('wedge pattern'), null)
    assert.equal(getConcept(''), null)
    assert.equal(getConcept(null), null)
    assert.equal(getConcept(42), null)
})

test('re-reading is memoised — the file is parsed once while it is unchanged', () => {
    // Identity, not deep equality: a re-parse would build new objects.
    assert.equal(getConcept('stop'), getConcept('stop'))
    assert.equal(allConcepts()[0], allConcepts()[0])
})

test('the Aliases line never leaks into the body the user reads', () => {
    for (const c of allConcepts()) {
        assert.doesNotMatch(c.body, /^aliases:/im, c.key)
    }
})

test("the file's own heading and guidance are not parsed as concepts", () => {
    // The file opens with a `# Concepts` title and authoring notes above the first entry.
    assert.ok(!listConcepts().includes('Concepts'))
    assert.equal(getConcept('concepts'), null)
})

test('a singular that LOOKS plural still resolves — normalisation is symmetric', () => {
    // "thesis" normalises to "thesi", because the plural rule can't tell it from a plural. That is
    // harmless ONLY because the same rule is applied when indexing and when looking up. Anyone
    // making the stripping smarter must keep both sides in step, or this breaks silently.
    assert.equal(getConcept('thesis')?.key, 'thesis')
    assert.equal(normalizeKey('thesis'), normalizeKey('thesis'))
})

test('no two concepts collapse onto the same key once normalised', () => {
    // A latent bug class rather than a current bug: two keys that normalise alike would make one
    // of them permanently unreachable, with nothing failing to say so.
    const seen = new Map()
    for (const c of allConcepts()) {
        const n = normalizeKey(c.key)
        assert.ok(!seen.has(n), `"${c.key}" collides with "${seen.get(n)}" (both → ${n})`)
        seen.set(n, c.key)
    }
})

test('no alias is claimed by two concepts', () => {
    // The index is a Map, so a shared alias would silently resolve to whichever concept parsed
    // last — a wrong answer with no error anywhere.
    const seen = new Map()
    for (const c of allConcepts()) {
        for (const a of [c.key, ...c.aliases]) {
            const n = normalizeKey(a)
            assert.ok(!seen.has(n) || seen.get(n) === c.key, `alias "${a}" is claimed by both "${seen.get(n)}" and "${c.key}"`)
            seen.set(n, c.key)
        }
    }
})

// ─── content structure ────────────────────────────────────────────────────────

test('every concept has a real explanation, not a one-line definition', () => {
    for (const c of allConcepts()) {
        assert.ok(c.body.length > 300, `${c.key} is too short to be teaching anything (${c.body.length} chars)`)
    }
})

test('every concept states a COST — the beat a dictionary leaves out', () => {
    for (const c of allConcepts()) {
        assert.match(c.body, /what it costs you/i, `${c.key} never says what the trade-off is`)
    }
})

test('every concept names the mistake beginners actually make', () => {
    for (const c of allConcepts()) {
        assert.match(c.body, /beginner mistake|mistake is/i, `${c.key} never names the common mistake`)
    }
})

test('the set covers what the app puts in front of someone at the confirm moment', () => {
    // These terms appear in the cards and dialogs a user meets before approving an order. If one
    // is dropped from the set, the moment it explains stops being explainable.
    for (const must of ['stop', 'risk', 'position-size', 'fill', 'invalidation', 'conviction']) {
        assert.ok(getConcept(must), `no authored explanation for "${must}"`)
    }
})

test('the authoring rule against prescribing is stated in the file itself', () => {
    // Whoever edits this next needs to meet the rule before they meet the entries.
    assert.match(SOURCE, /DESCRIBE, NEVER PRESCRIBE/)
})

test('no concept tells the reader what their own number should be', () => {
    // The education/advice line, enforced on the content. A convention may be NAMED
    // ("many traders risk 1–2%"), but never issued as an instruction to this reader.
    for (const c of allConcepts()) {
        assert.doesNotMatch(c.body, /\byou should (?:risk|use|set|place|buy|sell)\b/i, c.key)
        assert.doesNotMatch(c.body, /\bI recommend\b/i, c.key)
    }
})
