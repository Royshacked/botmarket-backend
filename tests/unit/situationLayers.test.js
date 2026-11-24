import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sectorOf, isLayer, layerOf, layerName, SECTORS, SECTOR_CAP, SECTORS_TOTAL_CAP } from '../../services/situation/sectors.js'
import { checkNode, checkSectorState, checkForecast, checkIndustry, checkDropped } from '../../services/situation/model.js'
import { checkBundle } from '../../services/situation/store.js'
import { holdCaps, capOut, promote, anchorLinks, withMacroScores, buildSectorLayer, _setIO as setLayersIO } from '../../services/situation/layers.js'
import { settle, mapByLayer, buildSectors, buildFull, _setIO as setBuildIO } from '../../services/situation/build.js'
import { macroBackdrop, sectorPriceItems, sectorSchema, sectorPrompt, buildSectorState, _setIO as setSectorIO } from '../../services/situation/sectorState.js'
import { fetchSectorNews, _setIO as setNewsIO } from '../../services/situation/news.js'
import { runUpdate, applyAnswer, numbered, _setIO as setUpdateIO } from '../../services/situation/update.js'
import { dueKind, eventLayers, triageSchema, tick, _setIO as setWatchIO, WATCH } from '../../services/situation/watch.js'
import { COLLECTIONS } from '../../services/situation/store.js'
import { anchorFor } from '../../services/situation/propagate.js'
import { cardLines } from '../../services/situation/review.js'
import { formatSummary } from '../../services/tools/situation.tools.js'

// The missing-outcomes review never reaches the model from a test.
setUpdateIO({ outcomes: async () => ({ ok: true, data: { changes: [] }, list: [], cost_usd: 0 }) })

const node = (node_id, opts, over = {}) => ({
    node_id, tree: 't', question: `Q ${node_id}?`, status: 'live', kind: 'open', impact: 'high', given: null, anchor: null, review: null, woken: [],
    resolve_by: '2025-03-31', options: Object.entries(opts).map(([key, p]) => ({ key, label: key, p, signpost: `sign ${key}`, dormant: false, effects: [] })), ...over,
})
const sections = () => ({ backdrop: [], prices: [], news: [], policy: [], calendar: [] })
const sstate = (sector, as_of = '2025-01-07') => ({ sector, as_of, sections: sections(), articles: [] })
const macroState = (as_of = '2025-01-07') => ({ as_of, sections: { regime: [{ text: 'Growth slowing', value: null, as_of, source: 'reading', tag: 'reading' }], policy: [], money: [], stories: [{ text: 'AI unwind', value: null, as_of, source: 'x', tag: 'fact' }], prices: [], calendar: [] }, articles: [] })

// ── sectors and records ──

test('sectors: eleven GICS sectors, each with two GNews topics and two terms; codes map to sectors', () => {
    assert.equal(SECTORS.length, 11)
    assert.ok(SECTORS.every(s => s.gnews.length === 2 && s.terms.length === 2))
    assert.equal(sectorOf('35201010'), '35')
    assert.equal(sectorOf('99'), null)
    assert.ok(isLayer('macro') && isLayer('45') && !isLayer('46'))
    assert.equal(layerOf({}), 'macro')
    assert.equal(layerName('35'), 'Health Care')
})

test('records: a node keeps its layer (macro by default, a bad one refused); forecasts, dropped items and industries keep theirs', () => {
    const base = { tree: 't', question: 'Q?', options: [{ key: 'a', label: 'a', p: 0.5 }, { key: 'b', label: 'b', p: 0.5 }] }
    assert.equal(checkNode(base).value.layer, 'macro')
    assert.equal(checkNode({ ...base, layer: '35' }).value.layer, '35')
    assert.match(checkNode({ ...base, layer: 'pharma' }).reason, /layer/)
    assert.equal(checkForecast({ node_id: 'n', option: 'a', p: 0.5, set_by: 'llm', layer: '35' }).value.layer, '35')
    assert.equal(checkDropped({ considered: 1, open: 0, settled: 0, dropped: [{ question: 'Q', reason: 'cap', layer: '35' }] }).value.dropped[0].layer, '35')
    assert.deepEqual(checkIndustry({ code: 'G', name: 'Gold', p_win: 0.5, p_lose: 0.2, macro: { p_win: 0.4, p_lose: 0.1 } }).value.macro, { p_win: 0.4, p_lose: 0.1 })
})

