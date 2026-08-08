import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { makeConceptHandlers, CONCEPT_TOOL_SPEC, fallbackFor } from '../../services/tools/concepts.tools.js'
import { getConcept, listConcepts } from '../../services/concepts.service.js'
import { isToolError } from '../../services/toolResult.util.js'
import { TOOL_SCHEMAS } from '../../services/agentTools.registry.js'

// `explain_concept` is what makes the authored/improvised split OBSERVABLE. Called → the user read
// reviewed copy. Not called → the model's own words under the prompt's guard-rails. These tests
// pin the two halves: authored text arrives untouched, and a miss is guidance rather than a failure.

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT = readFileSync(join(__dirname, '../../prompts/axl_system_prompt.md'), 'utf8')
const handler = (deps) => makeConceptHandlers(deps).explain_concept

test('an authored concept comes back VERBATIM — the whole reason it was written', () => {
    // Paraphrasing here would quietly undo the reviewability that justified authoring the set.
    const authored = getConcept('stop').body
    return handler()({ concept: 'stop loss' }).then(out => {
        assert.equal(out, authored)
    })
})

test('a miss returns guidance, and is NOT a tool error', async () => {
    // A toolError would tell the model something broke and invite an apology. The concept set
    // covers what a beginner needs to consent safely, not the whole of trading — "wedge pattern"
    // is legitimately absent.
    const out = await handler()({ concept: 'wedge pattern' })
    assert.ok(!isToolError(out))
    assert.match(out, /No authored explanation for "wedge pattern"/)
})

test('the fallback tells the model exactly how to behave without authored text', async () => {
    const out = await handler()({ concept: 'gamma squeeze' })
    assert.match(out, /plain language/i)
    assert.match(out, /Do NOT invent specifics/)
    assert.match(out, /say so plainly/i)
    assert.match(out, /never prescribing/i, 'the advice boundary has to survive into the fallback too')
})

test('a missing or empty argument still gets a usable answer', async () => {
    assert.match(await handler()({}), /No authored explanation for "that"/)
    assert.match(await handler()({ concept: '   ' }), /No authored explanation for "that"/)
})

test('the handler returns text, never an object graph', async () => {
    for (const q of ['stop', 'wedge pattern']) {
        assert.equal(typeof await handler()({ concept: q }), 'string', q)
    }
})

test('a lookup that throws becomes a toolError the model can act on', async () => {
    const out = await handler({ lookup: () => { throw new Error('file gone') } })({ concept: 'stop' })
    assert.ok(isToolError(out))
    assert.match(JSON.stringify(out), /file gone/)
})

test('fallbackFor never leaks a raw null into the sentence', () => {
    assert.match(fallbackFor(null), /"that"/)
    assert.doesNotMatch(fallbackFor(null), /null/)
})

// ─── the description and schema the model reads ───────────────────────────────

test('the description tells the model to use the text as-is', () => {
    assert.match(CONCEPT_TOOL_SPEC.explain_concept, /AS-IS/)
})

test('the description draws the teaching/advice line explicitly', () => {
    assert.match(CONCEPT_TOOL_SPEC.explain_concept, /TEACHING, not advice/)
    assert.match(CONCEPT_TOOL_SPEC.explain_concept, /never says where the user's stop should go/)
})

test('the description does NOT interpolate the concept list', () => {
    // It would read better, but it would tie the tool's snapshot to the content file — so a copy
    // edit by whoever writes the copy would fail a test and need the fixture regenerated.
    const listed = listConcepts().join(', ')
    assert.ok(!CONCEPT_TOOL_SPEC.explain_concept.includes(listed))
    assert.equal(typeof CONCEPT_TOOL_SPEC.explain_concept, 'string', 'a static string, not a getter')
})

test('the schema takes free text — no enum to keep in step with the content', () => {
    const schema = TOOL_SCHEMAS.explain_concept
    assert.equal(schema.properties.concept.type, 'string')
    assert.equal(schema.properties.concept.enum, undefined)
    assert.deepEqual(schema.required, ['concept'])
})

// ─── the prompt has to let the answer through ─────────────────────────────────

test('the Style rules carve out an exception for teaching', () => {
    // THE failure this whole feature is one edit away from: Axl's style contract says "keep replies
    // short" and "One clear answer". Without the carve-out the model retrieves a good explanation
    // and then compresses it to a line, and the feature silently does nothing.
    assert.match(PROMPT, /Teaching is the exception to the length rule/)
})

test('the prompt tells Axl the concept tool exists and to use its wording', () => {
    assert.match(PROMPT, /explain_concept/)
    assert.match(PROMPT, /as written rather than rewriting it/i)
})

test('the prompt names the education/advice line and the no-gate rule', () => {
    assert.match(PROMPT, /Explaining is not advising/)
    assert.match(PROMPT, /Never make a lesson a toll gate/)
})

test('the prompt tells Axl to anchor an explanation to the user’s own position', () => {
    // A definition is forgettable; their own stop is not. This is what makes the reads from the
    // previous rounds earn their keep here.
    assert.match(PROMPT, /Anchor it to their own money/)
})
