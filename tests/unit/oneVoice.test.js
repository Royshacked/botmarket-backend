import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { INTERNAL_NAMES, VOICE_RULE } from '../../services/agentUtils.js'
import { buildRouteRule, RECEPTION_RULE } from '../../services/routing.util.js'
import { DESKS } from '../../services/desks/registry.js'
import { TOOLS as PORTFOLIO_TOOLS } from '../../services/agents/portfolio.agent.service.js'
import { TOOLS as SCANNER_TOOLS } from '../../services/agents/scanner.agent.service.js'
import { TOOLS as ANALYST_TOOLS } from '../../services/agents/analyst.agent.service.js'
import { TOOLS as AXL_TOOLS } from '../../services/agents/axl.agent.service.js'
import { TOOLS as AETHER_TOOLS } from '../../services/agents/aether.agent.service.js'
import { TOOLS as STRATEGY_TOOLS } from '../../services/agents/strategy.agent.service.js'
import { MENTOR_TOOLS } from '../../services/agents/mentor.agent.service.js'
import { TOOLS as PROTEUS_TOOLS } from '../../services/agents/proteus.agent.service.js'
import { SYSTEM as BOOK_TIMING_SYSTEM } from '../../services/bookTiming.service.js'
import { SYSTEM as HOTLIST_ARGUS_SYSTEM } from '../../services/hotlist.argus.js'
import { SYSTEM as HOUSE_SCAN_SYSTEM } from '../../services/houseScan.argus.js'

// ONE VOICE (docs/design/one-axl.md, 2026-11-13): the user meets one assistant, Axl, and sees each desk as a role under
// his name. An internal name in anything a model reads becomes a name in a reply — so none may be there. The names live
// in code, logs and docs only (and in VOICE_RULE, which has to name what it forbids).

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const NAME_RE = new RegExp(`\\b(${INTERNAL_NAMES.join('|')})\\b`)
const clean = (text, where) => {
    const m = String(text).match(NAME_RE)
    assert.equal(m, null, `${where} says "${m?.[1]}": ...${m ? String(text).slice(Math.max(0, m.index - 60), m.index + 40) : ''}...`)
}

test('no prompt file names an internal agent', () => {
    const dir = join(root, 'prompts')
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) clean(fs.readFileSync(join(dir, f), 'utf8'), `prompts/${f}`)
})

test('every desk\'s route rule lists roles, and the hand-back rule names no one', () => {
    for (const agent of Object.keys(DESKS).filter(a => a !== 'axl')) clean(buildRouteRule(agent), `buildRouteRule('${agent}')`)
    clean(RECEPTION_RULE, 'RECEPTION_RULE')
    assert.match(buildRouteRule('mentor'), /\*\*the analyst\*\* \(`research`\)/)
})

test('no tool a chat agent is given names an internal agent', () => {
    const LIVE = { portfolio: PORTFOLIO_TOOLS, scanner: SCANNER_TOOLS, analyst: ANALYST_TOOLS, axl: AXL_TOOLS, aether: AETHER_TOOLS,
        strategy: STRATEGY_TOOLS, mentor: MENTOR_TOOLS, proteus: PROTEUS_TOOLS }
    for (const [agent, tools] of Object.entries(LIVE)) {
        for (const t of tools) clean(JSON.stringify({ d: t.description, s: t.input_schema }), `${agent}.${t.name}`)
    }
})

test('the house\'s background reads name no one either — their words reach the boards', () => {
    clean(BOOK_TIMING_SYSTEM, 'bookTiming.SYSTEM')
    clean(HOTLIST_ARGUS_SYSTEM, 'hotlist.argus.SYSTEM')
    clean(HOUSE_SCAN_SYSTEM, 'houseScan.argus.SYSTEM')
})

test('every chat agent carries the voice rule in its cached spine, right after the language rule', () => {
    const dir = join(root, 'services/agents')
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.agent.service.js'))) {
        const src = fs.readFileSync(join(dir, f), 'utf8')
        assert.equal((src.match(/\+ LANGUAGE_RULE \+ VOICE_RULE \+/g) ?? []).length, 1, `${f} carries VOICE_RULE once, after LANGUAGE_RULE`)
    }
})

test('the voice rule: one assistant called Axl, speaking as "I", owning a view that differs', () => {
    assert.match(VOICE_RULE, /you are Axl/)
    assert.match(VOICE_RULE, /Speak as "I"/)
    for (const n of INTERNAL_NAMES) assert.ok(VOICE_RULE.includes(n), `the rule forbids ${n} by name`)
    assert.match(VOICE_RULE, /own yours out loud/)
})

test('every desk has a role, and only Axl has none', () => {
    for (const [agent, d] of Object.entries(DESKS)) {
        if (agent === 'axl') assert.equal(d.role, null)
        else assert.match(d.role, /^[a-z ]+$/, `${agent} has a lower-case role`)
    }
})