test('checkSectorState: a sector code, every section, nothing after its date; the bundle takes one per sector', () => {
    assert.equal(checkSectorState(sstate('35')).ok, true)
    assert.match(checkSectorState(sstate('macro')).reason, /sector code/)
    assert.match(checkSectorState({ ...sstate('35'), sections: { backdrop: [] } }).reason, /section prices is missing/)
    const late = { ...sstate('35'), sections: { ...sections(), news: [{ text: 'x', as_of: '2025-02-01', source: 's', tag: 'fact' }] } }
    assert.match(checkSectorState(late).reason, /after the state's as_of/)
    const run = { kind: 'sectors', as_of: '2025-01-07' }
    assert.equal(checkBundle({ run, sector_states: [sstate('35'), sstate('45')] }).ok, true)
    assert.match(checkBundle({ run, sector_states: [sstate('35'), sstate('35')] }).reason, /two for sector 35/)
})

// ── the layer rules ──

test('holdCaps: per layer — macro 20, each sector 3, every sector together 30; settled nodes never count', () => {
    const macro = Array.from({ length: 22 }, (_, i) => node(`m${i}`, { a: 0.5 + i * 0.01, b: 0.5 - i * 0.01 }))
    const health = Array.from({ length: 5 }, (_, i) => node(`h${i}`, { a: 0.5 + i * 0.05, b: 0.5 - i * 0.05 }, { layer: '35' }))
    const settledOne = node('s', { a: 0.9, b: 0.1 }, { kind: 'settled', layer: '35' })
    const out = holdCaps([...macro, ...health, settledOne])
    assert.deepEqual(out.filter(id => id.startsWith('m')).sort(), ['m20', 'm21'], 'the two least uncertain macro nodes')
    assert.deepEqual(out.filter(id => id.startsWith('h')).sort(), ['h3', 'h4'])
    assert.ok(!out.includes('s'))
    // Eleven sectors of three: 33 > 30, so the three lowest across sectors go too.
    const many = SECTORS.flatMap((s, k) => [0, 1, 2].map(i => node(`${s.code}_${i}`, { a: 0.5 + (k * 3 + i) * 0.004, b: 0.5 - (k * 3 + i) * 0.004 }, { layer: s.code })))
    assert.equal(holdCaps(many).length, SECTORS.length * SECTOR_CAP - SECTORS_TOTAL_CAP)
})

test('capOut takes the children of a node moved out with it', () => {
    const ns = [node('p', { a: 0.99, b: 0.01 }, { layer: '35' }), node('c', { x: 0.5, y: 0.5 }, { layer: '35', given: { node_id: 'p', option: 'a' }, kind: 'settled' }),
        ...[1, 2, 3].map(i => node(`k${i}`, { a: 0.5, b: 0.5 }, { layer: '35' }))]
    assert.deepEqual(capOut(ns).sort(), ['c', 'p'])
})

test('promote: a sector question reaching industries in 3+ sectors moves to the macro layer; fewer stays', () => {
    const wide = node('w', { a: 0.5, b: 0.5 }, { layer: '45' })
    wide.options[0].effects = [{ code: '45301020', direction: 'up', bucket: 'large' }, { code: '55101010', direction: 'up', bucket: 'medium' }]
    wide.options[1].effects = [{ code: '20304010', direction: 'down', bucket: 'small' }]
    const narrow = node('n', { a: 0.5, b: 0.5 }, { layer: '35' })
    narrow.options[0].effects = [{ code: '35201010', direction: 'up', bucket: 'large' }]
    const r = promote([wide, narrow])
    assert.equal(r.nodes.find(n => n.node_id === 'w').layer, 'macro')
    assert.equal(r.nodes.find(n => n.node_id === 'n').layer, '35')
    assert.deepEqual(r.promoted, [{ node_id: 'w', from: '45', sectors: ['20', '45', '55'] }])
})

test('anchorLinks: a new link counts from now; a link the anchor knows is left alone', () => {
    const a = node('a', { x: 0.6, y: 0.4 }), b = node('b', { u: 0.5, v: 0.5 })
    const old = { link_id: 'L0', from: { node_id: 'a', option: 'x' }, to: { node_id: 'b', option: 'u' }, shift: 1 }
    const nodes = [a, { ...b, anchor: anchorFor([a, b], [old], 'b') }]
    const fresh = { link_id: 'L1', from: { node_id: 'a', option: 'y' }, to: { node_id: 'b', option: 'v' }, shift: 1 }
    const out = anchorLinks(nodes, [old, fresh]).find(n => n.node_id === 'b').anchor.src
    assert.equal(out.L0, 0.6)
    assert.equal(out.L1, 0.4)
})

test('withMacroScores: the macro layer alone — a sector branch does not count there', () => {
    const m = node('m', { up: 0.7, down: 0.3 }), s = node('s', { yes: 0.9, no: 0.1 }, { layer: '35' })
    const effects = new Map([['m|up', [{ code: 'G', direction: 'up', bucket: 'large' }]], ['s|yes', [{ code: 'B', direction: 'up', bucket: 'large' }]]])
    const rows = withMacroScores([{ code: 'G', p_win: 0.7, p_lose: 0 }, { code: 'B', p_win: 0.9, p_lose: 0 }], [m, s], [], effects, [{ code: 'G', name: 'G' }, { code: 'B', name: 'B' }])
    assert.ok(Math.abs(rows[0].macro.p_win - 0.7) < 0.03)
    assert.deepEqual(rows[1].macro, { p_win: 0, p_lose: 0 })
})

test('settle: promotion, caps, kept links, forecasts with their final layer, and counts that add up', () => {
    const ns = [...[0, 1, 2, 3].map(i => node(`h${i}`, { a: 0.5 + i * 0.05, b: 0.5 - i * 0.05 }, { layer: '35' })), node('m', { a: 0.5, b: 0.5 })]
    const links = [{ link_id: 'L', from: { node_id: 'm', option: 'a' }, to: { node_id: 'h3', option: 'a' }, shift: 1 }]
    const fc = ns.map(n => ({ node_id: n.node_id, option: 'a', p: 0.5, set_by: 'llm', layer: 'macro' }))
    const r = settle({ nodes: ns, links, forecasts: fc, dropped: [{ question: 'x', reason: 'low_impact', options: [] }], asOf: '2025-01-07' })
    assert.ok(!r.nodes.some(n => n.node_id === 'h3'))
    assert.equal(r.links.length, 0, 'the link to the dropped node goes')
    assert.equal(r.forecasts.find(f => f.node_id === 'h0').layer, '35')
    assert.equal(checkDropped(r.dropped).ok, true)
    assert.equal(r.dropped.dropped.find(d => d.reason === 'cap').layer, '35')
})

test('mapByLayer: one mapping per layer group, effects merged; one failure fails it', async () => {
    const calls = []
    const map = async (ns) => { calls.push(ns.map(n => n.node_id)); return { ok: true, effects: new Map(ns.map(n => [`${n.node_id}|a`, [{ code: 'G' }]])), cost_usd: 0.5 } }
    const r = await mapByLayer([node('m', { a: 1 }), node('s', { a: 1 }, { layer: '35' })], [], map)
    assert.deepEqual(calls, [['m'], ['s']])
    assert.equal(r.effects.size, 2)
    assert.equal(r.cost_usd, 1)
    assert.equal((await mapByLayer([node('m', { a: 1 })], [], async () => ({ ok: false, reason: 'down', cost_usd: 0 }))).ok, false)
})

// ── the sector state and its news ──

test('the sector state: the macro backdrop and the sector prices by code; the schema has the sector sections', () => {
    const b = macroBackdrop(macroState())
    assert.deepEqual(b.map(i => i.text), ['Growth slowing', 'AI unwind'])
    assert.match(b[0].source, /the macro state of 2025-01-07/)
    const rows = [{ code: '35201010', name: 'Biotechnology', date: '2025-01-06', vs_m1: 0.01, vs_m3: -0.05, vs_m12: 0.1, above_50d: false, above_200d: true }, { code: '45301020', name: 'Semis', date: '2025-01-06', vs_m3: 0.2 }]
    const p = sectorPriceItems('35', rows)
    assert.equal(p.length, 1)
    assert.match(p[0].text, /^Biotechnology: against the S&P 1m \+1\.0%, 3m -5\.0%/)
    assert.deepEqual(Object.keys(sectorSchema().properties).sort(), ['calendar', 'news', 'policy', 'questions'])
    assert.match(sectorPrompt(SECTORS[5], '2025-01-07', b, p, []), /SECTOR: Health Care \(GICS 35\)/)
})

test('buildSectorState: one call → a checked sector state and its questions; a failed call is said', async () => {
    const art = { url: 'u1', title: 'FDA slows approvals', source: 'Reuters', published_at: '2025-01-06T10:00:00Z', text: '' }
    setSectorIO({ news: async () => ({ articles: [art], gaps: [] }), payer: async () => null, system: () => 'S',
        call: async (a) => { a.onUsage({ input_tokens: 1000, output_tokens: 100 }, 'claude-opus-5-5'); return { data: {
            news: [{ text: 'The FDA slowed approvals', as_of: '2025-01-06', cites: [1], tag: 'fact' }], policy: [], calendar: [],
            questions: [{ question: 'Does FDA approval pace recover by Q2?', tree: 'fda', options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }], impact: 'high', uncertainty: 'high', why: 'biotech' }],
        } } } })
    const r = await buildSectorState(SECTORS[5], '2025-01-07', macroState(), [])
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.state.sector, '35')
    assert.equal(r.state.sections.news[0].text, 'The FDA slowed approvals')
    assert.equal(r.state.sections.backdrop.length, 2)
    assert.equal(r.questions.length, 1)
    assert.ok(r.cost_usd > 0)
    setSectorIO({ call: async () => { throw new Error('overloaded') } })
    assert.match((await buildSectorState(SECTORS[5], '2025-01-07', macroState(), [])).reason, /Health Care: the state call failed/)
})

