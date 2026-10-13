import { test } from 'node:test'
import assert from 'node:assert/strict'

import { houseIndustriesFor, industryAssessmentService, _setAssessmentIO, BOOKS } from '../../api/strategy/industryAssessment.service.js'
import { memDb } from '../helpers/memDb.js'

// The house's industries for a book (docs/design/argus-on-pythia.md §3.1): where Argus and the sleeve screen look
// FIRST. A preference read — these tests pin what is listed, what is left out, and the order.

const NOW = '2026-10-13T12:00:00.000Z'
const LATER = '2026-11-30T00:00:00.000Z'
const EARLIER = '2026-10-01T00:00:00.000Z'

const IND = (code, name, sector, verdict, over = {}) => ({
    id: `ia_ind_${code}`, subject: { kind: 'industry', code, name, sector }, verdict, horizon: verdict === 'long_term' ? 'years' : 'weeks',
    thesis: `${name} thesis`, risks: [`${name} risk`, 'second risk'], second_order: `${name} reaches its suppliers`, expires_at: LATER, moved: { hype: false, excess_12m: 0.1 }, ...over,
})
const THEME_ROW = (id, verdict, over = {}) => ({
    id: `ia_${id}`, subject: { kind: 'theme', id, name: id, sector: null }, verdict, horizon: 'months', thesis: `${id} theme thesis`,
    risks: ['theme risk'], second_order: `${id} reaches the grid`, expires_at: LATER, moved: { kind: 'theme', hype: false, links: [] }, ...over,
})
const THEME = (id, links, status = 'approved') => ({ id, name: id, status, links })
const LINK = (code, name, sector, order) => ({ code, name, sector, order })

const SEMIS = IND('45301020', 'Semiconductors', 'Information Technology', 'swing', { moved: { hype: true, excess_12m: 0.5 } })
const SOFT  = IND('45103010', 'Application Software', 'Information Technology', 'long_term')
const BANKS = IND('40101015', 'Regional Banks', 'Financials', 'swing', { moved: { hype: false, excess_12m: 0.2 } })
const COAL  = IND('10102050', 'Coal & Consumable Fuels', 'Energy', 'avoid')

