import { test } from 'node:test'
import assert from 'node:assert/strict'

import { effectLine, outcomesPrompt, outcomesSchema, numberedLive, applyOutcomes, reviewOutcomes, FOLLOW_UP_MIN_P, checkResolutions, checkPrompt, checkSchema, MAX_CHANGES, _setIO as setOutcomesIO } from '../../services/situation/outcomes.js'
import { applyAnswer, numbered, runUpdate, routeOutside, withRouted, updatePrompt, updateSchema, sectorCodes, withChecks, _setIO } from '../../services/situation/update.js'
import { linksPrompt, linksFor, _setIO as setNetworkIO } from '../../services/situation/network.js'
import { absentRows, checkBundle } from '../../services/situation/store.js'
import { unforeseenCount } from '../../services/situation/scorecard.js'
import { cardLines } from '../../services/situation/review.js'
import { anchorFor, dropOrphans, resolve } from '../../services/situation/propagate.js'

// The missing-outcomes review, the resolution check, the grading of an option a forecast lacked, and the macro call's
// outside stories routed to the sectors (docs/design/situation-network-outcomes.md).

const node = (node_id, opts, over = {}) => ({
    node_id, tree: 'tech', question: `Q ${node_id}?`, status: 'live', kind: 'open', impact: 'high', given: null, anchor: null, review: null, woken: [], layer: 'macro', origin: 'macro',
    resolve_by: '2027-03-31', options: Object.entries(opts).map(([key, p]) => ({ key, label: key, p, signpost: `sign ${key}`, dormant: false, effects: [] })), ...over,
})
const ev = (over) => ({ articles: [1], summary: 's', reasoning: 'r', decision: 'none', node: null, probabilities: [], new_option: null, resolution: null, new_question: null, outside: null, ...over })
const P = (o) => Object.entries(o).map(([option, value]) => ({ option, value }))
const ceo = () => node('ceo', { yes: 0.6, no: 0.4 }, { question: 'Does Nvidia name a permanent CEO by Q1 2027?',
    options: [{ key: 'yes', label: 'Yes', p: 0.6, signpost: 's', dormant: false, effects: [{ code: 'SEMI', direction: 'down', bucket: 'small' }, { code: 'SOFT', direction: 'up', bucket: 'large' }] },
        { key: 'no', label: 'No', p: 0.4, signpost: 's', dormant: false, effects: [] }] })

test('the review prompt shows what each option assumes, largest effects first; the schema is strict', () => {
    const names = new Map([['SEMI', 'Semiconductors'], ['SOFT', 'Software']])
    assert.equal(effectLine(ceo().options[0], names), 'Software up, Semiconductors down')
    assert.equal(effectLine(ceo().options[1], names), 'no industry effect mapped')
    const p = outcomesPrompt('2026-11-24', numberedLive([ceo(), node('gone', { a: 1 }, { status: 'resolved' })]), names)
    assert.match(p, /1\. \[Macro · tech\] Does Nvidia name a permanent CEO by Q1 2027\? \(resolve by 2027-03-31; 2 options\)/)
    assert.match(p, /yes = Yes 60%; assumes: Software up, Semiconductors down/)
    assert.doesNotMatch(p, /Q gone/)
    assert.equal(outcomesSchema().properties.changes.items.additionalProperties, false)
})