test('fetchSectorNews: its own terms, its names (at most four each), its GNews topics unless told not to; failures are gaps', async () => {
    const asked = []
    setNewsIO({ now: () => new Date('2025-01-07T12:00:00Z'), hasGnews: () => true,
        sectorPolicy: async (_now, _days, terms) => { asked.push(`fr ${terms.join('|')}`); return [{ title: 'Drug pricing rule', date: '2025-01-06', url: 'https://fr/1' }] },
        stockNews: async (symbols) => { asked.push(`fmp ${symbols.join(',')}`); return Array.from({ length: 6 }, (_, i) => ({ symbol: 'LLY', title: `LLY ${i}`, publishedDate: '2025-01-06 10:00:00', url: `https://n/${i}`, site: 'x' })) },
        gnews: async (q) => { asked.push(`gnews ${q}`); throw new Error('quota') } })
    const r = await fetchSectorNews(SECTORS[5], { asOf: '2025-01-07', names: ['LLY'] })
    assert.equal(r.articles.filter(a => a.title.startsWith('LLY')).length, 4)
    assert.ok(r.articles.some(a => a.title === 'Drug pricing rule'))
    assert.ok(asked.includes('fr drug pricing|Medicare'))
    assert.equal(r.gaps.filter(g => /GNews/.test(g)).length, 2)
    asked.length = 0
    await fetchSectorNews(SECTORS[5], { asOf: '2025-01-07', names: [], gnews: false })
    assert.ok(!asked.some(a => a.startsWith('gnews')) && !asked.some(a => a.startsWith('fmp')))
})

