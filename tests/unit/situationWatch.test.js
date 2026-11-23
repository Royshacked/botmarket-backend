import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dueKind, triagePrompt, tick, _setIO, WATCH } from '../../services/situation/watch.js'
import { cardLines, postReviewCard, overrideNode, _setIO as setReviewIO } from '../../services/situation/review.js'
import { checkBundle, COLLECTIONS } from '../../services/situation/store.js'
import { anchorFor } from '../../services/situation/propagate.js'

const node = (node_id, opts, over = {}) => ({ node_id, tree: 't', question: `Q ${node_id}?`, status: 'live', kind: 'open', impact: 'high', given: null, review: null, woken: [], resolve_by: '2025-03-31',
    options: Object.entries(opts).map(([key, p]) => ({ key, label: key, p, signpost: `sign ${key}`, dormant: false, effects: [{ code: 'G', direction: key === 'a' ? 'up' : 'down', bucket: 'medium' }] })), ...over })

test('dueKind: build first; a 28-day-old build rebuilds; a week-old run updates; else the watch', () => {
    assert.equal(dueKind(null, null, '2025-01-07'), 'build')
    assert.equal(dueKind({ as_of: '2025-01-02' }, '2024-12-10', '2025-01-07'), 'rebuild')
    assert.equal(dueKind({ as_of: '2024-12-31' }, '2024-12-31', '2025-01-07'), 'weekly')
    assert.equal(dueKind({ as_of: '2025-01-05' }, '2024-12-31', '2025-01-07'), 'watch')
})

test('the triage prompt lists the live questions with their dormant signposts', () => {
    const p = triagePrompt([{ n: 1, node: { question: 'Tariffs in Q1?', options: [{ label: 'yes', p: 0.85 }, { label: 'no', p: 0.15, dormant: true, signpost: 'no order by 1 Feb' }] } }], [])
    assert.match(p, /1\. Tariffs in Q1\? — yes 85%; no 15% \(dormant: no order by 1 Feb\)/)
})

function fakeDb(runs = []) {
    const store = { [WATCH]: [], [COLLECTIONS.runs]: runs }
    const coll = (name) => ({
        findOne: async (q) => (store[name] ?? []).find(d => d._id === q._id) ?? null,
        updateOne: async (q, u) => { const arr = store[name] ??= []; let d = arr.find(x => x._id === q._id); if (!d) { d = { _id: q._id }; arr.push(d) } Object.assign(d, u.$set) },
        find: (q) => { let out = (store[name] ?? []).filter(r => !q.kind || q.kind.$in.includes(r.kind)); const c = { sort: () => c, limit: () => c, next: async () => out[0] ?? null, toArray: async () => out }; return c },
    })
    return { collection: coll, store }
}

test('tick: off unless SITUATION_NETWORK; the first build; then the weekly; each run posts its card', async () => {
    const keep = process.env.SITUATION_NETWORK
    try {
        delete process.env.SITUATION_NETWORK
        assert.deepEqual(await tick(), { off: true })
        process.env.SITUATION_NETWORK = 'true'
        const cards = [], did = []
        _setIO({ now: () => new Date('2025-01-07T12:00:00Z'), db: async () => fakeDb(), latest: async () => null,
            build: async (o) => { did.push(o.kind); return { ok: true, run_id: 'r1' } }, card: async (id) => cards.push(id) })
        assert.equal((await tick()).did, 'build')
        _setIO({ latest: async () => ({ run_id: 'r1', as_of: '2024-12-31' }), db: async () => fakeDb([{ kind: 'build', as_of: '2024-12-31', complete: true }]),
            update: async (o) => { did.push(o.kind); return { ok: true, run_id: 'r2' } } })
        assert.equal((await tick()).did, 'weekly')
        assert.deepEqual(did, ['build', 'weekly'])
        assert.deepEqual(cards, ['r1', 'r2'])
    } finally { if (keep === undefined) delete process.env.SITUATION_NETWORK; else process.env.SITUATION_NETWORK = keep }
})

test('tick: the watch — new articles to triage; material news is one event update a day, inside the budget', async () => {
    const keep = process.env.SITUATION_NETWORK
    try {
        process.env.SITUATION_NETWORK = 'true'
        const db = fakeDb([{ kind: 'build', as_of: '2025-01-05', complete: true }])
        let updates = 0, triaged = 0
        _setIO({
            now: () => new Date('2025-01-07T12:00:00Z'), db: async () => db, latest: async () => ({ run_id: 'r1', as_of: '2025-01-05' }),
            read: async () => ({ nodes: [node('a', { a: 0.5, b: 0.5 })] }),
            policy: async () => [], fmpNews: async () => [{ title: 'Big tariff news', date: '2025-01-07', url: 'https://n/1' }],
            payer: async () => null, call: async () => { triaged++; return { data: { material: true, why: 'tariffs signed', articles: [1] } } },
            update: async (o) => { updates++; assert.equal(o.kind, 'event'); return { ok: true, run_id: 'r2' } }, card: async () => {}, budget: () => 10,
        })
        assert.equal((await tick()).did, 'event')
        _setIO({ now: () => new Date('2025-01-07T16:00:00Z'), fmpNews: async () => [{ title: 'More news', date: '2025-01-07', url: 'https://n/2' }] })
        assert.equal((await tick()).waiting, 'one event update a day')
        _setIO({ now: () => new Date('2025-01-07T20:00:00Z'), fmpNews: async () => [{ title: 'More news', date: '2025-01-07', url: 'https://n/2' }] })
        assert.deepEqual(await tick(), { did: 'watch', articles: 0 }, 'already seen')
        _setIO({ now: () => new Date('2025-01-07T18:00:00Z') })
        assert.deepEqual(await tick(), { did: 'nothing' }, 'inside three hours of the last look')
        assert.equal(updates, 1)
        assert.equal(triaged, 2)
    } finally { if (keep === undefined) delete process.env.SITUATION_NETWORK; else process.env.SITUATION_NETWORK = keep }
})

