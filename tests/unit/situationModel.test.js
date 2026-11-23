import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    checkItem, checkState, checkNode, checkLink, checkDropped, checkIndustry, checkForecast, checkOutside, checkRun, checkLag,
    SECTIONS, SETTLED_AT,
} from '../../services/situation/model.js'
import { checkBundle, saveRun, latestRun, readRun, _resetIndexes, COLLECTIONS } from '../../services/situation/store.js'

const item = (over = {}) => ({ text: '10-year at 4.6%, rising since September', value: 4.6, as_of: '2024-12-31', source: 'FRED DGS10', tag: 'fact', ...over })
const emptySections = () => Object.fromEntries(SECTIONS.map(s => [s, []]))
const node = (over = {}) => ({
    node_id: 'n_broad', tree: 'T1', question: 'How broad are the tariffs?',
    options: [{ key: 'threats', label: 'Mostly threats', p: 0.3 }, { key: 'china', label: 'China-targeted', p: 0.45 }, { key: 'broad', label: 'Broad', p: 0.25 }],
    lag: { min: 0, max: 60 }, ...over,
})
const settled = (over = {}) => node({
    node_id: 'n_q1', question: 'Tariffs announced in Q1?',
    options: [{ key: 'yes', label: 'Yes', p: 0.85 }, { key: 'no', label: 'No', p: 0.15, signpost: 'no tariff order by 1 Feb' }], ...over,
})

// ── items and the state ──

test('an item needs text, a real as_of, a source and a fact/reading tag', () => {
    assert.equal(checkItem(item()).ok, true)
    assert.match(checkItem(item({ source: '' })).reason, /source/)
    assert.match(checkItem(item({ as_of: '2024-13-01' })).reason, /as_of/)
    assert.match(checkItem(item({ tag: 'opinion' })).reason, /fact or reading/)
    assert.match(checkItem(item({ value: 'high' })).reason, /number/)
    assert.equal(checkItem(item({ value: null })).value.value, null)
})

