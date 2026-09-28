import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    buildUniverse, priorScanState, thesisLine, repricingOf, getScanUniverse, SCAN_SOURCE, UNIVERSE_DAYS,
} from '../../services/aetherScanUniverse.service.js'

// The radar → Argus universe and the rule that stops a name being scanned every day.
// buildUniverse is pure; getScanUniverse is exercised through its injected IO.

/** One run with one candidate, defaults chosen so a test only states what it is about. */
function run({ id = 'Canada:2026-09-20', subject = 'Canada', found = '2026-09-20T10:00:00Z',
               event_date = '2026-09-20', names = [] } = {}) {
    return {
        run_id: id, subject, event_date, created_at: found,
        candidates: names.map(n => ({
            ticker: n.ticker, company: n.company ?? '', side: n.side ?? 'helped',
            mechanism: n.mechanism ?? '', verdict: n.verdict ?? 'silent',
            rank: n.rank ?? 1, created_at: n.found ?? found, excess_pct: n.excess_pct ?? null,
            // The claim's own deadline and the engine's last price — the dated facts the board carries
            // so the cut does not have to fetch them mid-stream.
            expires_at: n.expires_at ?? '2026-11-01',
            price_latest: n.price_latest ?? null, price_asof: n.price_asof ?? '',
            subject, event_date,
        })),
    }
}

/** A saved radar list: the names it kept, and the run ids its universe was cut from. */
const list = (sourceRuns, tickers) => ({ sourceRuns, candidates: tickers.map(t => ({ ticker: t })) })

// ── the universe, with nothing scanned yet ────────────────────────────────────

test('a first scan carries every name on the board', () => {
    const { candidates, skipped } = buildUniverse([
        run({ names: [{ ticker: 'NUE' }, { ticker: 'X' }] }),
    ], [])
    assert.deepEqual(candidates.map(c => c.ticker), ['NUE', 'X'])
    assert.deepEqual(skipped, [])
})

test('one entry per ticker even when several events reach it — the edit-list seam is keyed by ticker', () => {
    const { candidates } = buildUniverse([
        run({ id: 'a:1', subject: 'Canada',  names: [{ ticker: 'XOM', side: 'hurt',   rank: 2 }] }),
        run({ id: 'b:1', subject: 'Hormuz',  names: [{ ticker: 'XOM', side: 'helped', rank: 5 }] }),
    ], [])
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].events, 2)
    // The best rank across its appearances, so the order is the board's own.
    assert.equal(candidates[0].rank, 5)
})

test('direction is never passed — Argus is asked a direction-blind question', () => {
    const { candidates } = buildUniverse([run({ names: [{ ticker: 'NUE', side: 'hurt' }] })], [])
    assert.equal(candidates[0].direction, undefined)
    // The side is information, so it is stated in the line rather than dropped.
    assert.match(candidates[0].thesis, /HURT/)
})

test('ordering is best rank first, then ticker — two runs of one board agree', () => {
    const { candidates } = buildUniverse([
        run({ names: [{ ticker: 'BBB', rank: 1 }, { ticker: 'AAA', rank: 1 }, { ticker: 'CCC', rank: 9 }] }),
    ], [])
    assert.deepEqual(candidates.map(c => c.ticker), ['CCC', 'AAA', 'BBB'])
})

test('a blank ticker is dropped rather than carried as an empty row', () => {
    const { candidates } = buildUniverse([run({ names: [{ ticker: '' }, { ticker: 'NUE' }] })], [])
    assert.deepEqual(candidates.map(c => c.ticker), ['NUE'])
})

test('the company name is taken off whichever appearance carries one', () => {
    const { candidates } = buildUniverse([
        run({ id: 'a:1', names: [{ ticker: 'XOM', company: '' }] }),
        run({ id: 'b:1', names: [{ ticker: 'XOM', company: 'Exxon Mobil Corporation' }] }),
    ], [])
    assert.equal(candidates[0].company, 'Exxon Mobil Corporation')
})

// ── the exclusion rule ────────────────────────────────────────────────────────

test('a name on yesterday\'s list is held back, with the reason', () => {
    const board = [run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }, { ticker: 'X' }] })]
    const { candidates, skipped } = buildUniverse(board, [list(['Canada:2026-09-20'], ['NUE'])])
    assert.deepEqual(candidates.map(c => c.ticker), ['X'])
    assert.deepEqual(skipped, [{ ticker: 'NUE', reason: 'listed_already' }])
})