// ── the builds ──

test('buildSectorLayer: each sector state then its network; a failed sector is a gap; one links call joins them to the macro layer', async () => {
    const calls = { links: 0 }
    setLayersIO({
        names: async () => new Map([['35', ['LLY']]]),
        state: async (s) => (s.code === '45' ? { ok: false, reason: 'down', cost_usd: 0.1 } : { ok: true, state: sstate(s.code), questions: s.code === '35' ? [{ q: 1 }] : [], gaps: [], cost_usd: 0.1 }),
        network: async (_st, _qs, o) => ({ ok: true, nodes: [node('h1', { a: 0.5, b: 0.5 }, { layer: o.layer })], links: [], dropped: { considered: 1, dropped: [] }, forecasts: [{ node_id: 'h1', option: 'a', p: 0.5, set_by: 'llm', layer: o.layer }], cost_usd: 0.2 }),
        links: async (all, ids) => { calls.links++; assert.deepEqual(ids, ['h1']); assert.ok(all.some(n => n.node_id === 'm')); return { ok: true, links: [{ link_id: 'X', from: { node_id: 'm', option: 'a' }, to: { node_id: 'h1', option: 'a' }, shift: 0.8 }], cost_usd: 0.05 } },
    })
    const r = await buildSectorLayer({ asOf: '2025-01-07', state: macroState(), existing: [node('m', { a: 0.5, b: 0.5 })] })
    assert.equal(r.sector_states.length, 10)
    assert.deepEqual(r.failed.map(f => f.sector), ['45'])
    assert.equal(r.nodes.length, 1)
    assert.equal(r.nodes[0].layer, '35')
    assert.equal(r.links.length, 1)
    assert.equal(calls.links, 1)
    assert.ok(Math.abs(r.cost_usd - (11 * 0.1 + 0.2 + 0.05)) < 1e-9)
})

const bundleSaver = (into) => async (b) => { into.b = b; const c = checkBundle(b); return c.ok ? { ok: true, run_id: 'run_new' } : c }

