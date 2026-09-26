import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judge, directionOf, batchRead, BATCH_MAX } from '../../services/aetherBatchRead.service.js'

// Prometheus over a radar list: the veto, the longs cut, and the rule that a name nobody could
// read is not a name that was refused.

const read = (verdict, net = null) => ({ verdict, net })

// ── the veto ──────────────────────────────────────────────────────────────────

test('contradicted is out — no setup rescues a thesis the record cuts against', () => {
    const v = judge(read('contradicted'), { side: 'helped' })
    assert.equal(v.keep, false)
    assert.match(v.why, /contradicts/)
})

test('priced in is out — a good post-mortem and a bad trade', () => {
    assert.equal(judge(read('priced_in'), { side: 'helped' }).keep, false)
})

test('credible is in, unflagged', () => {
    const v = judge(read('credible'), { side: 'helped' })
    assert.equal(v.keep, true)
    assert.equal(v.flag, null)
})

test('UNCLEAR SHIPS FLAGGED — an honest "cannot say" is not a no', () => {
    const v = judge(read('unclear'), { side: 'helped' })
    assert.equal(v.keep, true)
    assert.equal(v.flag, 'unclear')
})

test('no read at all ships flagged too — the absence of a reading is not a reading', () => {
    const v = judge(null, { side: 'helped' })
    assert.equal(v.keep, true)
    assert.equal(v.flag, 'unread')
})

// A contradicted name is out whichever way it points: the veto is the more conclusive statement,
// and reporting it as "wrong direction" would name the wrong reason on the row.
test('the veto is read BEFORE the direction, so the recorded reason is the conclusive one', () => {
    const v = judge(read('contradicted', 'hurt'), { side: 'hurt' })
    assert.equal(v.keep, false)
    assert.match(v.why, /contradicts/)
})

// ── the longs cut ─────────────────────────────────────────────────────────────

test('a short is out of a longs list, and says that is why', () => {
    const v = judge(read('credible'), { side: 'hurt' })
    assert.equal(v.keep, false)
    assert.equal(v.direction, 'short')
    assert.match(v.why, /longs only/)
})

test('longsOnly off keeps the short', () => {
    assert.equal(judge(read('credible'), { side: 'hurt', longsOnly: false }).keep, true)
})

test('an unsettled direction ships FLAGGED rather than dropped, with its own flag', () => {
    const v = judge(read('credible', 'unclear'), { side: 'helped' })
    assert.equal(v.keep, true)
    assert.equal(v.flag, 'direction')
    assert.equal(v.direction, 'unclear')
})

test('an unclear VERDICT outranks an unclear direction — the claim is the bigger doubt', () => {
    assert.equal(judge(read('unclear', 'unclear'), { side: 'helped' }).flag, 'unclear')
})

// ── direction: net when there is one, side when there is not ──────────────────

test('net wins over side — it has looked at every event naming the name', () => {
    // APD: Aether called it HELPED by India semiconductor, the read made it net hurt once the
    // Hormuz helium disruption was weighed in. The longs cut must follow the read.
    assert.equal(directionOf(read('contradicted', 'hurt'), 'helped'), 'short')
    assert.equal(judge(read('credible', 'hurt'), { side: 'helped' }).keep, false)
})

test('side is the fallback, and it is the COMMON path — most names are named by one event', () => {
    // `net` is null whenever one event names the ticker: there is no net of a single claim.
    assert.equal(directionOf(read('credible', null), 'helped'), 'long')
    assert.equal(directionOf(read('credible', null), 'hurt'),   'short')
})

test('neither a net nor a side is unclear, not a long', () => {
    assert.equal(directionOf(null, ''), 'unclear')
    assert.equal(directionOf(read('credible'), 'mixed'), 'unclear')
})

// ── the batch ─────────────────────────────────────────────────────────────────

const io = ({ best = {}, reads = {}, fail = {} } = {}) => ({
    appearances: async (t) => best[t] === null ? null : { best: best[t] ?? { run_id: `r:${t}`, side: 'helped' }, events: 1 },
    read: async ({ ticker }) => {
        if (fail[ticker]) throw new Error(fail[ticker])
        return reads[ticker] ?? read('credible')
    },
})

test('every name is read and judged, and the tally counts what was kept', async () => {
    const out = await batchRead({ tickers: ['NUE', 'X', 'XOM'], userId: 'u1' }, io({
        reads: { X: read('contradicted'), XOM: read('unclear') },
    }))
    assert.deepEqual(out.rows.map(r => [r.ticker, r.keep, r.flag]),
        [['NUE', true, null], ['X', false, null], ['XOM', true, 'unclear']])
    assert.equal(out.kept, 2)
    assert.equal(out.flagged, 1)
})

test('ONE NAME FAILING DOES NOT COST THE BATCH — it goes through unread and flagged', async () => {
    const out = await batchRead({ tickers: ['NUE', 'X', 'XOM'] }, io({ fail: { X: 'model timed out' } }))
    assert.equal(out.rows.length, 3)
    const x = out.rows.find(r => r.ticker === 'X')
    assert.equal(x.keep, true)
    assert.equal(x.flag, 'unread')
    assert.equal(x.error, 'model timed out')
    // …and the names after it were still read.
    assert.equal(out.rows.find(r => r.ticker === 'XOM').read.verdict, 'credible')
})

test('a name the radar no longer carries is flagged, never silently dropped from the list', async () => {
    const out = await batchRead({ tickers: ['GONE'] }, io({ best: { GONE: null } }))
    assert.equal(out.rows[0].keep, true)
    assert.equal(out.rows[0].flag, 'unread')
    assert.match(out.rows[0].error, /no live event/)
})

test('the run read against is the best-ranked live appearance', async () => {
    const seen = []
    const deps = {
        appearances: async () => ({ best: { run_id: 'Canada:2026-09-08', side: 'hurt' }, events: 3 }),
        read: async (a) => { seen.push(a.runId); return read('credible', 'helped') },
    }
    await batchRead({ tickers: ['NUE'] }, deps)
    assert.deepEqual(seen, ['Canada:2026-09-08'])
})

test('duplicates and case are folded, so a name is paid for once', async () => {
    const calls = []
    const deps = { appearances: async () => ({ best: { run_id: 'r', side: 'helped' } }),
                   read: async ({ ticker }) => { calls.push(ticker); return read('credible') } }
    const out = await batchRead({ tickers: ['nue', 'NUE', ' nue '] }, deps)
    assert.deepEqual(calls, ['NUE'])
    assert.equal(out.rows.length, 1)
})

test('junk tickers are refused, not queried', async () => {
    await assert.rejects(() => batchRead({ tickers: ['', '!!', null] }, io()), /at least one ticker/)
})

test('the batch is capped — a caller cannot hand over the whole board', async () => {
    const many = Array.from({ length: BATCH_MAX + 1 }, (_, i) => `T${i}`)
    await assert.rejects(() => batchRead({ tickers: many }, io()), new RegExp(`at most ${BATCH_MAX}`))
})

test('an aborted signal stops the batch where it is rather than spending the rest', async () => {
    const ctrl = new AbortController()
    let n = 0
    const deps = {
        appearances: async () => ({ best: { run_id: 'r', side: 'helped' } }),
        read: async () => { if (++n === 2) ctrl.abort(); return read('credible') },
    }
    const out = await batchRead({ tickers: ['A', 'B', 'C', 'D'], signal: ctrl.signal }, deps)
    assert.equal(out.rows.length, 2, 'stopped after the turn that aborted')
})