test('a state needs every section; nothing in it may be dated after its as_of', () => {
    const sections = emptySections(); sections.regime = [item()]
    assert.equal(checkState({ as_of: '2024-12-31', sections }).ok, true)
    const missing = emptySections(); delete missing.calendar
    assert.match(checkState({ as_of: '2024-12-31', sections: missing }).reason, /calendar is missing/)
    const late = emptySections(); late.policy = [item({ as_of: '2025-01-02', tag: 'reading' })]
    assert.match(checkState({ as_of: '2024-12-31', sections: late }).reason, /after the state's as_of/)
    const art = { as_of: '2024-12-31', sections: emptySections(), articles: [{ url: 'https://x', title: 'Later news', published_at: '2025-01-03T10:00:00Z' }] }
    assert.match(checkState(art).reason, /published after/)
})

// ── nodes ──

test('open or settled is derived from the numbers, not declared', () => {
    assert.equal(checkNode(node()).value.kind, 'open')
    const s = checkNode(settled()).value
    assert.equal(s.kind, 'settled')
    assert.deepEqual(s.options.map(o => o.dormant), [false, true])
    assert.equal(checkNode(node({ kind: 'settled' })).value.kind, 'open', 'a declared kind is ignored')
    assert.equal(SETTLED_AT, 0.8)
})

test("a settled node's dormant branch needs a signpost", () => {
    const r = checkNode(settled({ options: [{ key: 'yes', label: 'Yes', p: 0.85 }, { key: 'no', label: 'No', p: 0.15 }] }))
    assert.match(r.reason, /dormant option no needs a signpost/)
})

test('options: 2–4, distinct snake keys, each 0–1, summing to 1', () => {
    assert.match(checkNode(node({ options: [{ key: 'a', label: 'A', p: 1 }] })).reason, /2–4 options/)
    assert.match(checkNode(node({ options: [{ key: 'A b', label: 'x', p: 0.5 }, { key: 'c', label: 'y', p: 0.5 }] })).reason, /lower_snake/)
    assert.match(checkNode(node({ options: [{ key: 'a', label: 'x', p: 0.5 }, { key: 'a', label: 'y', p: 0.5 }] })).reason, /distinct/)
    assert.match(checkNode(node({ options: [{ key: 'a', label: 'x', p: 0.5 }, { key: 'b', label: 'y', p: 0.4 }] })).reason, /sum to 0.900/)
    assert.match(checkNode(node({ options: [{ key: 'a', label: 'x', p: 1.2 }, { key: 'b', label: 'y', p: -0.2 }] })).reason, /between 0 and 1/)
    assert.equal(checkNode(node({ options: [{ key: 'a', label: 'x', p: 0.333 }, { key: 'b', label: 'y', p: 0.333 }, { key: 'c', label: 'z', p: 0.334 }] })).ok, true)
})

test('a resolved node names the option that happened, its evidence and date', () => {
    const r = { status: 'resolved', resolved: { option: 'yes', evidence: 'Orders signed 1 Feb 2025', on: '2025-02-01' } }
    assert.equal(checkNode(settled(r)).value.resolved.by, 'llm')
    assert.match(checkNode(settled({ ...r, resolved: { ...r.resolved, option: 'maybe' } })).reason, /names the option/)
    assert.match(checkNode(settled({ ...r, resolved: { ...r.resolved, evidence: '' } })).reason, /evidence/)
})

test("the review baseline keeps Roy's numbers per option (the drift rule)", () => {
    const v = checkNode(node({ review: { on: '2025-01-21', p: { threats: 0.32, china: 0.4, broad: 0.28 } } })).value
    assert.deepEqual(v.review, { on: '2025-01-21', p: { threats: 0.32, china: 0.4, broad: 0.28 } })
    assert.match(checkNode(node({ review: { on: '2025-01-21', p: { nope: 0.5 } } })).reason, /review\.p\.nope/)
    assert.equal(checkNode(node()).value.review, null)
})

test('lags are whole days, min ≤ max', () => {
    assert.equal(checkLag({ min: 0, max: 28 }).ok, true)
    assert.match(checkLag({ min: 30, max: 7 }).reason, /min must not exceed/)
    assert.match(checkLag({ min: 1.5, max: 7 }).reason, /whole days/)
    assert.equal(checkLag(null).value, null)
})

// ── links ──

test('a link runs from a branch to an option of ANOTHER node, with a bounded log-odds shift', () => {
    const nodes = new Map([[node().node_id, checkNode(node()).value], ['n_infl', checkNode(node({ node_id: 'n_infl', tree: 'T2', question: 'Inflation?', options: [{ key: 'falls', label: 'F', p: 0.35 }, { key: 'stuck', label: 'S', p: 0.45 }, { key: 'rises', label: 'R', p: 0.2 }] })).value]])
    const link = { from: { node_id: 'n_broad', option: 'broad' }, to: { node_id: 'n_infl', option: 'rises' }, shift: 0.8 }
    assert.equal(checkLink(link, nodes).ok, true)
    assert.match(checkLink({ ...link, to: { node_id: 'n_broad', option: 'china' } }).reason, /two different nodes/)
    assert.match(checkLink({ ...link, shift: 0 }).reason, /non-zero/)
    assert.match(checkLink({ ...link, shift: 5 }).reason, /at most 3/)
    assert.match(checkLink({ ...link, from: { node_id: 'n_broad', option: 'sector' } }, nodes).reason, /no such branch/)
    assert.match(checkLink({ ...link, to: { node_id: 'n_gone', option: 'rises' } }, nodes).reason, /no such option/)
})

// ── the dropped list, industries, forecasts, outside events, runs ──

test('the dropped list: counts add up; every drop has a reason; a duplicate names its twin', () => {
    const d = { considered: 5, open: 2, settled: 1, dropped: [{ question: 'DOGE cuts?', reason: 'low_impact' }, { question: 'Trump trades run on?', reason: 'duplicate', duplicate_of: 'n_broad' }] }
    assert.equal(checkDropped(d).ok, true)
    assert.match(checkDropped({ ...d, considered: 6 }).reason, /do not add up/)
    assert.match(checkDropped({ ...d, dropped: [{ question: 'x', reason: 'boring' }] }).reason, /reason must be/)
    assert.match(checkDropped({ ...d, dropped: [{ question: 'x', reason: 'duplicate' }] }).reason, /names the node/)
})

test('an industry: chances in 0–1, win + lose ≤ 1, a known bucket', () => {
    const i = { code: '15104030', name: 'Gold', p_win: 0.7, p_lose: 0.1, bucket: 'large', agreement: 0.8 }
    assert.equal(checkIndustry(i).ok, true)
    assert.match(checkIndustry({ ...i, p_lose: 0.4 }).reason, /exceed 1/)
    assert.match(checkIndustry({ ...i, bucket: 'huge' }).reason, /bucket/)
})

test("a forecast: Roy's override keeps the model's number", () => {
    assert.equal(checkForecast({ node_id: 'n', option: 'yes', p: 0.85, set_by: 'llm', resolve_by: '2025-03-31' }).ok, true)
    assert.match(checkForecast({ node_id: 'n', option: 'yes', p: 0.7, set_by: 'roy' }).reason, /llm_p/)
    assert.equal(checkForecast({ node_id: 'n', option: 'yes', p: 0.7, set_by: 'roy', llm_p: 0.85 }).value.llm_p, 0.85)
})

test('an outside event names the industry it hits', () => {
    assert.equal(checkOutside({ text: 'LA wildfires', date: '2025-01-10', industries: ['Property & Casualty Insurance'] }).ok, true)
    assert.match(checkOutside({ text: 'LA wildfires', date: '2025-01-10', industries: [] }).reason, /names the industry/)
})

test('a run: a known kind and date; an event run names its trigger', () => {
    assert.equal(checkRun({ kind: 'weekly', as_of: '2025-01-07' }).ok, true)
    assert.match(checkRun({ kind: 'daily', as_of: '2025-01-07' }).reason, /run kind/)
    assert.match(checkRun({ kind: 'event', as_of: '2025-02-01' }).reason, /trigger/)
})

// ── the store ──

function fakeDb() {
    const colls = new Map()
    const coll = (name) => {
        if (!colls.has(name)) {
            const rows = []
            const match = (r, q) => Object.entries(q).every(([k, v]) => r[k] === v)
            colls.set(name, {
                rows,
                createIndex: async () => {},
                insertOne: async (d) => { rows.push(structuredClone(d)) },
                insertMany: async (ds) => { for (const d of ds) rows.push(structuredClone(d)) },
                updateOne: async (q, u) => { const r = rows.find(x => match(x, q)); if (r) Object.assign(r, u.$set) },
                findOne: async (q) => rows.find(x => match(x, q)) ?? null,
                find: (q) => {
                    let out = rows.filter(x => match(x, q))
                    const cur = {
                        sort: (s) => { const [[k, dir]] = Object.entries(s); out = [...out].sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0)); return cur },
                        limit: (n) => { out = out.slice(0, n); return cur },
                        next: async () => out[0] ?? null,
                        toArray: async () => out,
                    }
                    return cur
                },
            })
        }
        return colls.get(name)
    }
    return { collection: coll, colls }
}

