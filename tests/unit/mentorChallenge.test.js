import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { ENTRY_ARCHETYPES, STOP_ANCHORS, TARGET_ANCHORS, SIBLINGS } from '../../services/setup.taxonomy.js'
import { ON_AWAY, CHALLENGE_VERDICTS } from '../../services/setup.schema.js'

// THE PROSE MIRROR (Phase 2 of docs/design/mentor-challenge.md).
//
// The taxonomy lives in code and the model reads it in prose, which is one vocabulary kept in two
// files. The failure is silent and total: an id added to `setup.taxonomy.js` that the prompt never
// mentions is an id the model cannot file, and one written in the prompt that the code does not hold
// is normalised to null — the model files it every turn, the document never carries it, and nothing
// anywhere says so. Same shape as promptToolDrift.test.js, for the same reason.

const PROMPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../prompts/mentor_system_prompt.md'), 'utf8')

test('every archetype and anchor in the code is a word the prompt teaches', () => {
    for (const id of [...ENTRY_ARCHETYPES, ...STOP_ANCHORS, ...TARGET_ANCHORS]) {
        assert.match(PROMPT, new RegExp(`\`${id}\``), `the prompt never names \`${id}\``)
    }
})

test('the prompt invents no archetype the schema would drop', () => {
    // Backticked snake_case words in the archetype's own section. A word the prompt teaches and the
    // code does not hold normalises to null on every turn, silently.
    const section = PROMPT.split('### Name the way in, and what each level is measured from')[1]?.split('\n### ')[0] ?? ''
    assert.ok(section.length > 500, 'the taxonomy section is missing from the prompt')

    const known = new Set([...ENTRY_ARCHETYPES, ...STOP_ANCHORS, ...TARGET_ANCHORS, 'archetype', 'anchor', 'trade_mode'])
    const named = [...new Set([...section.matchAll(/`([a-z][a-z_]{3,})`/g)].map(m => m[1]))]
    for (const word of named) assert.ok(known.has(word), `the prompt teaches \`${word}\`, which the code does not hold`)
})

test('the prompt carries the away-edge vocabulary and no more of it', () => {
    const section = PROMPT.split('### `on_away`')[1]?.split('\n## ')[0] ?? ''
    assert.ok(section.length > 400, 'the on_away section is missing')
    for (const v of ON_AWAY) assert.match(section, new RegExp(`\`${v}\``), `the prompt never offers \`${v}\``)
    // `close` and `notify_only` belong to the ADVERSE edge; offering them here would have the model
    // author a value the normaliser drops, and a runaway that reads as "let it die quietly".
    for (const wrong of ['`close`', '`notify_only`', '`continuation`', '`mandate`']) {
        assert.ok(!section.includes(wrong), `the away edge must not offer ${wrong}`)
    }
})

test('the gate the prompt claims matches the gate the code runs', () => {
    // "Ready to Generate" mirrors setupReadiness by hand, so the two can disagree the moment one
    // changes. The runaway answer is the newest requirement and the easiest to forget here.
    const gate = PROMPT.split('## Ready to Generate')[1]?.split('\n## ')[0] ?? ''
    assert.match(gate, /`on_away`/, 'the readiness list does not mention the runaway answer')
})

test('the runaway arrival tells the model not to inherit the old numbers', () => {
    const section = PROMPT.split('### Arriving from a runaway')[1]?.split('\n## ')[0] ?? ''
    assert.ok(section.length > 800, 'the runaway arrival section is missing')

    // The four load-bearing instructions. Each one is a specific way a redraw goes wrong: a level
    // quoted from the dead conversation, a cascade nobody asked for, an inherited target that turns a
    // missed trade into a bad one, and a floor lowered because the user is frustrated.
    assert.match(section, /get_quote/,                    'it must re-measure before it speaks')
    assert.match(section, /do NOT reopen|does not (move|reopen)/i)
    assert.match(section, /Re-derive the size and re-derive the targets/)
    assert.match(section, /1R floor does not move because they missed the trade/)
})

test('the runaway arrival gets the sibling map right', () => {
    const section = PROMPT.split('### Arriving from a runaway')[1]?.split('\n## ')[0] ?? ''
    // Prose against `SIBLINGS`: a prompt that offered a continuation where the code says there is
    // none would walk the user into a reversal wearing the missed trade's label.
    for (const [from, to] of Object.entries(SIBLINGS)) {
        if (!to) continue
        const pair = new RegExp(`\`${from}\`[^\\n]*\`${to}\``)
        assert.match(section, pair, `the prompt does not point \`${from}\` at \`${to}\``)
    }
    assert.match(section, /`fade`[^.]*no\*\*? ?\*?\*?\s*continuation/i, 'a fade must be named as having none')
})

test('the flip section teaches all three verdicts, and the asymmetry between them', () => {
    const section = PROMPT.split('## The flip test')[1]?.split('\n## ')[0] ?? ''
    assert.ok(section.length > 800, 'the flip test section is missing')

    for (const v of CHALLENGE_VERDICTS) assert.match(section, new RegExp(`\`${v}\``), `the prompt never explains \`${v}\``)

    // BAD NEWS MOVES THE NUMBER, GOOD NEWS MOVES THE WORDS. If surviving raised conviction, the score
    // would measure how many times the pass was run — which is worse than not having the number.
    assert.match(section, /Do not raise the score/i)
    assert.match(section, /score DOWN/,  'two_sided is the one verdict that moves it')
    assert.match(section, /void/,        'reversed voids everything under the direction')

    // The model must not author its own verdict; the server is the only writer (flipTest.service.js).
    assert.match(section, /do not author `challenges`/i)

    // It never saw macro or news, so it must not be allowed to overrule a dated catalyst.
    assert.match(section, /macro, news, catalysts/)
})

test('the rejects pool is taught as empty on the path that brought its own plan', () => {
    const section = PROMPT.split('### `alternatives[]`')[1]?.split('\n## ')[0] ?? ''
    assert.ok(section.length > 600, 'the alternatives section is missing')
    assert.match(section, /EMPTY/,                 'the interview carve-out is the rule most likely to be lost')
    assert.match(section, /reason|why_not/,        'a reject without a reason is dropped — the prompt must say so')
    assert.match(section, /once/i,                 'authored once and carried forward, or it costs on every re-emit')
})

test('the worksheet example carries the fields the model is meant to copy', () => {
    // The example IS the instruction for most turns. A field taught in prose and absent from the
    // block is a field that never gets emitted.
    // The tag is named in prose several times before the example appears, so take the first
    // <setup>…</setup> pair that actually holds a document rather than the first mention.
    const block = [...PROMPT.matchAll(/<setup>([\s\S]*?)<\/setup>/g)].map(m => m[1]).find(b => b.includes('"asset"')) ?? ''
    assert.ok(block.length > 500, 'the worksheet example is missing')
    for (const field of ['"archetype"', '"anchor"', '"alternatives"', '"on_away"']) {
        assert.ok(block.includes(field), `the example never shows ${field}`)
    }
    // And every taxonomy value the example uses has to be real, or it teaches a word that is dropped.
    for (const m of block.matchAll(/"archetype":\s*"([a-z_]+)"/g)) assert.ok(ENTRY_ARCHETYPES.includes(m[1]), m[1])
    for (const m of block.matchAll(/"on_away":\s*"([a-z_]+)"/g))   assert.ok(ON_AWAY.includes(m[1]), m[1])
})