test('applyOutcomes: an added option takes its share, is mapped and linked; a full question or bad numbers are skipped', () => {
    const nodes = [ceo(), node('full', { a: 0.25, b: 0.25, c: 0.25, d: 0.25 }), node('x', { a: 0.5, b: 0.5 })]
    const list = numberedLive(nodes)
    const r = applyOutcomes({ changes: [
        { node: 1, verdict: 'add_option', reasoning: 'Yes lumps an outsider and Huang back', new_option: { key: 'huang_returns', label: 'Huang returns', signpost: 'board talks to Huang' }, reworded: null, probabilities: P({ yes: 0.4, no: 0.4, huang_returns: 0.2 }) },
        { node: 1, verdict: 'add_option', reasoning: 'twice', new_option: { key: 'other', label: 'Other', signpost: '' }, reworded: null, probabilities: P({ yes: 1, other: 1 }) },
        { node: 2, verdict: 'add_option', reasoning: 'full', new_option: { key: 'e', label: 'E', signpost: '' }, reworded: null, probabilities: P({ a: 1, e: 1 }) },
        { node: 3, verdict: 'add_option', reasoning: 'zero', new_option: { key: 'z', label: 'Z', signpost: '' }, reworded: null, probabilities: P({ a: 1, b: 1, z: 0 }) },
    ] }, list, nodes, '2026-11-24')
    const c = r.nodes.find(n => n.node_id === 'ceo')
    assert.deepEqual(c.options.map(o => [o.key, Math.round(o.p * 100)]), [['yes', 40], ['no', 40], ['huang_returns', 20]])
    assert.deepEqual(r.newOptions, [{ node_id: 'ceo', option: 'huang_returns' }])
    assert.ok(r.needMap.has('ceo') && r.rejudged.has('ceo'))
    assert.deepEqual(r.skipped.map(s => s.reason), ['changed once already in this review', 'the question has 4 options already', 'its probabilities did not fit, or gave the new option nothing'])
    assert.equal(r.added[0].label, 'Huang returns')
})

