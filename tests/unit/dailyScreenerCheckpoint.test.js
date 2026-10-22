import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import {
    runCheckpoint, dueCheckpoint, buildPool, structureNames, boardRow, rankRows, BOARDS, CHECKPOINTS,
} from '../../services/dailyScreener.checkpoint.js'
import { COLLECTION as STATS } from '../../services/dailyScreener.service.js'
import { _tick } from '../../monitoring/dailyScreener.monitor.service.js'

// The hotlist's CHECKPOINT pass (docs/design/daily-names.md §5–§6, build phase 3): the pool, quoted
// and graded at each checkpoint, one board each. Same switch and same 429 rule as the overnight pass.

// ─── When ─────────────────────────────────────────────────────────────────────

test('checkpoints: inside a window → that one; outside every window, or a weekend → none', () => {
    // 2026-10-21 is a Wednesday, EDT (ET = UTC-4).
    assert.equal(dueCheckpoint(Date.parse('2026-10-21T12:05:00Z')).checkpoint.id, 'premarket', '08:05 ET')
    assert.equal(dueCheckpoint(Date.parse('2026-10-21T13:25:00Z')).checkpoint.id, 'preopen', '09:25 ET')
    assert.equal(dueCheckpoint(Date.parse('2026-10-21T14:31:00Z')).checkpoint.id, 'mid')
    assert.equal(dueCheckpoint(Date.parse('2026-10-21T19:35:00Z')).checkpoint.id, 'close', '15:35 ET')
    assert.equal(dueCheckpoint(Date.parse('2026-10-21T16:00:00Z')), null, 'noon ET — no checkpoint')
    assert.equal(dueCheckpoint(Date.parse('2026-10-21T15:05:00Z')), null, '11:05 ET — 10:30 missed by more than its window')
    assert.equal(dueCheckpoint(Date.parse('2026-10-24T12:05:00Z')), null, 'Saturday')
    assert.deepEqual(CHECKPOINTS.map(c => c.id), ['premarket', 'preopen', 'mid', 'eod', 'close'])
})

// ─── The pool ─────────────────────────────────────────────────────────────────

test('pool: catalysts first, only names with overnight stats, capped', () => {
    const have = new Set(['A', 'B', 'C', 'D', 'E'])
    const pool = buildPool({
        earnings: new Set(['B']), news: ['A', 'B', 'NOSTATS'], grades: new Set(['C']), movers: new Set(['D']), structure: ['E', 'A'],
    }, have)
    assert.deepEqual(pool, ['B', 'A', 'C', 'D', 'E'])
    assert.deepEqual(buildPool({ news: ['A', 'B', 'C'] }, have, 2), ['A', 'B'])
})

test('structure names: compression or near the 20-day high, liquid, biggest first', () => {
    const out = structureNames([
        { symbol: 'NR', nr7: true, adv20_usd: 30e6, close: 50, high20: 60 },
        { symbol: 'HI', close: 59.5, high20: 60, adv20_usd: 90e6 },
        { symbol: 'THIN', nr7: true, adv20_usd: 5e6 },
        { symbol: 'NONE', close: 40, high20: 60, adv20_usd: 200e6 },
    ])
    assert.deepEqual(out, ['HI', 'NR'])
})

// ─── A row ────────────────────────────────────────────────────────────────────

const S = { symbol: 'ABC', name: 'Abc', close: 100, atr14: 4, atr_pct: 4, adv20_usd: 100e6, avg_vol20: 1_000_000,
    day_high: 101, high5: 103, high20: 106, high50: 110, high52w: 120, rs20: 3, nr7: true, next_earnings: '2026-10-27' }

test('pre-market row: price is the book\'s midpoint, gap against last night\'s close, volume as % of a day', () => {
    const row = boardRow(S, { mid: 104, spreadPct: 0.02, volume: 30_000 }, ['open', 'week'], { book: 'extended', etMin: 480, day: '2026-10-21', catalyst: null })
    assert.equal(row.gap_pct, 4)
    assert.equal(row.pm_vol_pct, 3)
    assert.equal(row.cells.open.grade, 'B')
    // In play for the week (earnings in 6 days, NR7, RS +3) — but the 20-day high is 2 points above a
    // 4-point ATR: 0.5×, under the week's 1.5× bar for a B.
    assert.equal(row.cells.week.grade, 'C')
    assert.equal(row.cells.week.range.level, 106)
})

