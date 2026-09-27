import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judge, directionOf, batchRead, BATCH_MAX, READ_CONCURRENCY, RADAR_LONGS_ONLY } from '../../services/aetherBatchRead.service.js'

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

// The reads OVERLAP, bounded. It was one at a time, on the argument that a list should not spend its
// whole budget before the first refusal came back — which stopped being true the day the read started
// firing by itself on every kept name, since a refusal has never stopped the batch. What was left was
// eight minutes of wall clock against a client that waits ten.
test('the reads run READ_CONCURRENCY at a time — overlapped, and never a fan-out', async () => {
    let active = 0, peak = 0
    const deps = {
        appearances: async () => ({ best: { run_id: 'r', side: 'helped' } }),
        read: async () => {
            active++; peak = Math.max(peak, active)
            await new Promise(r => setTimeout(r, 5))
            active--
            return read('credible')
        },
    }
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
    const out = await batchRead({ tickers: names }, deps)

    assert.equal(peak, READ_CONCURRENCY, 'three at once — not one, and not all seven')
    // …and the answer does not depend on which model call came back first.
    assert.deepEqual(out.rows.map(r => r.ticker), names)
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

// The cap bounds what is READ, not what is answered. It used to refuse the call, which was right
// while the read was a press and a long list meant a caller bug; the read now fires by itself on
// every radar cut, so a list one name too long must not cost the twelve reads that were fine.
test('the batch is capped — the overflow comes back unread, and the reads that fit still happen', async () => {
    const calls = []
    const deps = { appearances: async () => ({ best: { run_id: 'r', side: 'helped' } }),
                   read: async ({ ticker }) => { calls.push(ticker); return read('credible') } }
    const many = Array.from({ length: BATCH_MAX + 3 }, (_, i) => `T${i}`)
    const out  = await batchRead({ tickers: many }, deps)

    assert.equal(calls.length, BATCH_MAX, 'exactly the cap is paid for')
    assert.deepEqual(calls, many.slice(0, BATCH_MAX), 'and it is the top of the list, in its own ranking')
    assert.equal(out.rows.length, many.length, 'every name asked about is answered for')

    // Kept, flagged, and carrying the reason — never silently missing from the answer.
    const past = out.rows.filter(r => many.slice(BATCH_MAX).includes(r.ticker))
    assert.equal(past.length, 3)
    for (const r of past) {
        assert.equal(r.keep, true)
        assert.equal(r.flag, 'unread')
        assert.match(r.error, new RegExp(`capped at ${BATCH_MAX}`))
    }
})

// An abort stops the batch PICKING UP new names. The reads already in flight finish — that is what a
// bounded pool is, and dropping them would throw away model calls already paid for — so what this
// pins is that the wave in flight is the last of it, not that the batch halts mid-read.
test('an aborted signal stops the batch where it is rather than spending the rest', async () => {
    const ctrl = new AbortController()
    let n = 0
    const deps = {
        appearances: async () => ({ best: { run_id: 'r', side: 'helped' } }),
        read: async () => { if (++n === 2) ctrl.abort(); return read('credible') },
    }
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    const out  = await batchRead({ tickers: many, signal: ctrl.signal }, deps)

    assert.equal(n, READ_CONCURRENCY, 'only the wave that had already started was paid for')
    assert.equal(out.rows.length, READ_CONCURRENCY, 'and the names never started are not rows')
    assert.deepEqual(out.rows.map(r => r.ticker), many.slice(0, READ_CONCURRENCY))
})

// A RADAR LIST MAY HOLD SHORTS, and did not until 2026-09-27: `judge`'s longsOnly flag defaulted true
// and nothing ever passed it, so the only value that shipped was the one nobody chose. It discarded
// every name whose record reads `hurt` — 44 of the live board's 116 tickers are HURT by their only
// event — after Argus had already spent triage, the tape and a paid chart read on them. AAPL proved it:
// credible, net hurt, not priced in, -0.4% vs SPY, dropped for being a short.
test('a short the record CONFIRMS is kept, not binned — the list is not longs-only', async () => {
    assert.equal(RADAR_LONGS_ONLY, false, 'the decision is a named constant, not a default nobody chose')
    const deps = {
        appearances: async () => ({ best: { run_id: 'r', side: 'hurt' }, events: 1 }),
        read:        async () => read('credible', 'hurt'),
    }
    const out = await batchRead({ tickers: ['AAPL'] }, deps)
    const row = out.rows[0]
    assert.equal(row.keep, true, 'a credible, unpriced short belongs on the list')
    assert.equal(row.direction, 'short')
    assert.equal(row.flag, null, 'and it is not a caveat — the record settled it')
    assert.equal(out.kept, 1)
})

// The vetoes that SHOULD still drop a short are untouched: the direction is not what makes a name bad.
test('allowing shorts does not weaken the vetoes', async () => {
    for (const verdict of ['contradicted', 'priced_in']) {
        const out = await batchRead({ tickers: ['AAPL'] }, {
            appearances: async () => ({ best: { run_id: 'r', side: 'hurt' } }),
            read:        async () => read(verdict, 'hurt'),
        })
        assert.equal(out.rows[0].keep, false, `${verdict} must still drop`)
    }
})