test('applyOutcomes: reword replaces the question (layer, origin, tree kept; the old one dropped as reworded); not under sub-questions', () => {
    const parent = node('p', { a: 0.5, b: 0.5 }, { layer: 'macro', origin: '45' })
    const child = node('kid', { y: 0.5, n: 0.5 }, { given: { node_id: 'p', option: 'a' } })
    const nodes = [ceo(), parent, child]
    const list = numberedLive(nodes)
    const r = applyOutcomes({ changes: [
        { node: 1, verdict: 'reword', reasoning: 'ask who leads', new_option: null, probabilities: P({ outsider: 0.3, huang: 0.2, interim: 0.5 }),
            reworded: { question: 'Who leads Nvidia by Q1 2027?', options: [{ key: 'outsider', label: 'An outsider', signpost: 'a' }, { key: 'huang', label: 'Huang back', signpost: 'b' }, { key: 'interim', label: 'Still interim', signpost: 'c' }] } },
        { node: 2, verdict: 'reword', reasoning: 'r', new_option: null, probabilities: P({ a: 1, b: 1 }), reworded: { question: 'New p?', options: [{ key: 'a', label: 'A', signpost: '' }, { key: 'b', label: 'B', signpost: '' }] } },
    ] }, list, nodes, '2026-11-24')
    assert.equal(r.nodes.find(n => n.node_id === 'ceo').status, 'dropped')
    const made = r.nodes.find(n => n.question === 'Who leads Nvidia by Q1 2027?')
    assert.equal(made.split_from, 'ceo')
    assert.deepEqual([made.layer, made.origin, made.tree, made.resolve_by], ['macro', 'macro', 'tech', '2027-03-31'])
    assert.deepEqual(r.created, [made.node_id])
    assert.equal(r.dropped[0].reason, 'reworded')
    assert.match(r.dropped[0].note, /as "Who leads Nvidia/)
    assert.match(r.skipped[0].reason, /sub-questions hang under it/)
})

test('applyOutcomes: at most MAX_CHANGES changes', () => {
    const nodes = Array.from({ length: MAX_CHANGES + 2 }, (_, i) => node(`n${i}`, { a: 0.5, b: 0.5 }))
    const changes = nodes.map((_, i) => ({ node: i + 1, verdict: 'add_option', reasoning: 'r', new_option: { key: 'c', label: 'C', signpost: '' }, reworded: null, probabilities: P({ a: 1, b: 1, c: 1 }) }))
    assert.equal(applyOutcomes({ changes }, numberedLive(nodes), nodes, '2026-11-24').added.length, MAX_CHANGES)
})

test('reviewOutcomes: a failed call is a reason, never a throw; no live question, no call', async () => {
    let calls = 0
    setOutcomesIO({ payer: async () => null, system: () => 'S', call: async () => { calls++; throw new Error('overloaded') } })
    assert.match((await reviewOutcomes([ceo()], '2026-11-24')).reason, /overloaded/)
    assert.equal((await reviewOutcomes([], '2026-11-24')).ok, true)
    assert.equal(calls, 1)
})

test('the resolution check: a mismatch adds what happened and resolves to it, flagged; a full question resolves flagged; a fit is plain', () => {
    const nodes = [ceo(), node('full', { a: 0.25, b: 0.25, c: 0.25, d: 0.25 }), node('plain', { y: 0.5, n: 0.5 })]
    const list = numbered(nodes)
    const r = applyAnswer({ events: [
        ev({ decision: 'resolves', node: 1, resolution: { option: 'yes', evidence: 'Huang reinstated', fits: false, unforeseen: 'Huang returns' } }),
        ev({ decision: 'resolves', node: 3, resolution: { option: 'y', evidence: 'done', fits: true, unforeseen: null } }),
    ], signposts_fired: [], due: [{ node: 2, resolved: true, option: 'a', evidence: 'odd', new_resolve_by: null, fits: false, unforeseen: 'E' }] }, list, nodes, '2026-11-24')
    const c = r.nodes.find(n => n.node_id === 'ceo')
    assert.equal(c.status, 'resolved')
    assert.deepEqual([c.resolved.option, c.resolved.unforeseen], ['huang_returns', true])
    assert.equal(c.options.find(o => o.key === 'huang_returns').p, 1)
    assert.ok(r.needMap.has('ceo'), 'what happened is mapped to industries')
    const f = r.nodes.find(n => n.node_id === 'full')
    assert.deepEqual([f.resolved.option, f.resolved.unforeseen, f.options.length], ['a', true, 4])
    assert.equal(r.nodes.find(n => n.node_id === 'plain').resolved.unforeseen, false)
    assert.deepEqual(r.resolved.map(x => x.unforeseen), [true, false, true])
})

test('the update prompt shows what each option assumes', () => {
    const p = updatePrompt('2026-11-24', '2026-11-17', numbered([ceo()]), [], [], null, { names: new Map([['SOFT', 'Software'], ['SEMI', 'Semiconductors']]) })
    assert.match(p, /yes = Yes 60%; assumes: Software up, Semiconductors down/)
})

test('routing: the macro call\'s outside stories go to the sectors the network has, with their articles once', () => {
    const arts = [{ url: 'a1', title: 'Card cap' }, { url: 'a2', title: 'Wildfire' }]
    const res = { news: { articles: arts }, data: { events: [
        ev({ decision: 'outside', articles: [1], outside: { text: 'A 10% card rate cap', industries: ['card issuers'], sectors: ['40'] } }),
        ev({ decision: 'outside', articles: [2], outside: { text: 'Wildfire', industries: ['insurers'], sectors: ['40', '99'] } }),
        ev({ decision: 'none' }),
    ] } }
    const m = routeOutside(res, ['40'])
    assert.deepEqual([...m.keys()], ['40'])
    assert.deepEqual(m.get('40').map(x => x.text), ['A 10% card rate cap', 'Wildfire'])
    const w = withRouted([{ url: 'a2', title: 'Wildfire' }, { url: 's1', title: 'Bank news' }], m.get('40'))
    const dated = w.articles.map(x => ({ ...x, source: 'AP', published_at: '2026-11-23T10:00:00Z' }))
    assert.deepEqual(w.articles.map(a => a.url), ['a2', 's1', 'a1'])
    assert.deepEqual(w.routed.map(r => r.articles), [[3], [1]])
    assert.match(updatePrompt('2026-11-24', '2026-11-17', [], dated, [], 'SECTOR', { routed: w.routed }), /ROUTED FROM THE MACRO CALL \(2\)[\s\S]*- A 10% card rate cap \(articles 3\)/)
    assert.equal(routeOutside(undefined, ['40']).size, 0)
})

test('links: a NEW option is marked, and only links touching a new node or option are kept', async () => {
    const nodes = [node('a', { x: 0.5, y: 0.5 }), node('b', { up: 0.4, down: 0.4, new_one: 0.2 })]
    assert.match(linksPrompt(nodes, [], [{ node_id: 'b', option: 'new_one' }]), /new_one = new_one \(NEW option\)[\s\S]*NEW option \(an old question's other options/)
    setNetworkIO({ payer: async () => null, call: async () => ({ data: { links: [
        { from: { question: 2, option: 'new_one' }, to: { question: 1, option: 'x' }, direction: 'raises', strength: 'small', lag_days: { min: 0, max: 7 }, why: 'new' },
        { from: { question: 2, option: 'up' }, to: { question: 1, option: 'x' }, direction: 'raises', strength: 'small', lag_days: { min: 0, max: 7 }, why: 'old option' },
    ] } }) })
    const r = await linksFor(nodes, [], [{ node_id: 'b', option: 'new_one' }])
    assert.deepEqual(r.links.map(l => l.from.option), ['new_one'])
})

test('grading: a run whose forecast lacked the winning option owes one row at 0%, marked absent; the scorecard counts it', () => {
    const open = [
        { forecast_id: 'f1', run_id: 'r1', node_id: 'ceo', option: 'yes', p: 0.6, set_by: 'llm', layer: 'macro' }, { forecast_id: 'f2', run_id: 'r1', node_id: 'ceo', option: 'no', p: 0.4, set_by: 'llm', layer: 'macro' },
        { forecast_id: 'f3', run_id: 'r2', node_id: 'ceo', option: 'huang_returns', p: 0.2, set_by: 'llm', layer: 'macro' },
    ]
    const rows = absentRows(open, 'huang_returns', '2026-11-24')
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0].run_id, rows[0].p, rows[0].outcome, rows[0].brier, rows[0].absent], ['r1', 0, 1, 1, true])
    assert.deepEqual(absentRows(open, 'yes', '2026-11-24').map(r => r.run_id), ['r2'])
    assert.deepEqual(unforeseenCount([...rows, { node_id: 'ceo' }, { node_id: 'other' }]), { questions: 1, of: 2 })
})