test('a name no column grades is not a row', () => {
    assert.equal(boardRow(S, { mid: 100.2, spreadPct: 0.02, volume: 100 }, ['open'], { book: 'extended', etMin: 480, day: '2026-10-21' }), null)
})

test('a minor story under a big gap is flagged a fade candidate (§3 "priced in?")', () => {
    const row = boardRow(S, { mid: 108, spreadPct: 0.02, volume: 50_000 }, ['open'], { book: 'extended', etMin: 480, day: '2026-10-21', catalyst: { material: true, type: 'short', magnitude: 'minor' } })
    assert.equal(row.fade_check, true)
})

test('ranking: the best grade first, then the most room', () => {
    const r = (sym, g, m) => ({ symbol: sym, cells: { open: { grade: g, range: { atr_mult: m } } } })
    assert.deepEqual(rankRows([r('C1', 'C', 3), r('A1', 'A', 1), r('A2', 'A', 2), r('B1', 'B', 9)]).map(x => x.symbol), ['A2', 'A1', 'B1', 'C1'])
})

// ─── The run ──────────────────────────────────────────────────────────────────

const PREMARKET = Date.parse('2026-10-21T12:05:00Z')
function rig(over = {}) {
    const { db, rows } = memDb()
    // QUIET is in the pool by structure (NR7) and never in play: the name a pass quotes for nothing.
    rows(STATS).push({ ...S, day: '2026-10-20' }, { ...S, symbol: 'QUIET', next_earnings: null, nr7: true, day: '2026-10-20' })
    const calls = []
    const deps = {
        db: async () => db,
        latestRun: async () => ({ day: '2026-10-20', breadth_above_sma20: 55, spy: { close: 600 } }),
        news: async () => [{ symbol: 'ABC', title: 'ABC wins a contract', publishedDate: '2026-10-21 06:30:00' }],
        earnings: async () => [],
        grades: async () => [],
        movers: async () => { calls.push('movers'); return [] },
        extQuote: async (s) => { calls.push(s); return s === 'ABC' ? { mid: 104, spreadPct: 0.02, volume: 30_000 } : { mid: 100.1, spreadPct: 0.02, volume: 10 } },
        quote: async () => { throw new Error('the session quote is not used pre-market') },
        label: async (m) => new Map([...m.keys()].map(k => [k, { material: true, type: 'drift', surprise: 'positive', magnitude: 'major' }])),
        perMinute: () => 6000,
        now: () => PREMARKET,
        sleep: async () => {},
        ...over,
    }
    return { deps, rows, calls }
}

test('run: pools, quotes the extended book, labels, grades and publishes one board', async () => {
    const { deps, rows, calls } = rig()
    const r = await runCheckpoint({ deps })
    assert.equal(r.outcome, 'done')
    assert.equal(r.id, 'hb_2026-10-21_premarket')
    assert.ok(!calls.includes('movers'), 'movers are regular-session data — not read pre-market')
    const board = rows(BOARDS)[0]
    assert.equal(board.status, 'done')
    assert.equal(board.unverified, true, '§7: unverified until the outcome log says otherwise')
    assert.equal(board.labels, 'labelled')
    assert.deepEqual(board.rows.map(x => x.symbol), ['ABC'])
    assert.equal(board.rows[0].catalyst.type, 'drift')
    assert.equal(board.regime.breadth_above_sma20, 55)
})

test('run: a 429 mid-quotes publishes a PARTIAL board with what it has', async () => {
    const { deps, rows } = rig({ extQuote: async (s) => { if (s === 'QUIET') throw Object.assign(new Error('429'), { status: 429 }); return { mid: 104, spreadPct: 0.02, volume: 30_000 } } })
    const r = await runCheckpoint({ deps })
    assert.equal(r.outcome, 'partial')
    assert.equal(rows(BOARDS)[0].stopped, 'rate_limited')
})

test('run: no credits for the labels → the board still goes out, unlabelled', async () => {
    const { deps, rows } = rig({ label: async () => new Map() })
    const r = await runCheckpoint({ deps })
    assert.equal(r.outcome, 'done')
    assert.equal(rows(BOARDS)[0].labels, 'failed')
})

test('run: one board per checkpoint; no overnight stats → nothing published', async () => {
    const a = rig()
    await runCheckpoint({ deps: a.deps })
    assert.equal((await runCheckpoint({ deps: a.deps })).outcome, 'exists')

    const b = rig({ latestRun: async () => null })
    assert.equal((await runCheckpoint({ deps: b.deps })).outcome, 'no_stats')
    assert.equal(b.rows(BOARDS).length, 0)
})