const bundle = (over = {}) => {
    const sections = emptySections(); sections.regime = [item()]
    return {
        run: { kind: 'build', as_of: '2024-12-31' },
        state: { as_of: '2024-12-31', sections },
        nodes: [node(), settled()],
        links: [{ from: { node_id: 'n_q1', option: 'yes' }, to: { node_id: 'n_broad', option: 'broad' }, shift: 0.3 }],
        dropped: { considered: 3, open: 1, settled: 1, dropped: [{ question: 'DOGE cuts?', reason: 'low_impact' }] },
        industries: [{ code: '15104030', name: 'Gold', p_win: 0.7, p_lose: 0.1 }],
        forecasts: [{ node_id: 'n_broad', option: 'broad', p: 0.25, set_by: 'llm', resolve_by: '2025-03-31' }],
        ...over,
    }
}

test('checkBundle: the first bad record fails the whole run, and says where', () => {
    assert.equal(checkBundle(bundle()).ok, true)
    assert.match(checkBundle(bundle({ nodes: [node(), node()] })).reason, /share an id/)
    assert.match(checkBundle(bundle({ links: [{ from: { node_id: 'n_q1', option: 'maybe' }, to: { node_id: 'n_broad', option: 'broad' }, shift: 0.3 }] })).reason, /^link: .*no such branch/)
})

test('saveRun writes the run whole, stamps every record, then marks it complete; readRun reads it back', async () => {
    _resetIndexes()
    const db = fakeDb()
    const deps = { db: async () => db, now: () => '2024-12-31T22:00:00Z' }
    const r = await saveRun(bundle(), deps)
    assert.equal(r.ok, true)
    const back = await readRun(r.run_id, deps)
    assert.equal(back.run.complete, true)
    assert.equal(back.nodes.length, 2)
    assert.ok(back.nodes.every(n => n.run_id === r.run_id))
    assert.equal(back.links[0].from.node_id, 'n_q1')
    assert.equal(back.dropped.dropped.length, 1)
    assert.equal(db.colls.get(COLLECTIONS.forecasts).rows[0].run_id, r.run_id)
    assert.equal((await latestRun(deps)).run_id, r.run_id)
})

test('a bad bundle writes nothing; an incomplete run is invisible to readers', async () => {
    _resetIndexes()
    const db = fakeDb()
    const deps = { db: async () => db, now: () => '2025-01-07T22:00:00Z' }
    const r = await saveRun(bundle({ dropped: { considered: 9, open: 1, settled: 1, dropped: [] } }), deps)
    assert.equal(r.ok, false)
    assert.equal(db.colls.size, 0, 'nothing touched the database')
    await db.collection(COLLECTIONS.runs).insertOne({ run_id: 'run_half', kind: 'weekly', as_of: '2025-01-07', complete: false })
    assert.equal(await latestRun(deps), null)
    assert.equal(await readRun('run_half', deps), null)
})
