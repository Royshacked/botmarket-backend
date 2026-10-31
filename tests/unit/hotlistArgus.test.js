import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { argusRead, normalizeRead, boardText, MAX_PICKS, SYSTEM } from '../../services/hotlist.argus.js'
import { hotlistSeed, seedFacts, todayHotlist, COLUMN_HORIZON } from '../../services/hotlist.service.js'
import { sanitizeScanSeed } from '../../services/scanSeed.util.js'
import { _buildSeedSection } from '../../services/agents/mentor.agent.service.js'
import { BOARDS } from '../../services/hotlist.boards.js'

// Build phase 5 (docs/design/daily-names.md §1, §8; Roy, 2026-10-21): Argus reads each checkpoint's
// board once, for everyone — a summary, its picks, the traps — and the user hands names to Mentor
// ONE AT A TIME; picks live on the board, not in Watchlists.

const ROW = (symbol, cells, extra = {}) => ({ symbol, sector: 'Technology', price: 100, gap_pct: 4, rvol: 2.5, atr_pct: 4, cells, ...extra })
const BOARD = {
    id: 'hb_2026-10-21_mid', day: '2026-10-21', checkpoint: 'mid', status: 'done', columns: ['mid'],
    regime: { breadth_above_sma20: 58, spy: { above_sma20: true, ret5: 1.2 } },
    unverified_columns: ['mid'],
    rows: [
        ROW('SPCX', { mid: { grade: 'B', why: ['3.4× volume'], range: { level: 166.18, pct: 2.09, atr_mult: 0.45 } } },
            { price: 162.77, gap_pct: 10.14, rvol: 3.39, catalyst: { material: true, type: 'drift', surprise: 'mixed', headline: 'SpaceX swings to profit' },
              pick: { symbol: 'SPCX', column: 'mid', why: 'A real profit swing with room to the prior high.', caution: 'Capex worries can cap it.' } }),
        ROW('FADE', { mid: { grade: 'A', range: { open_sky: true } } }, { fade_check: true }),
        ROW('NOPE', { mid: { grade: null } }),
    ],
}

// ─── Argus's read ─────────────────────────────────────────────────────────────

test('the board text carries the numbers Argus judges — and flags, catalysts, free range', () => {
    const t = boardText(BOARD)
    assert.match(t, /CHECKPOINT: mid on 2026-10-21/)
    assert.match(t, /breadth 58\.0%/)
    // A session column carries NO grade (Roy, 2026-10-24) — the room only; the headline reads as news.
    assert.match(t, /SPCX .*gap 10\.14% rvol 3\.39× .*drift mixed \| news: "SpaceX swings to profit".* mid \(2\.09% \/ 0\.45× ATR to 166\.18\)/)
    assert.match(t, /FADE .*FLAG: minor story under a big gap.*mid \(open sky\)/)
    assert.doesNotMatch(t, /mid [ABC] \(/)
})

test('a pick must be a board row on a column it is GRADED on; extras and repeats go', () => {
    const r = normalizeRead({
        summary: 'Breadth is fine; the room is in two names.',
        picks: [
            { symbol: 'spcx', column: 'mid', why: 'Profit swing.', caution: 'Capex.' },
            { symbol: 'SPCX', column: 'mid', why: 'again' },
            { symbol: 'NOPE', column: 'mid', why: 'not graded' },
            { symbol: 'GHOST', column: 'mid', why: 'not on the board' },
            { symbol: 'FADE', column: 'eod', why: 'wrong column' },
        ],
        avoid: [{ symbol: 'FADE', why: 'A minor story under a big gap.' }, { symbol: 'SPCX', why: 'already a pick' }],
    }, BOARD)
    assert.deepEqual(r.picks.map(p => p.symbol), ['SPCX'])
    assert.deepEqual(r.avoid, [{ symbol: 'FADE', why: 'A minor story under a big gap.' }])
    assert.equal(r.summary, 'Breadth is fine; the room is in two names.')
})

test('picks are capped', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ROW(`S${i}`, { mid: { grade: 'B', range: { atr_mult: 1 } } }))
    const r = normalizeRead({ picks: rows.map(x => ({ symbol: x.symbol, column: 'mid', why: 'x' })) }, { rows })
    assert.equal(r.picks.length, MAX_PICKS)
})