test('THE EXCEPTION: an event no previous scan saw puts a listed name back', () => {
    const board = [
        run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }] }),
        run({ id: 'Hormuz:2026-09-22', names: [{ ticker: 'NUE' }] }),
    ]
    const { candidates, skipped } = buildUniverse(board, [list(['Canada:2026-09-20'], ['NUE'])])
    assert.deepEqual(candidates.map(c => c.ticker), ['NUE'])
    assert.deepEqual(skipped, [])
    // And it is marked, so the seed can say why a name the user has seen is back.
    assert.equal(candidates[0].returning, true)
})

test('events the last scan already saw do not put a listed name back, however many there are', () => {
    const board = [
        run({ id: 'Canada:2026-09-18', names: [{ ticker: 'NUE' }] }),
        run({ id: 'Trump:2026-09-20',  names: [{ ticker: 'NUE' }] }),
    ]
    const prior = [list(['Canada:2026-09-18', 'Trump:2026-09-20'], ['NUE'])]
    assert.deepEqual(buildUniverse(board, prior).candidates, [])
})

test('a REWRITTEN candidate date cannot re-admit a name — the rule never reads the clock', () => {
    // Discovered.to_mongo() stamps created_at with `now` when a candidate is stored without one,
    // so re-verifying an event used to make every name it reached look brand new.
    const board = [run({ id: 'Canada:2026-09-18', found: '2030-01-01T00:00:00Z', names: [{ ticker: 'NUE' }] })]
    assert.deepEqual(buildUniverse(board, [list(['Canada:2026-09-18'], ['NUE'])]).candidates, [])
})

test('a name Argus REJECTED is not excluded — it was never on the output list', () => {
    // The universe handed over held both; only NUE came back on the saved list.
    const board = [run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }, { ticker: 'X' }] })]
    const { candidates } = buildUniverse(board, [list(['Canada:2026-09-20'], ['NUE'])])
    assert.deepEqual(candidates.map(c => c.ticker), ['X'])
})

test('events seen across SEVERAL prior lists all count as seen', () => {
    const board = [
        run({ id: 'Canada:2026-09-18', names: [{ ticker: 'NUE' }] }),
        run({ id: 'Hormuz:2026-09-22', names: [{ ticker: 'NUE' }] }),
    ]
    // Neither list saw both events; between them they saw both, so nothing here is new.
    const prior = [list(['Canada:2026-09-18'], ['NUE']), list(['Hormuz:2026-09-22'], [])]
    assert.deepEqual(buildUniverse(board, prior).candidates, [])
})

test('the run ids of THIS universe come back out, so the caller can store them', () => {
    const board = [run({ id: 'Canada:2026-09-18', names: [{ ticker: 'NUE' }] }),
                   run({ id: 'Hormuz:2026-09-22', names: [] })]
    // Including the event that produced no names — it was still on the board and still seen.
    assert.deepEqual(buildUniverse(board, []).runIds, ['Canada:2026-09-18', 'Hormuz:2026-09-22'])
})

test('first-time names are not marked as returning', () => {
    const { candidates } = buildUniverse([run({ names: [{ ticker: 'NUE' }] })], [])
    assert.equal(candidates[0].returning, undefined)
})

test('priorScanState: case-folds tickers and unions the run ids', () => {
    const { listed, seenRuns } = priorScanState([list(['a:1'], ['nue']), list(['b:1'], ['NUE', 'x'])])
    assert.deepEqual([...listed].sort(), ['NUE', 'X'])
    assert.deepEqual([...seenRuns].sort(), ['a:1', 'b:1'])
})

test('priorScanState: a list with no sourceRuns excludes nothing, and junk is survived', () => {
    // No record of which events it saw → every event reads as new and its names come back.
    // Scanning a name twice costs a row in a prompt; hiding one loses it.
    const { listed, seenRuns } = priorScanState([{ candidates: [{ ticker: 'X' }] }, null, { sourceRuns: ['a:1'] }])
    assert.equal(listed.size, 0)
    assert.deepEqual([...seenRuns], ['a:1'])
})

test('a prior list with no sourceRuns excludes nothing', () => {
    const board = [run({ names: [{ ticker: 'NUE' }] })]
    const out = buildUniverse(board, [{ candidates: [{ ticker: 'NUE' }] }])
    assert.deepEqual(out.candidates.map(c => c.ticker), ['NUE'])
})

// ── the thesis line ───────────────────────────────────────────────────────────