test('the review card says an added outcome and a resolution not foreseen', () => {
    const c = { ...ceo(), status: 'resolved', resolved: { option: 'yes' } }
    const x = node('x', { a: 0.5, b: 0.3, c: 0.2 })
    const { lines } = cardLines({ run: { kind: 'weekly', as_of: '2026-11-24', stats: { unforeseen: ['ceo'], review: [{ node_id: 'ceo', option: 'yes', why: 'resolved' }, { node_id: 'x', option: 'c', why: 'outcome_added' }] } }, nodes: [c, x] })
    assert.match(lines[0], /Resolved: Does Nvidia .* → Yes \(NOT FORESEEN/)
    assert.match(lines[1], /Outcome added: Q x\? \+ "c"/)
})

test('runUpdate (weekly): the review adds an option, which is mapped, linked, logged and on the card; a failed review is a gap', async () => {
    const nodes = [ceo(), node('x', { a: 0.5, b: 0.5 })]
    const links = []
    const prev = { run: { run_id: 'run_1' }, state: { as_of: '2026-11-17', sections: { regime: [], policy: [], money: [], stories: [], prices: [], calendar: [] }, articles: [] },
        nodes: nodes.map(n => ({ ...n, anchor: anchorFor(nodes, links, n.node_id, '2026-11-17') })), links, dropped: { considered: 2, open: 2, settled: 0, dropped: [] },
        industries: [{ code: 'SEMI', name: 'Semiconductors', level: 'industry', p_win: 0.2, p_lose: 0.1 }] }
    let saved = null, linkArgs = null, seenNames = null
    _setIO({
        latest: async () => ({ run_id: 'run_1', as_of: '2026-11-17' }), read: async () => prev,
        news: async () => ({ articles: [], gaps: [] }), payer: async () => null, system: () => 'S',
        call: async () => ({ data: { events: [], signposts_fired: [], due: [] } }),
        outcomes: async (ns, asOf, names) => { seenNames = names; return { ok: true, list: numberedLive(ns), cost_usd: 0.3, data: { changes: [
            { node: 1, verdict: 'add_option', reasoning: 'lumped', new_option: { key: 'huang_returns', label: 'Huang returns', signpost: 'talks' }, reworded: null, probabilities: P({ yes: 0.4, no: 0.4, huang_returns: 0.2 }) }] } } },
        exposures: async () => ({ industries: [{ code: 'SEMI', name: 'Semiconductors', level: 'industry' }] }),
        map: async (ns) => ({ ok: true, cost_usd: 0, effects: new Map(ns.flatMap(n => n.options.map(o => [`${n.node_id}|${o.key}`, o.key === 'huang_returns' ? [{ code: 'SEMI', direction: 'up', bucket: 'large', why: 'relief' }] : o.effects]))) }),
        links: async (ns, ids, opts) => { linkArgs = { ids, opts }; return { ok: true, links: [], cost_usd: 0 } },
        data: async () => ({ sections: null, gaps: [] }), rewrite: async () => ({ ok: false, reason: 'stub', cost_usd: 0 }), sectorsOn: () => false,
        save: async (b) => { saved = b; const c = checkBundle(b); return c.ok ? { ok: true, run_id: 'run_2' } : c }, grade: async () => 0,
    })
    const r = await runUpdate({ kind: 'weekly', asOf: '2026-11-24' })
    assert.equal(r.ok, true, r.reason)
    assert.equal(seenNames.get('SEMI'), 'Semiconductors')
    const c = saved.nodes.find(n => n.node_id === 'ceo')
    assert.deepEqual(c.options.find(o => o.key === 'huang_returns').effects.map(e => e.code), ['SEMI'])
    assert.deepEqual(linkArgs, { ids: [], opts: [{ node_id: 'ceo', option: 'huang_returns' }] })
    assert.ok(saved.forecasts.some(f => f.node_id === 'ceo' && f.option === 'huang_returns'))
    assert.ok(r.stats.review.some(x => x.why === 'outcome_added' && x.option === 'huang_returns'))
    assert.equal(r.stats.outcomes.added.length, 1)
    _setIO({ outcomes: async () => ({ ok: false, reason: 'overloaded', cost_usd: 0 }) })
    const r2 = await runUpdate({ kind: 'weekly', asOf: '2026-11-24' })
    assert.ok(r2.stats.gaps.some(g => /missing-outcomes review did not run \(overloaded\)/.test(g)))
    // An event update runs no review.
    let asked = false
    _setIO({ outcomes: async () => { asked = true; return { ok: true, data: { changes: [] }, list: [], cost_usd: 0 } } })
    await runUpdate({ kind: 'event', trigger: 't', asOf: '2026-11-24' })
    assert.equal(asked, false)
})

test('runUpdate (event): the macro call runs first and its outside story reaches the sector call, reading no feed of its own', async () => {
    const sector = node('fin', { y: 0.5, n: 0.5 }, { layer: '40', origin: '40', tree: 'cards' })
    const nodes = [node('m', { a: 0.5, b: 0.5 }), sector]
    const ss = { sector: '40', as_of: '2026-11-17', sections: { backdrop: [], prices: [], news: [], policy: [], calendar: [] }, articles: [] }
    const prompts = []
    let sectorFeeds = 0
    _setIO({
        latest: async () => ({ run_id: 'run_1', as_of: '2026-11-17' }),
        read: async () => ({ run: { run_id: 'run_1' }, state: null, sector_states: [ss], nodes, links: [], dropped: { considered: 2, open: 2, settled: 0, dropped: [] }, industries: [] }),
        news: async () => ({ articles: [{ url: 'u1', title: 'Card rate cap proposed', source: 'AP', published_at: '2026-11-23T10:00:00Z', text: '' }], gaps: [] }),
        sectorNews: async () => { sectorFeeds++; return { articles: [], gaps: [] } }, names: async () => new Map(),
        sectorsOn: () => true, payer: async () => null, system: () => 'S',
        call: async (a) => {
            prompts.push(a.user)
            return { data: a.user.startsWith('SECTOR') ? { events: [], signposts_fired: [], due: [] }
                : { events: [ev({ decision: 'outside', articles: [1], outside: { text: 'A 10% card rate cap', industries: ['card issuers'], sectors: ['40'] } })], signposts_fired: [], due: [] } }
        },
        save: async (b) => ({ ok: true, run_id: 'run_2', b }), grade: async () => 0,
    })
    const r = await runUpdate({ kind: 'event', trigger: 'card cap', asOf: '2026-11-24', layers: ['macro'] })
    assert.equal(r.ok, true, r.reason)
    assert.equal(prompts.length, 2)
    assert.doesNotMatch(prompts[0], /^SECTOR/, 'the macro call first')
    assert.match(prompts[1], /^SECTOR: Financials[\s\S]*Card rate cap proposed[\s\S]*ROUTED FROM THE MACRO CALL \(1\)[\s\S]*A 10% card rate cap \(articles 1\)/)
    assert.equal(sectorFeeds, 0)
})

test('the update schema stays at its old shape plus outside sectors; the sectors are read as codes', () => {
    // The dev run of 2026-11-24 was refused: "The compiled grammar is too large". The old schema plus `outside.sectors`
    // fits (probed live); the resolution check did not, so it is its own call.
    const s = updateSchema()
    const ev = s.properties.events.items.properties
    assert.deepEqual(ev.resolution.anyOf[0].required, ['option', 'evidence'])
    assert.equal('fits' in s.properties.due.items.properties, false)
    assert.deepEqual(ev.outside.anyOf[0].properties.sectors, { type: 'array', items: { type: 'string' } })
    assert.deepEqual(sectorCodes(['45 Information Technology', '40', '99', 45, '40', null]), ['45', '40'])
    assert.deepEqual(sectorCodes(undefined), [])
})

test('withChecks: every resolution (resolves, DUE) gets the check; a failed check resolves by the label and names the gap', async () => {
    const nodes = [ceo(), node('b', { x: 0.5, y: 0.5 })]
    const list = numbered(nodes)
    const data = { events: [
        { decision: 'resolves', node: 1, resolution: { option: 'yes', evidence: 'Huang reinstated' } },
        { decision: 'moves_option', node: 2, resolution: null },
    ], signposts_fired: [], due: [{ node: 2, resolved: true, option: 'x', evidence: 'done', new_resolve_by: null }] }
    let seen = null
    const ok = await withChecks(data, list, '2026-11-24', new Map(), async (items) => { seen = items; return { ok: true, checks: [{ fits: false, unforeseen: 'Huang returns' }, { fits: true, unforeseen: null }], cost_usd: 0.02 } })
    assert.deepEqual(seen.map(i => [i.node.node_id, i.option]), [['ceo', 'yes'], ['b', 'x']])
    assert.deepEqual([ok.data.events[0].resolution.fits, ok.data.events[0].resolution.unforeseen], [false, 'Huang returns'])
    assert.deepEqual([ok.data.due[0].fits, ok.data.due[0].unforeseen], [true, null])
    assert.equal(ok.cost_usd, 0.02); assert.equal(ok.gap, null)
    assert.equal('fits' in data.events[0].resolution, false)   // the answer itself is not changed
    const applied = applyAnswer(ok.data, list, nodes, '2026-11-24')
    assert.deepEqual([applied.nodes[0].resolved.option, applied.nodes[0].resolved.unforeseen], ['huang_returns', true])
    const bad = await withChecks(data, list, '2026-11-24', new Map(), async () => ({ ok: false, reason: 'overloaded', cost_usd: 0 }))
    assert.equal(bad.data.events[0].resolution.fits, true)
    assert.match(bad.gap, /did not run \(overloaded\); 2 resolution/)
    let called = false
    const none = await withChecks({ events: [], signposts_fired: [], due: [] }, list, '2026-11-24', new Map(), async () => { called = true })
    assert.equal(called, false); assert.equal(none.gap, null)
})

test('checkResolutions: the prompt shows what each option assumes; answers are matched by item; unforeseen only when it does not fit', async () => {
    const n = ceo()
    const items = [{ node: n, option: 'yes', evidence: 'Huang reinstated' }, { node: n, option: 'no', evidence: 'x' }]
    const p = checkPrompt('2026-11-24', items, new Map([['SEMI', 'Semiconductors'], ['SOFT', 'Software']]))
    assert.match(p, /yes = Yes; assumes: Software up, Semiconductors down/)
    assert.match(p, /RESOLVED TO: yes\. Evidence: Huang reinstated/)
    assert.deepEqual(checkSchema().properties.checks.items.properties.unforeseen, { type: ['string', 'null'] })
    setOutcomesIO({ payer: async () => null, call: async () => ({ data: { checks: [{ item: 2, fits: true, unforeseen: 'ignored' }, { item: 1, fits: false, unforeseen: ' Huang returns ' }] } }) })
    const r = await checkResolutions(items, '2026-11-24')
    assert.deepEqual(r.checks, [{ fits: false, unforeseen: 'Huang returns' }, { fits: true, unforeseen: null }])
    setOutcomesIO({ call: async () => { throw new Error('boom') } })
    assert.equal((await checkResolutions(items, '2026-11-24')).ok, false)
    assert.deepEqual(await checkResolutions([], '2026-11-24'), { ok: true, checks: [], cost_usd: 0 })
})

const fu = (over = {}) => ({ node: 1, reasoning: 'who leads moves the chip stocks differently', verdict: 'follow_up', new_option: null, reworded: null,
    follow_up: { under_option: 'yes', question: 'Who becomes Nvidia CEO?', options: [{ key: 'insider', label: 'An insider', signpost: 's' }, { key: 'outsider', label: 'An outsider', signpost: 's' }], resolve_by: '2027-06-30' },
    probabilities: P({ insider: 0.7, outsider: 0.3 }), ...over })

test('applyOutcomes follow_up: hangs under the option (given), conditional odds, its own date, mapped and linked as new', () => {
    const nodes = [ceo()]
    const r = applyOutcomes({ changes: [fu()] }, numberedLive(nodes), nodes, '2026-11-24')
    assert.equal(r.skipped.length, 0)
    const child = r.nodes.find(n => n.node_id !== 'ceo')
    assert.deepEqual([child.given, child.question, child.resolve_by, child.tree, child.layer], [{ node_id: 'ceo', option: 'yes' }, 'Who becomes Nvidia CEO?', '2027-06-30', 'tech', 'macro'])
    assert.deepEqual(child.options.map(o => [o.key, o.p]), [['insider', 0.7], ['outsider', 0.3]])
    assert.deepEqual(r.followUps.map(f => [f.parent, f.option]), [['ceo', 'yes']])
    assert.deepEqual([r.created, [...r.needMap], [...r.rejudged]], [[child.node_id], [child.node_id], [child.node_id]])
    // a date in the past falls back to the parent's
    const r2 = applyOutcomes({ changes: [fu({ follow_up: { ...fu().follow_up, resolve_by: '2026-01-01' } })] }, numberedLive(nodes), nodes, '2026-11-24')
    assert.equal(r2.nodes.at(-1).resolve_by, '2027-03-31')
})

test('applyOutcomes follow_up: skipped two levels down, under an unlikely option, twice under one option, or under no option', () => {
    const base = ceo()
    const kid = node('kid', { a: 0.5, b: 0.5 }, { given: { node_id: 'ceo', option: 'yes' } })
    const run = (nodes, c) => applyOutcomes({ changes: [c] }, numberedLive(nodes), nodes, '2026-11-24').skipped.map(s => s.reason)
    assert.match(run([kid, base], fu())[0], /two levels at most/)                                     // node 1 is the child
    assert.match(run([base], fu({ follow_up: { ...fu().follow_up, under_option: 'maybe' } }))[0], /no option "maybe"/)
    const unlikely = node('ceo', { yes: 0.1, no: 0.9 })
    assert.match(run([unlikely], fu())[0], new RegExp(`under ${Math.round(FOLLOW_UP_MIN_P * 100)}%`))
    assert.deepEqual(run([{ ...unlikely, woken: [{ option: 'yes', evidence: 'x' }] }], fu()), [], 'a fired signpost is enough')
    assert.match(run([base, kid], fu())[0], /hangs under "Yes" already/)
})

test('dropOrphans: a follow-up whose parent resolved another way (or left) is dropped with what hangs under it; its own way it stands', () => {
    const parent = ceo()
    const kid = node('kid', { a: 0.5, b: 0.5 }, { given: { node_id: 'ceo', option: 'yes' } })
    const grand = node('grand', { a: 0.5, b: 0.5 }, { given: { node_id: 'kid', option: 'a' } })
    const no = dropOrphans(resolve([parent, kid, grand], 'ceo', 'no'))
    assert.deepEqual(no.dropped.map(d => d.node.node_id), ['kid', 'grand'])
    assert.deepEqual(no.nodes.map(n => n.status), ['resolved', 'dropped', 'dropped'])
    const yes = dropOrphans(resolve([parent, kid], 'ceo', 'yes'))
    assert.deepEqual([yes.dropped, yes.nodes[1].status], [[], 'live'])
    assert.deepEqual(dropOrphans([kid]).dropped.map(d => [d.node.node_id, d.parent]), [['kid', null]])
    assert.deepEqual(dropOrphans([parent, kid]).dropped, [], 'parent live: nothing')
})

test('runUpdate: the review\'s follow-up is listed as a follow-up (not new); a resolved parent drops its other-branch follow-up as parent_resolved', async () => {
    const parent = ceo()
    const kid = node('kid', { a: 0.5, b: 0.5 }, { given: { node_id: 'ceo', option: 'no' }, question: 'What does the interim CEO do?' })
    let saved = null
    _setIO({
        latest: async () => ({ run_id: 'r0', as_of: '2026-11-17' }),
        read: async () => ({ run: { stats: {} }, nodes: [parent, kid], links: [], industries: [], dropped: { dropped: [] }, state: null, sector_states: [] }),
        news: async () => ({ articles: [{ title: 'Huang named CEO again', url: 'u', published_at: '2026-11-23T00:00:00Z', source: 's' }], gaps: [] }),
        payer: async () => null, sectorsOn: () => false, data: async () => ({ sections: null, gaps: [] }),
        call: async () => ({ data: { events: [ev({ decision: 'resolves', node: 1, resolution: { option: 'yes', evidence: 'Huang named' } })], signposts_fired: [], due: [] } }),
        check: async (items) => ({ ok: true, checks: items.map(() => ({ fits: true, unforeseen: null })), cost_usd: 0 }),
        outcomes: async () => ({ ok: true, data: { changes: [] }, list: [], cost_usd: 0 }),
        exposures: async () => ({ industries: [] }), map: async () => ({ ok: true, effects: new Map(), cost_usd: 0 }),
        links: async () => ({ links: [], cost_usd: 0 }),
        save: async (b) => { saved = b; return { ok: true, run_id: 'r1' } }, grade: async () => {},
    })
    const r = await runUpdate({ kind: 'event', trigger: 't', asOf: '2026-11-24' })
    assert.equal(r.ok, true, r.reason)
    assert.equal(saved.nodes.some(n => n.node_id === 'kid'), false)
    const d = saved.dropped.dropped.find(x => x.reason === 'parent_resolved')
    assert.match(d.note, /resolved to "Yes" on 2026-11-24, not "No"/)
})

test('the review prompt marks a follow-up with what it hangs under', () => {
    const kid = node('kid', { a: 0.5, b: 0.5 }, { given: { node_id: 'ceo', option: 'yes' }, question: 'Who becomes CEO?' })
    const p = outcomesPrompt('2026-11-24', numberedLive([ceo(), kid]))
    assert.match(p, /2\. \[Macro · tech\] Who becomes CEO\? \(follow-up of 1, if Yes\)/)
    assert.equal(outcomesSchema().properties.changes.items.properties.verdict.enum.includes('follow_up'), true)
})