test('buildSectors: the layer ADDED to the latest run — macro nodes unchanged, sector states saved, a valid `sectors` run', async () => {
    const m = node('m', { a: 0.5, b: 0.5 })
    const prev = { run: { run_id: 'run_1', stats: {} }, state: macroState(), nodes: [{ ...m, anchor: anchorFor([m], [], 'm') }], links: [], dropped: { considered: 1, open: 1, settled: 0, dropped: [] }, industries: [] }
    const out = {}
    setBuildIO({
        latestRun: async () => ({ run_id: 'run_1', as_of: '2025-01-07' }), readRun: async () => prev, data: async () => ({ numbers: { industries: [] }, gaps: [] }),
        buildSectorLayer: async () => ({ sector_states: [sstate('35')], nodes: [node('h', { a: 0.6, b: 0.4 }, { layer: '35', anchor: { p: { a: 0.6, b: 0.4 }, src: {}, on: '2025-01-08' } })], links: [{ link_id: 'L', from: { node_id: 'm', option: 'a' }, to: { node_id: 'h', option: 'a' }, shift: 0.8, live: true }],
            dropped: [], forecasts: [{ node_id: 'h', option: 'a', p: 0.6, set_by: 'llm', layer: '35' }], cost_usd: 1, gaps: [], failed: [] }),
        buildExposures: async () => ({ industries: [{ code: '35201010', name: 'Biotech', level: 'sub_industry' }], gaps: [] }),
        mapBranches: async (ns) => ({ ok: true, effects: new Map([[`${ns[0].node_id}|a`, [{ code: '35201010', direction: 'up', bucket: 'large', why: 'w' }]]]), cost_usd: 0.3 }),
        saveRun: bundleSaver(out),
    })
    const r = await buildSectors({ asOf: '2025-01-08' })
    assert.equal(r.ok, true, r.reason)
    assert.equal(out.b.run.kind, 'sectors')
    assert.deepEqual(out.b.sector_states.map(s => s.sector), ['35'])
    assert.deepEqual(out.b.nodes.find(n => n.node_id === 'm').options, prev.nodes[0].options)
    assert.equal(out.b.industries[0].code, '35201010')
    assert.deepEqual(out.b.industries[0].macro, { p_win: 0, p_lose: 0 }, 'the macro layer alone does not reach biotech')
    assert.equal(typeof out.b.nodes.find(n => n.node_id === 'h').anchor.src.L, 'number', 'the macro → sector link counts from now')
    assert.equal(r.stats.cost_usd, 1.3)
})

test('buildFull: both layers in one run; the sector layer off builds the macro layer alone', async () => {
    const out = {}
    let sectorCalls = 0
    setBuildIO({
        sectorsOn: () => true,
        buildState: async () => ({ ok: true, state: macroState(), questions: [{}], numbers: { industries: [] }, gaps: [], cost_usd: 0.4 }),
        buildNetwork: async () => ({ ok: true, nodes: [node('m', { a: 0.5, b: 0.5 }, { layer: 'macro' })], links: [], dropped: { considered: 1, open: 1, settled: 0, dropped: [] }, forecasts: [], cost_usd: 1, runs: 3 }),
        buildSectorLayer: async () => { sectorCalls++; return { sector_states: [sstate('35')], nodes: [node('h', { a: 0.5, b: 0.5 }, { layer: '35' })], links: [], dropped: [], forecasts: [], cost_usd: 2, gaps: [], failed: [] } },
        buildExposures: async () => ({ industries: [{ code: 'G', name: 'Gold', level: 'industry' }], gaps: [] }),
        mapBranches: async () => ({ ok: true, effects: new Map(), cost_usd: 0.5 }),
        latestRun: async () => null, readRun: async () => null, saveRun: bundleSaver(out),
    })
    const r = await buildFull({ asOf: '2025-01-07' })
    assert.equal(r.ok, true, r.reason)
    assert.equal(out.b.nodes.length, 2)
    assert.equal(out.b.sector_states.length, 1)
    assert.equal(r.stats.cost_by_stage.sectors, 2)
    assert.equal(r.stats.cost_usd, 0.4 + 1 + 2 + 1)
    setBuildIO({ sectorsOn: () => false })
    await buildFull({ asOf: '2025-01-07' })
    assert.equal(sectorCalls, 1)
    assert.equal(out.b.sector_states.length, 0)
})

// ── the update ──

const ev = (over) => ({ articles: [1], summary: 's', reasoning: 'r', decision: 'none', node: null, probabilities: [], new_option: null, resolution: null, new_question: null, outside: null, ...over })

test('applyAnswer: a new question asked in a sector call carries that sector', () => {
    const q = { question: 'Does the MFN rule take effect?', tree: 'drug_pricing', options: [{ key: 'yes', label: 'Yes', signpost: 's' }, { key: 'no', label: 'No', signpost: 's' }],
        probabilities: [{ option: 'yes', value: 0.4 }, { option: 'no', value: 0.6 }], impact: 'high', uncertainty: 'high', why: 'w', resolve_by: '2025-06-30', lag_days: { min: 0, max: 90 } }
    const r = applyAnswer({ events: [ev({ decision: 'new_question', new_question: q })] }, [], [], '2025-01-07', '35')
    assert.equal(r.nodes[0].layer, '35')
    assert.equal(r.decisions[0].layer, '35')
})