// ── the review ──

test('cardLines: the first build lists every open node; an update lists its review items', () => {
    const nodes = [node('a', { a: 0.5, b: 0.5 }), node('s', { a: 0.9, b: 0.1 }, { kind: 'settled' })]
    const b = cardLines({ run: { kind: 'build', as_of: '2025-01-07' }, nodes })
    assert.equal(b.lines.length, 1)
    assert.match(b.title, /1 open questions to review/)
    const u = cardLines({ run: { kind: 'event', trigger: 'tariffs signed', as_of: '2025-02-01', stats: { review: [{ node_id: 'a', why: 'moved', by: 0.15 }, { node_id: 's', option: 'b', why: 'woken' }] } }, nodes })
    assert.match(u.title, /^Event update: tariffs signed \(2025-02-01\): 2 to review/)
    assert.match(u.lines[0], /Q a\? \(moved, 15 pts\) — a 50% \/ b 50%/)
    assert.match(u.lines[1], /EARLY WARNING/)
})

test('postReviewCard: to Roy only when he is on the allow-list; nothing to review, no card', async () => {
    const keep = process.env.SITUATION_USERS
    try {
        process.env.SITUATION_USERS = 'roy'
        const posted = []
        setReviewIO({ read: async () => ({ run: { kind: 'build', as_of: '2025-01-07' }, nodes: [node('a', { a: 0.5, b: 0.5 })], industries: [{ name: 'Gold', p_win: 0.7, p_lose: 0.1 }] }),
            roy: async () => 'roy', post: async (c) => { posted.push(c); return c } })
        await postReviewCard('r1')
        assert.equal(posted[0].userId, 'roy')
        assert.equal(posted[0].botId, 'axl')
        assert.match(posted[0].content, /Industry calls \(≥ 60%\): Gold wins 70%/)
        process.env.SITUATION_USERS = 'marce'
        assert.equal(await postReviewCard('r1'), null)
    } finally { if (keep === undefined) delete process.env.SITUATION_USERS; else process.env.SITUATION_USERS = keep }
})

test("overrideNode: Roy's numbers, renormalised, logged beside the model's, spread, saved as a valid new run", async () => {
    const keep = process.env.SITUATION_USERS
    try {
        process.env.SITUATION_USERS = 'roy'
        const nodes = [node('a', { a: 0.5, b: 0.5 }), node('t', { a: 0.5, b: 0.5 })]
        const links = [{ link_id: 'L', from: { node_id: 'a', option: 'a' }, to: { node_id: 't', option: 'a' }, shift: 1, live: true }]
        const anchored = nodes.map(n => ({ ...n, anchor: anchorFor(nodes, links, n.node_id, '2025-01-07') }))
        let saved = null
        setReviewIO({ latest: async () => ({ run_id: 'r1', as_of: '2025-01-07' }), now: () => new Date('2025-01-08T10:00:00Z'),
            read: async () => ({ run: { run_id: 'r1' }, state: null, nodes: anchored, links, dropped: { considered: 2, open: 2, settled: 0, dropped: [] }, industries: [{ code: 'G', name: 'Gold', level: 'industry', p_win: 0.5, p_lose: 0.5 }] }),
            save: async (b) => { saved = b; const c = checkBundle(b); return c.ok ? { ok: true, run_id: 'r2' } : c } })
        const r = await overrideNode('a', { a: 3, b: 1 }, 'roy')
        assert.equal(r.ok, true, r.reason)
        const a = saved.nodes.find(n => n.node_id === 'a')
        assert.equal(a.set_by, 'roy')
        assert.equal(a.options[0].p, 0.75)
        assert.ok(saved.nodes.find(n => n.node_id === 't').options[0].p > 0.5, 'the link carried it')
        assert.deepEqual(saved.forecasts.map(f => [f.p, f.llm_p, f.set_by]), [[0.75, 0.5, 'roy'], [0.25, 0.5, 'roy']])
        assert.equal((await overrideNode('a', { a: 1 }, 'someone')).reason, 'not allowed')
        assert.match((await overrideNode('zzz', { a: 1 }, 'roy')).reason, /no live node/)
    } finally { if (keep === undefined) delete process.env.SITUATION_USERS; else process.env.SITUATION_USERS = keep }
})