test('run: the board is CLAIMED — a second server that loses the claim reads nothing', async () => {
    const { deps, calls } = rig()
    const db = await deps.db()
    const real = db.collection.bind(db)
    db.collection = (name) => {
        const c = real(name)
        if (name !== BOARDS) return c
        // The other server inserted the board between this one's read and its claim.
        return { ...c, updateOne: async (q, u, o) => { if (o?.upsert) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); return c.updateOne(q, u, o) } }
    }
    assert.equal((await runCheckpoint({ deps })).outcome, 'already_running')
    assert.equal(calls.length, 0, 'no quotes spent on a board the other server is building')
})

test('run: each row says when it was quoted — the outcome log measures from after it', async () => {
    const { deps, rows } = rig()
    await runCheckpoint({ deps })
    assert.equal(rows(BOARDS)[0].rows[0].quoted_at, PREMARKET)
    assert.equal(rows(BOARDS)[0].attempts, 1)
})

test('run: outside every window, nothing is read', async () => {
    const { deps, calls } = rig({ now: () => Date.parse('2026-10-21T16:00:00Z') })
    assert.equal((await runCheckpoint({ deps })).outcome, 'not_due')
    assert.equal(calls.length, 0)
})

// ─── The monitor ──────────────────────────────────────────────────────────────

test('monitor: the overnight pass first, then the checkpoint — and off means neither', async () => {
    const order = []
    const on = await _tick({ enabled: () => true, nightly: async () => { order.push('n'); return { outcome: 'not_due' } }, checkpoint: async () => { order.push('c'); return { outcome: 'done' } } })
    assert.deepEqual(order, ['n', 'c'])
    assert.equal(on.checkpoint.outcome, 'done')
    assert.deepEqual(await _tick({ enabled: () => false, nightly: async () => order.push('x'), checkpoint: async () => order.push('x') }), { outcome: 'off' })
    assert.deepEqual(order, ['n', 'c'])
})

// ─── Roy, 2026-10-21: the 08:00 spread allowance, and the board's spend on the admin ledger ───

test('08:00 allows 3× the spread; 09:20 holds the gate strict', () => {
    const q = { mid: 104, spreadPct: 0.12, volume: 30_000 }
    const ctx = { book: 'extended', etMin: 480, day: '2026-10-21', catalyst: null }
    const at8 = boardRow(S, q, ['open'], { ...ctx, spreadSlack: CHECKPOINTS.find(c => c.id === 'premarket').spreadSlack })
    assert.equal(at8.cells.open.grade, 'B')
    const at920 = boardRow(S, q, ['open', 'week'], { ...ctx, etMin: 560, spreadSlack: CHECKPOINTS.find(c => c.id === 'preopen').spreadSlack ?? 1 })
    assert.equal(at920?.cells.open.gate ?? 'no row', 'spread')
})

test('the labels and Argus\'s read are booked to the house ledger, as monitor spend', async () => {
    const booked = []
    const { deps, rows } = rig({
        bookTo: async () => 'admin-1',
        record: async (userId, model, usage, agent) => { booked.push({ userId, model, agent, tokens: usage.input_tokens }) },
        label: async (m, opts) => { opts?.onUsage?.({ input_tokens: 40 }, 'gpt-6-luna'); return new Map([...m.keys()].map(k => [k, { material: true, type: 'drift', surprise: 'positive', magnitude: 'major' }])) },
        argus: async (_board, opts) => { opts?.onUsage?.({ input_tokens: 90 }, 'gpt-6-luna'); return { summary: 's', picks: [], avoid: [], model: 'gpt-6-luna' } },
    })
    await runCheckpoint({ deps })
    await new Promise(r => setImmediate(r))
    assert.deepEqual(booked.map(b => [b.userId, b.agent, b.tokens]), [['admin-1', 'hotlist_news', 40], ['admin-1', 'hotlist_argus', 90]])
    assert.equal(rows(BOARDS)[0].booked_to, 'admin-1')
})

test('no admin to book to → the board still goes out, unbooked', async () => {
    const { deps, rows } = rig({ bookTo: async () => null, record: async () => { throw new Error('never called') } })
    assert.equal((await runCheckpoint({ deps })).outcome, 'done')
    assert.equal(rows(BOARDS)[0].booked_to, null)
})