test('one call on the house model; a failed call is NO read, never a throw', async () => {
    let asked = null
    const ok = await argusRead(BOARD, {
        model: async () => 'gpt-6-luna',
        send: async (p) => { asked = p; return '{"summary":"s","picks":[{"symbol":"SPCX","column":"mid","why":"w","caution":"c"}],"avoid":[]}' },
    })
    assert.equal(asked.model, 'gpt-6-luna')
    assert.equal(ok.picks[0].symbol, 'SPCX')
    assert.equal(ok.model, 'gpt-6-luna')
    assert.equal(await argusRead(BOARD, { model: async () => 'x', send: async () => { throw new Error('no credits') } }), null)
    assert.equal(await argusRead({ rows: [] }, { send: async () => { throw new Error('never called') } }), null)
})

// ─── The checkpoint marks Argus's picks on their rows ─────────────────────────

// ─── The hand-off: a reference in, the board's facts out ──────────────────────

test('the seed carries a REFERENCE to the board, never its facts — and only a well-formed one', () => {
    const s = sanitizeScanSeed({ ticker: 'spcx', hotlist: { board: 'hb_2026-10-21_mid', column: 'mid', grade: 'A', facts: 'injected' } })
    assert.deepEqual(s.hotlist, { board: 'hb_2026-10-21_mid', column: 'mid', symbol: 'SPCX' }, 'grade/facts off the request are dropped')
    assert.equal(sanitizeScanSeed({ ticker: 'X', hotlist: { board: 'hb_bad', column: 'mid' } }).hotlist, null)
    assert.equal(sanitizeScanSeed({ ticker: 'X', hotlist: { board: 'hb_2026-10-21_mid', column: 'lunch' } }).hotlist, null)
})

test('each column hands Mentor its horizon', () => {
    assert.deepEqual(COLUMN_HORIZON, { open: 'intraday', mid: 'intraday', eod: 'intraday', tomorrow: 'day', week: 'short term swing' })
})

test('the facts line: grade, tape, free range, catalyst — or open sky', () => {
    assert.equal(seedFacts(BOARD.rows[0], 'mid'),
        'mid-session — +10.14% gap, 3.39× volume; free range 2.09% (0.45× ATR) to 166.18; catalyst: drift, mixed — "SpaceX swings to profit"')
    assert.match(seedFacts(BOARD.rows[1], 'mid'), /open sky/)
    assert.equal(seedFacts(BOARD.rows[2], 'mid'), null, 'an ungraded cell is not a hand-off')
})

test('a run-up week cell tells Mentor AND Argus to be out before the report (Roy, 2026-10-22)', () => {
    const row = ROW('RUN', { week: { grade: 'B', range: { level: 110, pct: 4, atr_mult: 1.6 }, exit_before: '2026-10-28' } }, { next_earnings: '2026-10-28' })
    assert.match(seedFacts(row, 'week'), /earnings 2026-10-28 — a run-up into the report: the setup must be out before it$/)
    assert.match(seedFacts({ ...row, cells: { week: { ...row.cells.week, exit_before: undefined } } }, 'week'), /; earnings 2026-10-28$/)
    assert.match(boardText({ ...BOARD, columns: ['week'], rows: [row] }), /week \(4\.00% \/ 1\.60× ATR to 110\.00\), RUN-UP: out before earnings 2026-10-28/)
})

test('hotlistSeed reads the STORED board: the horizon, the facts, Argus\'s note, the unverified flag', async () => {
    const { db, rows } = memDb()
    rows(BOARDS).push(structuredClone(BOARD))
    const seed = await hotlistSeed({ board: 'hb_2026-10-21_mid', column: 'mid', symbol: 'SPCX' }, { db: async () => db })
    assert.equal(seed.horizon, 'intraday')
    assert.match(seed.hotlist_facts, /free range 2\.09%/)
    assert.equal(seed.thesis, 'A real profit swing with room to the prior high.')
    assert.equal(seed.caution, 'Capex worries can cap it.')
    assert.equal('unverified' in seed, false, 'no grade is handed on, so nothing is unverified (2026-10-24)')
    assert.equal(await hotlistSeed({ board: 'hb_2026-10-01_mid', column: 'mid', symbol: 'SPCX' }, { db: async () => db }), null, 'a pruned board')
    assert.equal(await hotlistSeed({ board: 'hb_2026-10-21_mid', column: 'mid', symbol: 'NOPE' }, { db: async () => db }), null, 'not graded')
})