test('one claim reads as one sentence; the filing verdict rides along', () => {
    const line = thesisLine([{ subject: 'Canada', side: 'hurt', mechanism: 'imports steel', verdict: 'quantified', event_date: '2026-09-20' }])
    assert.equal(line, 'HURT by Canada (2026-09-20) — imports steel — filings: quantified — no move measured')
})

test('several claims are counted and spelled out', () => {
    const line = thesisLine([
        { subject: 'Canada', side: 'hurt',   event_date: '2026-09-20' },
        { subject: 'Hormuz', side: 'helped', event_date: '2026-09-19' },
    ])
    assert.match(line, /^Reached by 2 events\./)
    assert.match(line, /HURT by Canada/)
    assert.match(line, /HELPED by Hormuz/)
})

test('past the fourth claim the rest are counted rather than printed', () => {
    const line = thesisLine(Array.from({ length: 5 }, (_, i) => ({ subject: `E${i}`, side: 'helped' })))
    assert.match(line, /and 2 further events/)
})

test('a long mechanism is clipped, not dropped — whole boards go in one prompt', () => {
    const line = thesisLine([{ subject: 'Canada', side: 'hurt', mechanism: 'x'.repeat(500) }])
    assert.ok(line.length < 400, line.length)
    assert.match(line, /…/)
})

test('no claims → an empty line rather than a throw', () => {
    assert.equal(thesisLine([]), '')
})

// ── getScanUniverse: the IO seam ──────────────────────────────────────────────

const io = ({ runs = [], scans = [], earnings = [] } = {}) => ({
    runs:  async () => runs,
    scans: async () => scans,
    earnings: async () => earnings,
})

test('only radar-sourced scans count as prior lists', async () => {
    const runs  = [run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }] })]
    const scans = [
        // A list the user built by hand that happens to hold the same name must not exclude it.
        { source: null, sourceRuns: ['Canada:2026-09-20'], candidates: [{ ticker: 'NUE' }] },
    ]
    const out = await getScanUniverse('u1', {}, io({ runs, scans }))
    assert.deepEqual(out.candidates.map(c => c.ticker), ['NUE'])
    assert.equal(out.priorLists, 0)
})

test('a radar-sourced scan does exclude', async () => {
    const runs  = [run({ id: 'Canada:2026-09-20', names: [{ ticker: 'NUE' }] })]
    const scans = [{ source: SCAN_SOURCE, sourceRuns: ['Canada:2026-09-20'], candidates: [{ ticker: 'NUE' }] }]
    const out = await getScanUniverse('u1', {}, io({ runs, scans }))
    assert.deepEqual(out.candidates, [])
    assert.equal(out.priorLists, 1)
    assert.equal(out.skipped[0].ticker, 'NUE')
})

test('the window defaults to the list\'s own and is reported back', async () => {
    const out = await getScanUniverse('u1', {}, io())
    assert.equal(out.days, UNIVERSE_DAYS)
})

test('a failed scan read THROWS rather than handing back the whole board', async () => {
    const deps = { runs: async () => [run({ names: [{ ticker: 'NUE' }] })],
                   scans: async () => { throw new Error('mongo down') } }
    await assert.rejects(() => getScanUniverse('u1', {}, deps), /mongo down/)
})

test('no scans at all is not a failure — it is a first scan', async () => {
    const out = await getScanUniverse('u1', {}, io({ runs: [run({ names: [{ ticker: 'NUE' }] })], scans: null }))
    assert.deepEqual(out.candidates.map(c => c.ticker), ['NUE'])
})

// ── the dated facts the board carries ─────────────────────────────────────────
// These used to be Argus's first two tool calls: a market-wide earnings calendar and a hundred-wide
// quote fan-out, fired mid-stream against a ten-second budget. When the calendar lost that race the
// model had no dates for anything and the mode's own rule emptied the board down to one name. They are
// on the row now, fetched once, server-side, before the prompt is built.

test('the next scheduled print is attached to the name it belongs to', async () => {
    const out = await getScanUniverse('u1', {}, io({
        runs: [run({ names: [{ ticker: 'MU' }, { ticker: 'NUE' }] })],
        earnings: [{ symbol: 'MU', date: '2026-09-30', epsEstimated: 2.1 }],
    }))
    const by = new Map(out.candidates.map(c => [c.ticker, c]))
    assert.deepEqual(by.get('MU').earnings, { date: '2026-09-30', epsEstimate: 2.1 })
    // NULL and not undefined: the calendar answered, and the answer is "nothing scheduled".
    assert.equal(by.get('NUE').earnings, null)
    assert.equal(out.candidates.filter(c => c.earnings).length, 1)
})

