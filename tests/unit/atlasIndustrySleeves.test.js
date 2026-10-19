import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { TOOLS } from '../../services/agents/portfolio.agent.service.js'

// Atlas builds on INDUSTRIES (docs/design/atlas-industry-sleeves.md, Roy 2026-10-19): a sleeve is one GICS
// sub-industry, the read is the house's industries for the mandate's book, and sector rotation is out — it is noise
// for a book, and industry-level momentum was tested and failed as an edge (2026-10-10). These pin the prompt and the
// tool list to that, so a later edit cannot quietly put the sector buckets back.

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT = fs.readFileSync(join(__dirname, '../../prompts/portfolio_system_prompt.md'), 'utf8').replace(/\r\n/g, '\n')
const section = (from, to) => PROMPT.slice(PROMPT.indexOf(from), PROMPT.indexOf(to))
const PHASE2 = section('## PHASE 2', '## PHASE 3')
const PHASE3 = section('## PHASE 3', '## PHASE 4')
const PHASE4 = section('## PHASE 4', '## PHASE 5')
const tool = (name) => TOOLS.find(t => t.name === name)

test('the read is the house\'s industries for the book — horizon picks the book, with judgment in between', () => {
    assert.match(PHASE2, /`get_house_industries` with the mandate's `book` — \*\*the candidate sleeves\*\*/)
    assert.match(PHASE2, /under\s+about a year → `swing`; a year or more → `long_term`\. In between, use judgment/)
})

test('no momentum reads: rotation is ignored, no sector-ETF trend charts', () => {
    assert.match(PHASE2, /sector rotation: \*\*ignore it\.\*\*/)
    assert.match(PHASE2, /No sector rotation, no sector-ETF trend charts, no seasonality/)
    assert.doesNotMatch(PHASE2, /NOW — what is moving|TREND — where a sector has been going/)
    assert.match(tool('get_macro_snapshot').description, /IGNORE that part/)
})

test('a sleeve is one GICS sub-industry with its code; sectors are a check, not the plan', () => {
    assert.match(PHASE3, /\*\*Sleeves — each ONE GICS sub-industry, with a weight\.\*\*/)
    assert.match(PHASE3, /carry its\s+8-digit code/)
    assert.match(PHASE3, /\*\*Sectors are a CHECK, not the plan\.\*\*/)
    assert.doesNotMatch(PHASE3, /Work in sector buckets/)
})

test('verdicts: FOR is the candidate; AVOID only on the user\'s ask; HYPE halved; an unlisted industry on an ask OR a stated reason', () => {
    assert.match(PHASE3, /\*\*Industries the house rates FOR this book\*\* are the candidates/)
    assert.match(PHASE3, /\*\*AVOID\*\* — only when the user asks for it/)
    assert.match(PHASE3, /the platform halves the weight/)
    assert.match(PHASE3, /fine when the user asks for it, and fine when you state\s+the reason for it/)
})

test('names by industry: get_coverage by `industry`, an empty sleeve sourced by its industry_code', () => {
    assert.match(PHASE4, /pass the\s+sleeve's `industry` \(its code\)/)
    assert.match(PHASE4, /GROUPED BY GICS SUB-INDUSTRY/)
    assert.match(PHASE4, /emit `<screen_request>`\*\* with\s+its `industry_code`/)
    assert.match(PROMPT, /\{ "industry_code": "45301020", "lens": "quality-value"/)
    assert.ok(tool('get_coverage').input_schema.properties.industry, 'get_coverage takes an industry')
})

test('Atlas has the house\'s industry list, in its own words', () => {
    assert.match(tool('get_house_industries').description, /THESE ARE THE CANDIDATE SLEEVES/)
    assert.doesNotMatch(tool('get_house_industries').description, /screen the rest of the market/)
})