test('runUpdate: an event on one sector runs only that call; macro questions untouched; the sector state carries its news', async () => {
    const m = node('m', { a: 0.5, b: 0.5 }), h = node('h', { yes: 0.5, no: 0.5 }, { layer: '35' }), s = node('s', { x: 0.5, y: 0.5 }, { layer: '45' })
    const nodes = [m, h, s].map(n => ({ ...n, anchor: anchorFor([m, h, s], [], n.node_id) }))
    let saved = null
    const seen = []
    setUpdateIO({
        sectorsOn: () => true, names: async () => new Map(),
        latest: async () => ({ run_id: 'run_1', as_of: '2025-01-07' }),
        read: async () => ({ run: { run_id: 'run_1', stats: { sectors: { built: ['35', '45'], failed: [], promoted: [] } } }, state: { ...macroState(), articles: [] }, sector_states: [sstate('35'), sstate('45')],
            nodes, links: [], dropped: { considered: 3, open: 3, settled: 0, dropped: [] }, industries: [{ code: 'G', name: 'Gold', level: 'industry', p_win: 0.2, p_lose: 0.1 }] }),
        news: async () => { throw new Error('the macro feed must not be read') },
        sectorNews: async (sec) => ({ articles: [{ url: `u${sec.code}`, title: 'FDA news', source: 'AP', published_at: '2025-01-08T10:00:00Z', text: '' }], gaps: [] }),
        payer: async () => null, system: () => 'S',
        call: async (a) => { seen.push(a.user.split('\n')[0]); return { data: { events: [ev({ decision: 'moves_option', node: 1, probabilities: [{ option: 'yes', value: 0.8 }, { option: 'no', value: 0.2 }] })], signposts_fired: [], due: [] } } },
        save: async (b) => { saved = b; const c = checkBundle(b); return c.ok ? { ok: true, run_id: 'run_2' } : c },
        grade: async () => 0,
    })
    const r = await runUpdate({ kind: 'event', trigger: 'FDA', asOf: '2025-01-08', layers: ['35'] })
    assert.equal(r.ok, true, r.reason)
    assert.equal(seen.length, 1)
    assert.match(seen[0], /^SECTOR: Health Care/)
    assert.equal(saved.nodes.find(n => n.node_id === 'h').options[0].p, 0.8)
    assert.equal(saved.nodes.find(n => n.node_id === 'm').options[0].p, 0.5)
    assert.equal(saved.sector_states.find(x => x.sector === '35').articles.length, 1)
    assert.equal(saved.sector_states.find(x => x.sector === '45').as_of, '2025-01-07', 'a sector that did not run carries over')
    assert.equal(saved.forecasts[0].layer, '35')
    assert.deepEqual(r.stats.layers.map(x => x.layer), ['35'])
})

test('runUpdate: a sector call that fails leaves its questions as they were and says so; the macro call still counts', async () => {
    const m = node('m', { a: 0.5, b: 0.5 }), h = node('h', { yes: 0.5, no: 0.5 }, { layer: '35' })
    const nodes = [m, h].map(n => ({ ...n, anchor: anchorFor([m, h], [], n.node_id) }))
    let saved = null
    setUpdateIO({
        read: async () => ({ run: { run_id: 'run_1', stats: {} }, state: { ...macroState(), articles: [] }, sector_states: [sstate('35')], nodes, links: [], dropped: { considered: 2, open: 2, settled: 0, dropped: [] }, industries: [] }),
        news: async () => ({ articles: [], gaps: [] }),
        call: async (a) => { if (a.user.startsWith('SECTOR')) throw new Error('overloaded'); return { data: { events: [ev({ decision: 'moves_option', node: 1, probabilities: [{ option: 'a', value: 0.7 }, { option: 'b', value: 0.3 }] })], signposts_fired: [], due: [] } } },
        save: async (b) => { saved = b; const c = checkBundle(b); return c.ok ? { ok: true, run_id: 'run_2' } : c },
    })
    const r = await runUpdate({ kind: 'event', trigger: 'x', asOf: '2025-01-08', layers: ['macro', '35'] })
    assert.equal(r.ok, true, r.reason)
    assert.equal(saved.nodes.find(n => n.node_id === 'm').options[0].p, 0.7)
    assert.equal(saved.nodes.find(n => n.node_id === 'h').options[0].p, 0.5)
    assert.ok(r.stats.gaps.some(g => /Health Care: the update call failed \(overloaded\)/.test(g)))
})

// ── the watcher, the card, Axl ──