// "The calendar could not be read" and "the company has no print" must not look the same to the model:
// one is a fact about the name, the other is a fact about the fetch, and only the first is a reason to
// leave a name off a list.
test('a calendar failure leaves the date UNKNOWN and still hands over the board', async () => {
    const out = await getScanUniverse('u1', {}, {
        runs: async () => [run({ names: [{ ticker: 'MU' }] })],
        scans: async () => [],
        earnings: async () => { throw new Error('FMP /earnings-calendar aborted') },
    })
    assert.deepEqual(out.candidates.map(c => c.ticker), ['MU'], 'the board survives its calendar')
    assert.equal(out.candidates[0].earnings, undefined, 'undefined is "not known", distinct from null')
})

test('the board window is the FURTHEST claim deadline — when the board stops carrying the name', () => {
    const { candidates } = buildUniverse([
        run({ id: 'a:1', names: [{ ticker: 'XOM', expires_at: '2026-10-03', rank: 9 }] }),
        run({ id: 'b:1', names: [{ ticker: 'XOM', expires_at: '2026-11-06', rank: 1 }] }),
    ], [])
    assert.equal(candidates[0].expires, '2026-11-06')
    // Each claim's own date is in the line, because a name reached twice has two deadlines and
    // "which of these has to pay off by Friday" is not answerable from the furthest one.
    assert.match(candidates[0].thesis, /claim runs to 2026-10-03/)
    assert.match(candidates[0].thesis, /claim runs to 2026-11-06/)
})

test('the price rides on the row, off the most recently priced appearance', () => {
    const { candidates } = buildUniverse([
        run({ id: 'a:1', names: [{ ticker: 'XOM', price_latest: 110, price_asof: '2026-09-18' }] }),
        run({ id: 'b:1', names: [{ ticker: 'XOM', price_latest: 118, price_asof: '2026-09-25' }] }),
    ], [])
    assert.equal(candidates[0].price, 118)
    assert.equal(candidates[0].priceAsOf, '2026-09-25')
})

test('an unpriced name is null rather than a stale guess', () => {
    const { candidates } = buildUniverse([run({ names: [{ ticker: 'NUE' }] })], [])
    assert.equal(candidates[0].price, null)
    assert.equal(candidates[0].priceAsOf, null)
})

// The board is answered to the browser, held in its state, and sent BACK on every turn of the cut, so
// the "not known" / "nothing scheduled" distinction has to survive JSON in both directions. It does
// only because one side is an ABSENT key and the other an explicit null.
test('the unknown-vs-no-print distinction survives the round trip through JSON', async () => {
    const ok = await getScanUniverse('u1', {}, io({
        runs: [run({ names: [{ ticker: 'MU' }, { ticker: 'NUE' }] })],
        earnings: [{ symbol: 'MU', date: '2026-09-30' }],
    }))
    const failed = await getScanUniverse('u1', {}, {
        runs: async () => [run({ names: [{ ticker: 'MU' }] })],
        scans: async () => [],
        earnings: async () => { throw new Error('aborted') },
    })

    const trip = v => JSON.parse(JSON.stringify(v))
    const back = trip(ok).candidates
    assert.equal(back.find(c => c.ticker === 'MU').earnings.date, '2026-09-30')
    assert.equal(back.find(c => c.ticker === 'NUE').earnings, null, 'null survives as null')
    assert.ok(!('earnings' in trip(failed).candidates[0]), 'unknown stays absent, never becomes null')
})

// A garbage price must not reach the prompt. NaN serialises to null on the wire but renders as "$NaN"
// on the way to the model, which is the hop that matters here.
test('an unusable price is no price, not NaN', () => {
    const { candidates } = buildUniverse([
        run({ names: [{ ticker: 'A', price_latest: 'n/a', price_asof: '2026-09-25' },
                      { ticker: 'B', price_latest: 0,     price_asof: '2026-09-25' }] }),
    ], [])
    for (const c of candidates) assert.equal(c.price, null, `${c.ticker} kept an unusable price`)
})

// ── REPRICING: how far through its move the market already is ─────────────────
// Computed here because the prompt could not get it applied: three cuts in a row kept the most extended
// names on the board — MU at +8.4% and TSM at +4.8% past their events, twice — and the read refused all
// of them as `priced_in` minutes later, while 42 names with no move made sat on the same board. A rule
// the model must remember is a rule it can skip; a label on the row is a fact it reads.