test('Mentor is told the board\'s facts, the horizon, and that free range is not a target', () => {
    const text = _buildSeedSection({
        ticker: 'SPCX', direction: 'long', thesis: 'A real profit swing.', horizon: 'intraday',
        hotlist_facts: seedFacts(BOARD.rows[0], 'mid'), caution: 'Capex worries.',
    })
    assert.match(text, /From today's HOTLIST: mid-session — /)
    assert.match(text, /That column's horizon is intraday/)
    assert.match(text, /Argus's caution: Capex worries\./)
    assert.doesNotMatch(text, /UNVERIFIED/, 'no grade is handed on, so nothing is unverified (2026-10-24)')
    assert.match(text, /no entry, stop or target/)
    // On a week name his target IS the target: no "no target" line beside it (code review 2026-10-24).
    const week = _buildSeedSection({ ticker: 'X', hotlist_facts: 'this week (2–10 days)', catalyst_facts: 'Prometheus (credible): target 54.20' })
    assert.doesNotMatch(week, /stop or target/)
    assert.match(week, /no entry, stop, and you build them with the user/)
    assert.match(week, /His target, when he set one, is the desk's price for this swing/)
    assert.match(week, /unless he says HOLD THROUGH it/)
    assert.doesNotMatch(_buildSeedSection({ ticker: 'SPCX' }), /HOTLIST/, 'an ordinary hand-off is unchanged')
})

// ─── The read API's service ───────────────────────────────────────────────────

test('today: the latest board in full, the day\'s checkpoints as one-liners', async () => {
    const { db, rows } = memDb()
    rows(BOARDS).push(
        { ...structuredClone(BOARD), id: 'hb_2026-10-21_premarket', checkpoint: 'premarket', finished_at: 1, counts: { graded: 4 }, argus: { summary: 'a' } },
        { ...structuredClone(BOARD), finished_at: 2, counts: { graded: 3 }, started_at: 99, scored: { mid: true } },
        { id: 'hb_2026-10-21_eod', day: '2026-10-21', status: 'running', finished_at: 3 },
    )
    const t = await todayHotlist({ deps: { db: async () => db, now: () => 10, latestRun: async () => null } })
    assert.equal(t.day, '2026-10-21')
    assert.equal(t.latest.id, 'hb_2026-10-21_mid', 'a running board is not shown')
    assert.equal(t.latest.started_at, undefined, 'no claim bookkeeping leaves the server')
    assert.deepEqual(t.checkpoints.map(c => c.checkpoint), ['premarket', 'mid'])
    assert.equal(t.checkpoints[0].argus, true)
})

test('Argus\'s read reports its spend under the house model id', async () => {
    const booked = []
    await argusRead(BOARD, {
        model: async () => 'gpt-6-luna',
        send: async ({ onUsage }) => { onUsage?.({ input_tokens: 5 }, 'wire'); return '{"summary":"s","picks":[],"avoid":[]}' },
        onUsage: (usage, model) => booked.push(model),
    })
    assert.deepEqual(booked, ['gpt-6-luna'])
})

// Day trades (Roy, 2026-10-24): no grade on the session columns; Argus reads the latest headlines in full.
test("Argus reads each name's latest headlines with their times, and no cell carries a grade", async () => {
    const { withNews } = await import('../../services/hotlist.boards.js')
    const headlines = new Map([['SPCX', [{ title: 'old', at: '2026-10-21 06:00:00' }, { title: 'new', at: '2026-10-21 09:15:00' },
        { title: 'mid', at: '2026-10-21 08:00:00' }, { title: 'oldest', at: '2026-10-20 19:00:00' }]]])
    const [row, other] = withNews([{ symbol: 'SPCX' }, { symbol: 'NONE' }], headlines)
    assert.deepEqual(row.news.map(h => h.title), ['new', 'mid', 'old'], 'newest first, three')
    assert.equal(other.news, undefined)
    const t = boardText({ checkpoint: 'preopen', day: '2026-10-21', columns: ['open', 'week'], rows: [{ symbol: 'SPCX', price: 10, gap_pct: 5, atr_pct: 4,
        catalyst: { material: true, type: 'drift', surprise: 'positive' }, news: row.news,
        cells: { open: { grade: 'A', range: { pct: 2, atr_mult: 0.5, level: 11 } }, week: { grade: 'B', range: { pct: 3, atr_mult: 1, level: 12 } } } }] })
    assert.match(t, /news: "new" \(09:15\); "mid" \(08:00\); "old" \(06:00\)/)
    assert.match(t, /open \(2\.00% \/ 0\.50× ATR to 11\.00\); week \(3\.00%/, 'no letter on the open or the week')
    assert.doesNotMatch(SYSTEM, /A\/B\/C/)
})

test('the hand-off facts say no grade, on a session column or this week', () => {
    const row = { symbol: 'X', gap_pct: 2, cells: { open: { grade: 'A', range: { pct: 2, atr_mult: 0.5, level: 11 } }, week: { grade: 'B', range: { pct: 3, atr_mult: 1, level: 12 } } } }
    assert.match(seedFacts(row, 'open'), /^the session open — \+2\.00% gap/)
    assert.match(seedFacts(row, 'week'), /^this week \(2–10 days\) — /)
})