test('watch: a network with no sector layer gets one; the triage names layers; unknown ones are dropped', () => {
    assert.equal(dueKind({ as_of: '2025-01-05' }, '2024-12-31', '2025-01-07', '2025-01-05', true), 'sectors')
    assert.equal(dueKind(null, null, '2025-01-07', null, true), 'build')
    assert.deepEqual(eventLayers(['35', 'macro', '35', 'nope']), ['35', 'macro'])
    assert.deepEqual(eventLayers([]), ['macro'])
    assert.ok(triageSchema().properties.layers.items.enum.includes('60'))
})

test('the card and Axl name a sector question\'s sector', () => {
    const run = { run: { kind: 'sectors', as_of: '2025-01-08', stats: {} }, nodes: [node('m', { a: 0.5, b: 0.5 }), node('h', { a: 0.5, b: 0.5 }, { layer: '35' })], industries: [], links: [] }
    const c = cardLines(run)
    assert.match(c.title, /sector layer is built/)
    assert.deepEqual(c.lines, ['• [Health Care] Q h? — a 50% / b 50%'])
    assert.match(formatSummary(run), /- \[Health Care\] Q h\?/)
    assert.equal(numbered(run.nodes).length, 2)
})

test('runUpdate: an event naming only a sector the network lacks updates the macro layer instead', async () => {
    const m = node('m', { a: 0.5, b: 0.5 })
    const seen = []
    setUpdateIO({
        latest: async () => ({ run_id: 'run_1', as_of: '2025-01-07' }),
        read: async () => ({ run: { run_id: 'run_1', stats: {} }, state: { ...macroState(), articles: [] }, sector_states: [], nodes: [{ ...m, anchor: anchorFor([m], [], 'm') }], links: [], dropped: { considered: 1, open: 1, settled: 0, dropped: [] }, industries: [] }),
        news: async () => ({ articles: [], gaps: [] }),
        call: async (a) => { seen.push(a.user.split('\n')[0]); return { data: { events: [], signposts_fired: [], due: [] } } },
        save: async (b) => { const c = checkBundle(b); return c.ok ? { ok: true, run_id: 'run_2' } : c },
    })
    const r = await runUpdate({ kind: 'event', trigger: 'x', asOf: '2025-01-08', layers: ['60'] })
    assert.equal(r.ok, true, r.reason)
    assert.equal(seen.length, 1)
    assert.match(seen[0], /^AS-OF DATE/)
})

test('tick: a head with no sector state gets the sector run; while a failed one waits its day, the weekly goes on', async () => {
    const keep = process.env.SITUATION_NETWORK
    try {
        process.env.SITUATION_NETWORK = 'true'
        const store = { [WATCH]: [], [COLLECTIONS.runs]: [{ kind: 'build', as_of: '2024-12-31', complete: true }], [COLLECTIONS.sectorStates]: [] }
        const db = { collection: (name) => ({
            findOne: async (q) => (store[name] ?? []).find(d => d._id === q._id) ?? null,
            updateOne: async (q, u) => { const arr = store[name] ??= []; let d = arr.find(x => x._id === q._id); if (!d) { d = { _id: q._id }; arr.push(d) } Object.assign(d, u.$set) },
            countDocuments: async (q) => (store[name] ?? []).filter(d => d.run_id === q.run_id).length,
            find: (q = {}) => { const out = (store[name] ?? []).filter(r => !q.kind || q.kind.$in.includes(r.kind)); const c = { sort: () => c, limit: () => c, next: async () => out[0] ?? null, toArray: async () => out }; return c },
        }) }
        const did = []
        setWatchIO({ sectorsOn: () => true, now: () => new Date('2025-01-08T12:00:00Z'), db: async () => db, latest: async () => ({ run_id: 'r1', as_of: '2024-12-31' }),
            busy: async () => {}, free: async () => {}, card: async () => {}, control: async () => {},
            sectors: async () => { did.push('sectors'); return { ok: false, reason: 'all sectors failed', cost_usd: 1 } },
            update: async (o) => { did.push(o.kind); return { ok: true, run_id: 'r2' } } })
        assert.equal((await tick()).did, 'sectors')
        assert.equal((await tick()).did, 'weekly', 'the failed sector run waits; the weekly does not')
        assert.deepEqual(did, ['sectors', 'weekly'])
    } finally { if (keep === undefined) delete process.env.SITUATION_NETWORK; else process.env.SITUATION_NETWORK = keep }
})

// ── the weekly rewrite and the origin ──