const claim = (side, excess, rank = 1) => ({ side, excess_pct: excess, rank, expires_at: '2026-11-01' })

test('a HELPED claim that has RISEN has had its move taken', () => {
    const { state, pct } = repricingOf([claim('helped', 0.084)])
    assert.equal(state, 'taken')
    // A tolerance, not equality: the percentage is a float multiply and pinning its last bit tests IEEE
    // rather than the classifier.
    assert.ok(Math.abs(pct - 8.4) < 1e-9, `pct was ${pct}`)
})

// THE SIGN IS THE WHOLE POINT. A HURT name is supposed to FALL, so a fall is the move being MADE — read
// unsigned, -8% looks like weakness and would be mistaken for an opportunity.
test('a HURT claim that has FALLEN has ALSO had its move taken', () => {
    assert.equal(repricingOf([claim('hurt', -0.084)]).state, 'taken')
})

test('moving the wrong way for the claim is the market disagreeing, either side', () => {
    assert.equal(repricingOf([claim('helped', -0.06)]).state, 'against')
    assert.equal(repricingOf([claim('hurt',    0.06)]).state, 'against')
})

test('barely moved either way is the row worth having', () => {
    for (const c of [claim('helped', 0.004), claim('hurt', -0.004), claim('helped', -0.02), claim('hurt', 0.02)]) {
        assert.equal(repricingOf([c]).state, 'not_yet', JSON.stringify(c))
    }
})

// UNKNOWN IS NOT "NOT YET" — 42 of the live board's 116 rows have no measured move, and ISRG survived a
// cut by falling into that gap rather than by being early.
test('no measured move is UNKNOWN, never not_yet', () => {
    assert.deepEqual(repricingOf([claim('helped', null)]), { state: 'unknown', pct: null })
    assert.deepEqual(repricingOf([]), { state: 'unknown', pct: null })
    // A side that cannot be signed cannot be read either — mixed/blank is not a direction.
    assert.equal(repricingOf([claim('', 0.08)]).state, 'unknown')
    assert.equal(repricingOf([claim('mixed', 0.08)]).state, 'unknown')
})

test('the strongest claim that HAS a move decides, not the strongest claim full stop', () => {
    const claims = [claim('helped', null, 9), claim('hurt', -0.07, 4)]
    assert.equal(repricingOf(claims).state, 'taken', 'an unmeasured top claim must not blind the whole name')
})

test('the row carries it, and the thesis still carries the raw move', () => {
    const { candidates } = buildUniverse([
        run({ names: [{ ticker: 'MU', side: 'helped', excess_pct: 0.084 }] }),
    ], [])
    assert.equal(candidates[0].repricing.state, 'taken')
    assert.match(candidates[0].thesis, /moved 8\.4% vs SPY since/)
})

// The ORDER is a nudge, not a filter: a hundred rows is more than anyone reads evenly, and the names
// worth the tape were scattered through it.
test('the board leads with not_yet, then unmeasured, then against, then taken', () => {
    const { candidates } = buildUniverse([
        run({ names: [
            { ticker: 'TAKEN',   side: 'helped', excess_pct: 0.09,  rank: 9 },
            { ticker: 'AGAINST', side: 'helped', excess_pct: -0.09, rank: 9 },
            { ticker: 'UNKNOWN', side: 'helped', excess_pct: null,  rank: 9 },
            { ticker: 'NOTYET',  side: 'helped', excess_pct: 0.001, rank: 1 },
        ] }),
    ], [])
    assert.deepEqual(candidates.map(c => c.ticker), ['NOTYET', 'UNKNOWN', 'AGAINST', 'TAKEN'])
    // …and NOTYET led on its state despite having the WORST rank, which is the point of the change.
    assert.equal(candidates[0].rank, 1)
})

test('rank still breaks ties inside a state, so the order is total and repeatable', () => {
    const { candidates } = buildUniverse([
        run({ names: [
            { ticker: 'LOW',  side: 'helped', excess_pct: 0.001, rank: 1 },
            { ticker: 'HIGH', side: 'helped', excess_pct: 0.001, rank: 9 },
            { ticker: 'MID',  side: 'helped', excess_pct: 0.001, rank: 5 },
        ] }),
    ], [])
    assert.deepEqual(candidates.map(c => c.ticker), ['HIGH', 'MID', 'LOW'])
})
