// A condition is read for DAYS after it is written, so it may not contain a relative date.
//   node --test tests/unit/mentorDatedConditions.test.js
//
// The failure this guards is silent and slow. Mentor files the user's own words — that is the whole
// point of the interview — and "a false break yesterday on last week's low" is a perfectly good
// sentence the afternoon it is said. Talos then reads it on every candle close: on Thursday
// "yesterday" is Wednesday and "last week" is a different week, so a LATCHING precondition that did
// not settle on the first look quietly starts asking a different question than the user answered.
// Nothing reports it, because the sentence is still grammatical and the monitor still grades it.
//
// Mentor knows the date — `_buildSystemPrompt` has put CURRENT DATE in the turn context for a year.
// It was simply never told the rule applied to a condition's TEXT, only to active_from / valid_until.
//
// Both halves are tested because either alone is a no-op: the standing rule in the prompt file, and
// the per-turn line that carries the actual date.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '../../')
const PROMPT = readFileSync(join(ROOT, 'prompts/mentor_system_prompt.md'), 'utf8')
const AGENT  = readFileSync(join(ROOT, 'services/agents/mentor.agent.service.js'), 'utf8')

test('the checkability gate covers relative dates, not only vague tests', () => {
    // It lives with "every condition must be checkable" on purpose: a sentence whose meaning moves
    // with the calendar is unfalsifiable in the same way "if the Fed pivots" is, just later.
    const gate = PROMPT.slice(PROMPT.indexOf('YOUR GATE: every condition must be checkable'))
    assert.ok(gate.length, 'the gate section must exist for this rule to hang on')
    assert.match(gate, /relative date is not checkable/i)
    assert.match(gate, /resolve it as you file it/i)
})

test('the rule names the shape it is fixing, so it cannot be read as being about valid_until', () => {
    assert.match(PROMPT, /yesterday[\s\S]{0,60}last week/i, 'the example is the sentence that prompted it')
    assert.match(PROMPT, /this morning|since the open|after earnings/i, 'and it generalises past one phrasing')
})

test('the date is never asked for — the user already said it', () => {
    // The interview's standing rule is "re-asking something they already said is the fastest way to
    // look like you were not listening". A clarifying question here would be exactly that.
    const gate = PROMPT.slice(PROMPT.indexOf('relative date is not checkable'))
    assert.match(gate.slice(0, 700), /never ask them which day/i)
})

test('CURRENT DATE carries the rule to the turn that has the actual date', () => {
    // The standing rule in the prompt file cannot resolve anything on its own: the date arrives
    // per turn, in the volatile block. This line is where the two meet.
    const line = AGENT.split('\n').find(l => l.includes('CURRENT DATE:'))
    assert.ok(line, 'the turn context must still carry CURRENT DATE')
    assert.match(line, /active_from \/ valid_until/, 'the original scope stays')
    assert.match(line, /condition/i, 'and now reaches a condition\'s text')
})