test('promote keeps the ORIGIN; "macro alone" and the grading count a promoted question by where it was born', () => {
    const w = node('w', { a: 0.5, b: 0.5 }, { layer: '45' })
    w.options[0].effects = [{ code: '45301020', direction: 'up', bucket: 'large' }, { code: '55101010', direction: 'up', bucket: 'medium' }, { code: '20304010', direction: 'up', bucket: 'small' }]
    const p = promote([w]).nodes[0]
    assert.equal(p.layer, 'macro')
    assert.equal(p.origin, '45')
    assert.equal(checkNode(p).value.origin, '45')
    assert.equal(checkNode({ tree: 't', question: 'Q?', options: [{ key: 'a', label: 'a', p: 1 }, { key: 'b', label: 'b', p: 0, signpost: 's' }], layer: '35' }).value.origin, '35')
    const rows = withMacroScores([{ code: '45301020', p_win: 0.5, p_lose: 0 }], [p], [], new Map([['w|a', w.options[0].effects]]), [{ code: '45301020', name: 'Semis' }])
    assert.deepEqual(rows[0].macro, { p_win: 0, p_lose: 0 }, 'a promoted question is not the macro layer\'s own work')
    const r = settle({ nodes: [w], links: [], forecasts: [{ node_id: 'w', option: 'a', p: 0.5, set_by: 'llm' }], dropped: [], asOf: '2025-01-07' })
    assert.equal(r.nodes[0].layer, 'macro')
    assert.equal(r.forecasts[0].layer, '45', 'graded by its origin')
})

test('runUpdate weekly: the macro description and each sector\'s are REWRITTEN with the live questions; a failed rewrite carries the readings over', async () => {
    const m = node('m', { a: 0.5, b: 0.5 }, { reasoning: 'Because of X.' }), h = node('h', { yes: 0.5, no: 0.5 }, { layer: '35' }), t = node('t', { u: 0.5, v: 0.5 }, { layer: '45' })
    const nodes = [m, h, t].map(n => ({ ...n, anchor: anchorFor([m, h, t], [], n.node_id) }))
    let saved = null
    const asked = {}
    const newMacro = { ...macroState('2025-01-14'), sections: { ...macroState('2025-01-14').sections, stories: [{ text: 'Rewritten story', value: null, as_of: '2025-01-14', source: 'x', tag: 'reading' }] } }
    setUpdateIO({
        sectorsOn: () => true, names: async () => new Map(),
        latest: async () => ({ run_id: 'run_1', as_of: '2025-01-07' }),
        read: async () => ({ run: { run_id: 'run_1', stats: {} }, state: { ...macroState(), articles: [] }, sector_states: [sstate('35'), sstate('45')], nodes, links: [], dropped: { considered: 3, open: 3, settled: 0, dropped: [] }, industries: [] }),
        news: async () => ({ articles: [{ url: 'm1', title: 'Macro news', source: 'AP', published_at: '2025-01-13T10:00:00Z', text: '' }], gaps: [] }),
        sectorNews: async (sec) => ({ articles: [{ url: `u${sec.code}`, title: 'Sector news', source: 'AP', published_at: '2025-01-13T10:00:00Z', text: '' }], gaps: [] }),
        call: async () => ({ data: { events: [], signposts_fired: [], due: [] } }),
        data: async () => ({ sections: { regime: [], prices: [], money: [], calendar: [] }, numbers: { industries: [] }, gaps: [] }),
        rewrite: async (asOf, o) => { asked.macro = o.questions.map(n => n.node_id); return { ok: true, state: { ...newMacro, articles: o.articles }, cost_usd: 0.4 } },
        rewriteSector: async (sec, asOf, macro, rows, articles, qs) => {
            asked[sec.code] = { qs: qs.map(n => n.node_id), backdrop: macro.sections.stories[0]?.text }
            return sec.code === '45' ? { ok: false, reason: 'overloaded', cost_usd: 0.01 } : { ok: true, state: { ...sstate('35', '2025-01-14'), articles }, cost_usd: 0.05 }
        },
        save: async (b) => { saved = b; const c = checkBundle(b); return c.ok ? { ok: true, run_id: 'run_2' } : c },
        grade: async () => 0,
    })
    const r = await runUpdate({ kind: 'weekly', asOf: '2025-01-14' })
    assert.equal(r.ok, true, r.reason)
    assert.deepEqual(asked.macro, ['m'])
    assert.deepEqual(asked['35'], { qs: ['h'], backdrop: 'Rewritten story' }, 'the sector reads the REWRITTEN macro picture')
    assert.equal(saved.state.sections.stories[0].text, 'Rewritten story')
    assert.equal(saved.sector_states.find(x => x.sector === '35').as_of, '2025-01-14')
    const tech = saved.sector_states.find(x => x.sector === '45')
    assert.equal(tech.as_of, '2025-01-14')
    assert.equal(tech.sections.backdrop[1].text, 'Rewritten story', 'failed → its backdrop still refreshed')
    assert.ok(r.stats.gaps.some(g => /Information Technology: the description was not rewritten \(.*overloaded\)/.test(g)))
    assert.ok(Math.abs(r.stats.cost_usd - 0.46) < 1e-9)
})