test('the books are swing and long term — watch is not a book', () => {
    assert.deepEqual([...BOOKS], ['swing', 'long_term'])
    assert.deepEqual(houseIndustriesFor([IND('1', 'X', 'S', 'watch')], [], { book: 'watch', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor([SEMIS], [], { book: 'intraday', now: NOW }), [], 'no book for a session trade')
})

test("an industry rated the book is listed with its own thesis, horizon, top risk and hype; others are not", () => {
    const out = houseIndustriesFor([SEMIS, SOFT, BANKS, COAL], [], { book: 'swing', now: NOW })
    assert.deepEqual(out.map(e => e.code), ['45301020', '40101015'], 'biggest 12-month move first')
    const s = out[0]
    assert.equal(s.rated, true)
    assert.equal(s.thesis, 'Semiconductors thesis')
    assert.equal(s.top_risk, 'Semiconductors risk')
    assert.equal(s.horizon, 'weeks')
    assert.equal(s.hype, true)
    assert.equal(s.avoid, false)
    assert.deepEqual(s.themes, [])
    assert.deepEqual(houseIndustriesFor([SEMIS, SOFT, BANKS, COAL], [], { book: 'long_term', now: NOW }).map(e => e.code), ['45103010'])
})

test('an expired verdict never surfaces', () => {
    const stale = { ...SEMIS, expires_at: EARLIER }
    assert.deepEqual(houseIndustriesFor([stale, BANKS], [], { book: 'swing', now: NOW }).map(e => e.code), ['40101015'])
})

test("the old verdict words read as today's", () => {
    const old = IND('20106010', 'Industrial Machinery', 'Industrials', 'interesting_invest')
    assert.deepEqual(houseIndustriesFor([old], [], { book: 'long_term', now: NOW }).map(e => e.code), ['20106010'])
})

test('sector narrows, case-insensitively', () => {
    assert.deepEqual(houseIndustriesFor([SEMIS, BANKS], [], { book: 'swing', sector: 'financials', now: NOW }).map(e => e.code), ['40101015'])
})

test("a theme rated the book brings its direct and supplier links — not the suppliers' suppliers", () => {
    const theme = THEME('ai_power', [
        LINK('55105010', 'Independent Power Producers', 'Utilities', 1),
        LINK('20104010', 'Electrical Components', 'Industrials', 2),
        LINK('15104020', 'Copper', 'Materials', 3),
    ])
    const row = THEME_ROW('ai_power', 'swing', { moved: { kind: 'theme', hype: false, links: [
        { code: '55105010', excess_12m: 0.4, hype: true }, { code: '20104010', excess_12m: 0.3 },
    ] } })
    const out = houseIndustriesFor([row], [theme], { book: 'swing', now: NOW })
    assert.deepEqual(out.map(e => e.code), ['55105010', '20104010'])
    const ipp = out[0]
    assert.equal(ipp.rated, false, 'not rated on its own — it came through the theme')
    assert.equal(ipp.thesis, null)
    assert.equal(ipp.hype, true, "the link's own hype flag")
    assert.equal(ipp.excess_12m, 0.4)
    assert.deepEqual(ipp.themes, [{ id: 'ai_power', name: 'ai_power', order: 1, horizon: 'months', thesis: 'ai_power theme thesis', second_order: 'ai_power reaches the grid', names: [] }])
    assert.equal(ipp.second_order, null, 'not rated on its own: no second-order read of its own')
})

test('an industry rated on its own AND through a theme is one entry carrying both', () => {
    const theme = THEME('ai', [LINK('45301020', 'Semiconductors', 'Information Technology', 1), LINK('45103010', 'Application Software', 'Information Technology', 1)])
    const out = houseIndustriesFor([SEMIS, THEME_ROW('ai', 'swing')], [theme], { book: 'swing', now: NOW })
    const semis = out.filter(e => e.code === '45301020')
    assert.equal(semis.length, 1)
    assert.equal(semis[0].rated, true)
    assert.equal(semis[0].thesis, 'Semiconductors thesis')
    assert.equal(semis[0].themes.length, 1)
    // Software is rated long term on its own, swing through the theme: listed for swing, from the theme only.
    const soft = out.find(e => e.code === '45103010')
    assert.equal(soft.rated, false)
    assert.equal(soft.horizon, null)
})

test('an industry the house rates AVOID can arrive through a theme — listed, marked', () => {
    const theme = THEME('power', [LINK('10102050', 'Coal & Consumable Fuels', 'Energy', 2), LINK('55105010', 'Independent Power Producers', 'Utilities', 1)])
    const coal = houseIndustriesFor([COAL, THEME_ROW('power', 'long_term')], [theme], { book: 'long_term', now: NOW }).find(e => e.code === '10102050')
    assert.equal(coal.avoid, true)
})

test('a retired theme, an unapproved one, or an expired theme verdict brings nothing', () => {
    const links = [LINK('55105010', 'Independent Power Producers', 'Utilities', 1)]
    assert.deepEqual(houseIndustriesFor([THEME_ROW('t', 'swing')], [THEME('t', links, 'retired')], { book: 'swing', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor([THEME_ROW('t', 'swing')], [THEME('t', links, 'proposed')], { book: 'swing', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor([THEME_ROW('t', 'swing', { expires_at: EARLIER })], [THEME('t', links)], { book: 'swing', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor([THEME_ROW('t', 'swing')], [], { book: 'swing', now: NOW }), [], 'theme not in the approved list')
})

test("a theme's links are narrowed to the sector too", () => {
    const theme = THEME('ai_power', [LINK('55105010', 'Independent Power Producers', 'Utilities', 1), LINK('20104010', 'Electrical Components', 'Industrials', 2)])
    const out = houseIndustriesFor([THEME_ROW('ai_power', 'swing')], [theme], { book: 'swing', sector: 'Industrials', now: NOW })
    assert.deepEqual(out.map(e => e.code), ['20104010'])
})

test('no move sorts last; ties by name', () => {
    const a = IND('1', 'Beta', 'S', 'swing', { moved: {} })
    const b = IND('2', 'Alpha', 'S', 'swing', { moved: {} })
    const c = IND('3', 'Gamma', 'S', 'swing', { moved: { excess_12m: -0.3 } })
    assert.deepEqual(houseIndustriesFor([a, b, c], [], { book: 'swing', now: NOW }).map(e => e.name), ['Gamma', 'Alpha', 'Beta'])
})

test('empty input is an empty list', () => {
    assert.deepEqual(houseIndustriesFor([], [], { book: 'swing', now: NOW }), [])
    assert.deepEqual(houseIndustriesFor(null, null, { book: 'swing', now: NOW }), [])
})

test('listForBook reads the stored assessments and the approved themes', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    for (const r of [SEMIS, SOFT, BANKS, THEME_ROW('ai_power', 'swing')]) await m.db.collection('industry_assessment').insertOne(structuredClone(r))
    const themes = async () => [THEME('ai_power', [LINK('20104010', 'Electrical Components', 'Industrials', 2)])]
    const out = await industryAssessmentService.listForBook('swing', { now: NOW }, { themes })
    assert.deepEqual(out.map(e => e.code), ['45301020', '40101015', '20104010'])
    assert.deepEqual(await industryAssessmentService.listForBook('long_term', { sector: 'Information Technology', now: NOW }, { themes }).then(o => o.map(e => e.code)), ['45103010'])
    assert.deepEqual(await industryAssessmentService.listForBook('watch', { now: NOW }, { themes }), [])
})

// ── the tool Argus reads (argus-on-pythia.md §3.2) ───────────────────────────

import { makeHouseIndustriesHandlers, normalizeBook, formatHouseIndustries, formatIndustryCompanies } from '../../services/tools/houseIndustries.tools.js'
import { TOOLS as SCANNER_TOOLS, scannerToolsForProfile, _wrapForGrounding } from '../../services/agents/scanner.agent.service.js'
import { DISCOVERY_TOOLS, makeGroundingLedger, groundingTier } from '../../services/scanner.grounding.js'

const ENTRY = (over = {}) => ({
    code: '45301020', name: 'Semiconductors', sector: 'Information Technology', rated: true, horizon: 'weeks', hype: false,
    thesis: 'AI capex still rising', top_risk: 'a capex pause', avoid: false, excess_12m: 0.42, themes: [], ...over,
})
const SUB = { code: '45301020', name: 'Semiconductors', sector: 'Information Technology' }

test('the book words: swing, long_term and its spellings; nothing else', () => {
    for (const s of ['swing', 'SWING', ' swing ']) assert.equal(normalizeBook(s), 'swing')
    for (const s of ['long_term', 'long term', 'Long-Term']) assert.equal(normalizeBook(s), 'long_term')
    for (const s of ['intraday', 'day', 'watch', '', null, undefined]) assert.equal(normalizeBook(s), null)
})

test('the list reads as a preference: thesis, risk, flags, themes, and the rule', () => {
    const text = formatHouseIndustries('swing', [
        ENTRY({ hype: true }),
        ENTRY({ code: '10102050', name: 'Coal & Consumable Fuels', sector: 'Energy', rated: false, thesis: null, top_risk: null, avoid: true, excess_12m: null,
            themes: [{ id: 'power', name: 'Power', order: 2, thesis: 'grid demand', horizon: 'months' }] }),
    ])
    assert.match(text, /THE HOUSE'S SWING INDUSTRIES/)
    assert.match(text, /45301020 {2}Semiconductors \[Information Technology\] · HYPE/)
    assert.match(text, /12 months \+42% over SPY/)
    assert.match(text, /thesis \(weeks\): AI capex still rising/)
    assert.match(text, /top risk: a capex pause/)
    assert.match(text, /AVOID — it is here only through a theme/)
    assert.match(text, /via theme "Power" \(supplier link\): grid demand/)
    assert.match(text, /A preference, not a filter/)
    assert.match(text, /on the house's swing list/)
    assert.doesNotMatch(text.split('Coal')[1].split('via theme')[0], /thesis/, 'a theme-only entry shows no thesis of its own')
    assert.match(formatHouseIndustries('long_term', [ENTRY()]), /on the house's long-term list/)
})

test('an empty list says so and sends Argus to scan normally', () => {
    const text = formatHouseIndustries('long_term', [], { sector: 'Utilities' })
    assert.match(text, /no industries rated for long-term in Utilities/)
    assert.match(text, /Scan the market as you normally would/)
})

test("an industry's companies: verdict, coverage, and a note when its parent answers for it", () => {
    const rows = [{ symbol: 'NVDA', name: 'NVIDIA', market_cap: 4e12, sub_industry: 'Semiconductors' }, { symbol: 'AMAT', name: 'Applied', market_cap: 2e11, sub_industry: 'Semiconductor Materials & Equipment' }]
    const text = formatIndustryCompanies(SUB, rows, new Set(['NVDA']), { verdict: 'swing', hype: true })
    assert.match(text, /the house's verdict: For swing · HYPE/)
    assert.match(text, /NVDA .*\[OUR COVERAGE\]/)
    assert.match(text, /Too few Semiconductors companies of its own/)
    assert.doesNotMatch(formatIndustryCompanies(SUB, rows.slice(0, 1), new Set(), null), /Too few/)
    assert.match(formatIndustryCompanies(SUB, [], new Set(), null), /not assessed/)
})

test('the handler: book → list (sector passed through), industry → companies, and every wrong input answered', async () => {
    const asked = []
    const h = makeHouseIndustriesHandlers({
        forBook: async (book, opts) => { asked.push([book, opts]); return [ENTRY()] },
        readSub: async (k) => (k === 'Semiconductors' || k === '45301020' ? { sub: SUB } : null),
        largest: async (_sub, limit) => [{ symbol: 'NVDA', name: 'NVIDIA', market_cap: 4e12, sub_industry: 'Semiconductors', limit }],
        covered: async () => new Set(),
        verdicts: async () => new Map([['45301020', { verdict: 'swing' }]]),
        assessment: async () => null,
    }).get_house_industries
    assert.match(await h({ book: 'long term', sector: 'Information Technology' }), /LONG-TERM INDUSTRIES in Information Technology/)
    assert.deepEqual(asked, [['long_term', { sector: 'Information Technology' }]])
    assert.match(await h({ industry: 'Semiconductors' }), /NVDA/)
    assert.match(await h({ industry: 'Nope' }), /No GICS sub-industry "Nope"/)
    assert.match(await h({ book: 'intraday' }), /no list for "intraday"/)
    assert.match(await h({}), /Pass `book`/)
})

test('a failed read answers in text and tells Argus to scan normally', async () => {
    const h = makeHouseIndustriesHandlers({ forBook: async () => { throw new Error('db down') } }).get_house_industries
    const out = await h({ book: 'swing' })
    assert.match(typeof out === 'string' ? out : JSON.stringify(out), /db down.*scan the market as you normally would/)
})

test('Argus has the tool in both profiles, before consult; it is a discovery source', () => {
    const names = SCANNER_TOOLS.map(t => t.name)
    assert.ok(names.includes('get_house_industries'))
    assert.equal(names.at(-1), 'consult')
    assert.ok(scannerToolsForProfile('investing').some(t => t.name === 'get_house_industries'))
    assert.ok(DISCOVERY_TOOLS.has('get_house_industries'))
})

test("a company the tool listed is grounded as sourced", async () => {
    const ledger = makeGroundingLedger()
    const wrapped = _wrapForGrounding({ get_house_industries: async () => formatIndustryCompanies(SUB, [{ symbol: 'NVDA', name: 'NVIDIA', market_cap: 4e12 }], new Set()) }, ledger)
    await wrapped.get_house_industries({ industry: 'Semiconductors' })
    assert.equal(groundingTier('NVDA', ledger), 'sourced')
    assert.equal(groundingTier('AMD', ledger), 'ungrounded')
})

test("the book list's prose grounds nothing — only an industry call's company rows do (bug hunt 2026-10-13)", async () => {
    const ledger = makeGroundingLedger()
    const list = formatHouseIndustries('swing', [ENTRY({ thesis: 'AI capex and ROIC above the hurdle; SPY lagging' })])
    const wrapped = _wrapForGrounding({ get_house_industries: async (a) => (a.book ? list : formatIndustryCompanies(SUB, [{ symbol: 'BRK.B', name: 'AI Holdings', market_cap: 1e9 }], new Set())) }, ledger)
    await wrapped.get_house_industries({ book: 'swing' })
    for (const t of ['AI', 'ROIC', 'SPY', 'HYPE', 'THE']) assert.equal(groundingTier(t, ledger), 'ungrounded', t)
    await wrapped.get_house_industries({ industry: 'Semiconductors' })
    assert.equal(groundingTier('BRK.B', ledger), 'sourced')
    assert.equal(groundingTier('AI', ledger), 'ungrounded', 'a company NAME is not a ticker')
})

test('a long list shows the first twenty in full and the rest by name', () => {
    const many = Array.from({ length: 23 }, (_, i) => ENTRY({ code: String(10000000 + i), name: `Industry ${i}`, hype: i === 22 }))
    const text = formatHouseIndustries('swing', many)
    assert.equal((text.match(/thesis \(/g) ?? []).length, 20)
    assert.match(text, /3 more, names only .*Industry 20 \(10000020\), Industry 21 \(10000021\), Industry 22 \(10000022\) HYPE/)
    assert.doesNotMatch(formatHouseIndustries('swing', many.slice(0, 20)), /more, names only/)
})

test("the sector matches in either spelling — a sleeve's sector is model text (step 4)", () => {
    for (const sector of ['Technology', 'information technology', 'Information Technology', 'tech']) {
        assert.deepEqual(houseIndustriesFor([SEMIS, BANKS], [], { book: 'swing', sector, now: NOW }).map(e => e.code), ['45301020'], sector)
    }
    assert.deepEqual(houseIndustriesFor([SEMIS, BANKS], [], { book: 'swing', sector: 'Financial Services', now: NOW }).map(e => e.code), ['40101015'])
})

test('a six-character ticker in an industry call is grounded too (code review 2026-10-13)', async () => {
    const ledger = makeGroundingLedger()
    const rows = [{ symbol: 'GOOGL', name: 'Alphabet', market_cap: 2e12 }, { symbol: 'ABCDEF', name: 'Six Letters', market_cap: 1e9 }, { symbol: 'BRK-B', name: 'Berkshire', market_cap: 1e12 }]
    const wrapped = _wrapForGrounding({ get_house_industries: async () => formatIndustryCompanies(SUB, rows, new Set(['GOOGL'])) }, ledger)
    await wrapped.get_house_industries({ industry: 'Semiconductors' })
    for (const t of ['GOOGL', 'ABCDEF', 'BRK-B']) assert.equal(groundingTier(t, ledger), 'sourced', t)
    for (const t of ['L', 'T', 'E']) assert.equal(groundingTier(t, ledger), 'ungrounded', `"${t}" from the prose lines`)
})

test('listForBooks reads once and answers every book asked (code review 2026-10-13)', async () => {
    const m = memDb()
    _setAssessmentIO({ db: async () => m.db })
    for (const r of [SEMIS, SOFT, BANKS]) await m.db.collection('industry_assessment').insertOne(structuredClone(r))
    let themeReads = 0
    const themes = async () => { themeReads++; return [] }
    const out = await industryAssessmentService.listForBooks(['swing', 'long_term', 'watch'], { now: NOW }, { themes })
    assert.deepEqual(Object.keys(out), ['swing', 'long_term'])
    assert.deepEqual(out.swing.map(e => e.code), ['45301020', '40101015'])
    assert.deepEqual(out.long_term.map(e => e.code), ['45103010'])
    assert.equal(themeReads, 1)
    assert.deepEqual(await industryAssessmentService.listForBooks([], { now: NOW }, { themes }), {})
})

test("the second-order read rides beside the first, clipped, neither preferred (Roy, 2026-10-13)", () => {
    const own = houseIndustriesFor([SEMIS], [], { book: 'swing', now: NOW })[0]
    assert.equal(own.second_order, 'Semiconductors reaches its suppliers')
    const long = 'x'.repeat(600)
    const text = formatHouseIndustries('swing', [ENTRY({ second_order: long, themes: [{ id: 't', name: 'Power', order: 2, thesis: 'grid', second_order: 'utilities next' }] })])
    assert.match(text, /who else it reaches: x{200,}…/)
    assert.doesNotMatch(text, /x{300}/, 'clipped')
    assert.match(text, /via theme "Power" \(supplier link\): grid\n {8}who else the theme reaches: utilities next/)
    assert.match(text, /neither preferred/)
    assert.doesNotMatch(formatHouseIndustries('swing', [ENTRY({ second_order: null })]), /who else it reaches/)
})
