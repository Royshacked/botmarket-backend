// The industry screener — the read side of the engine's numbers, and the rules that turn them into a
// verdict (docs/design/industry-screener.md).
//
// aether-engine writes, weekly (scripts/run_screener_timing.py):
//   industry_timing       one row per GICS sub-industry per run: timing scores Q6-Q10 and the Q12 flag,
//                         quality Q1-Q5 with a reason each, the raw numbers and the leading stocks
//   market_regime         Step 1, one document per run date
//   industry_timing_runs  each run and its coverage (a PARTIAL run is not screened)
//
// DATA AND RULES, not judgment. Pythia's agent adds the one judgment input — Q11, a dated catalyst — and
// the notes; the bucket is then MECHANICAL, from Roy's spec as amended (§4), so the same numbers always
// give the same verdict. All three collections live in the ENGINE's database (services/engineDb.js).

import { getEngineDb } from '../../services/engineDb.js'

export const TIMING = 'industry_timing'
export const REGIME = 'market_regime'
export const TIMING_RUNS = 'industry_timing_runs'

/** Q11 (Roy, 2026-10-08): 2 only for a DATED event inside this many days of the run. */
export const CATALYST_WINDOW_DAYS = 28
export const QUALITY_GOOD = 7          // spec: Quality >= 7
export const TIMING_GOOD = 8           // spec: Timing >= 8 (of 12)

/**
 * The buckets, best first, with what the board says (§4). `trade` and `horizon` are Pythia's published
 * verdict: whether to trade the industry now, and on which horizon.
 */
export const BUCKETS = Object.freeze({
    swing_long: { label: 'Good now — swing and long term',            trade: 'yes',  horizon: 'swing_and_long' },
    extended:   { label: 'Good, but extended — wait for a pullback',  trade: 'wait', horizon: 'swing_and_long' },
    swing_only: { label: 'Good now for swing only',                    trade: 'yes',  horizon: 'swing' },
    long_watch: { label: 'Good for long term — not the moment yet',    trade: 'wait', horizon: 'long' },
    avoid:      { label: 'Not good now',                                trade: 'no',   horizon: null },
})
export const BUCKET_ORDER = Object.keys(BUCKETS)

/**
 * In a Red regime "downgrade every Swing bucket by one level" (spec). Read as: the swing half of the
 * verdict goes — a swing-and-long industry keeps only its long-term case; swing-only becomes avoid.
 */
const RED_DOWNGRADE = { swing_long: 'long_watch', extended: 'long_watch', swing_only: 'avoid' }

/**
 * The bucket for one industry. Pure. `timing` is out of 12 (the engine's Q6-Q10 plus Q11).
 * → `{ bucket, downgraded }`.
 */
export function bucketFor({ quality, timing, q9, q12, regime }) {
    let bucket
    if (timing >= TIMING_GOOD) {
        if (quality >= QUALITY_GOOD) bucket = (q9 === 0 || q12 === 'crowded') ? 'extended' : 'swing_long'
        else bucket = 'swing_only'
    } else {
        bucket = quality >= QUALITY_GOOD ? 'long_watch' : 'avoid'
    }
    if (regime === 'red' && RED_DOWNGRADE[bucket]) return { bucket: RED_DOWNGRADE[bucket], downgraded: true }
    return { bucket, downgraded: false }
}

/**
 * Does Pythia's agent need to look at this industry this week? Pure. Q11 (up to 2 points) can change the
 * bucket only when the engine's timing is 6 or 7 — at 8 it is already over the line, at 5 or less it
 * cannot get there — and the top two buckets need the agent's notes (spec, output item 3).
 */
export function needsAgent(row, regime) {
    const t = row?.scores?.timing_partial
    if (typeof t !== 'number' || !row?.scores?.timing_answered) return false
    if (t === TIMING_GOOD - 2 || t === TIMING_GOOD - 1) return true
    const { bucket } = bucketFor({ quality: row.quality?.quality ?? 0, timing: t, q9: row.scores.q9, q12: row.scores.q12, regime })
    return bucket === 'swing_long' || bucket === 'extended'
}

const _date = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null)
const _str = (v, max = 800) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const _days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

/**
 * One <industry_screen> block from the agent, checked. Pure → `{ ok, screen }` or `{ ok:false, detail }`.
 *
 * Q11 = 2 is a CLAIM about a date, so the code checks it: an event date inside [asof, asof + 28 days]
 * and a mechanism. A 2 without them is not refused — it is marked down to 1 when the agent gave a
 * driver, 0 when it gave nothing — and the downgrade is recorded, so the board never shows a 2 that
 * names no date.
 */
export function checkScreen(block, asof) {
    if (!block || typeof block !== 'object') return { ok: false, detail: 'no block' }
    const code = _str(block.industry, 16)
    if (!code || !/^\d{8}$/.test(code)) return { ok: false, detail: 'industry must be the 8-digit GICS code' }
    const raw = Number(block.q11)
    if (![0, 1, 2].includes(raw)) return { ok: false, detail: `${code}: q11 must be 0, 1 or 2` }
    const reason = _str(block.q11_reason, 400)
    const eventDate = _date(block.event_date)
    const mechanism = _str(block.mechanism, 300)
    let q11 = raw
    let corrected = null
    if (q11 === 2) {
        const inWindow = eventDate && _days(asof, eventDate) >= 0 && _days(asof, eventDate) <= CATALYST_WINDOW_DAYS
        if (!inWindow || !mechanism) {
            q11 = reason ? 1 : 0
            corrected = !eventDate ? 'no event date' : !inWindow ? `event date ${eventDate} is not within ${CATALYST_WINDOW_DAYS} days of ${asof}` : 'no mechanism'
        }
    }
    if (q11 === 1 && !reason) { q11 = 0; corrected = corrected ?? 'no driver named' }
    return {
        ok: true,
        screen: {
            code, q11, q11_reason: reason, event_date: q11 === 2 ? eventDate : null, mechanism: q11 === 2 ? mechanism : null,
            notes: _str(block.notes, 900), main_risk: _str(block.main_risk, 300),
            ...(corrected ? { q11_claimed: raw, q11_corrected: corrected } : {}),
        },
    }
}

/**
 * The published screen rows: the engine's numbers, the agent's Q11 and notes where it looked, the
 * bucket, and the change since the previous screen. Pure. `prev` is the previous screen's rows by code.
 */
export function composeRows(rows, agentByCode, regime, prevByCode = new Map()) {
    return rows.map(r => {
        const a = agentByCode.get(r.code) ?? null
        const engineTiming = r.scores?.timing_partial ?? 0
        const q11 = a ? a.q11 : null
        const timing = engineTiming + (q11 ?? 0)
        const quality = r.quality?.quality ?? 0
        const scored = Boolean(r.scores?.timing_answered)
        const { bucket, downgraded } = scored
            ? bucketFor({ quality, timing, q9: r.scores.q9, q12: r.scores.q12, regime })
            : { bucket: null, downgraded: false }
        const prev = prevByCode.get(r.code)
        return {
            code: r.code, name: r.name, sector: r.sector, basket: r.basket, basket_name: r.basket_name,
            bucket, ...(bucket ? { label: BUCKETS[bucket].label, trade: BUCKETS[bucket].trade, horizon: BUCKETS[bucket].horizon } : { label: null, trade: null, horizon: null }),
            red_downgrade: downgraded,
            quality, timing, timing_engine: engineTiming,
            q11, q11_reason: a?.q11_reason ?? (scored ? 'not assessed: Q11 could not change this bucket' : null),
            event_date: a?.event_date ?? null, mechanism: a?.mechanism ?? null,
            ...(a?.q11_corrected ? { q11_claimed: a.q11_claimed, q11_corrected: a.q11_corrected } : {}),
            notes: a?.notes ?? null, main_risk: a?.main_risk ?? null,
            scores: r.scores ?? {}, quality_detail: r.quality ?? {}, leaders: r.raw?.leaders ?? [],
            na: { ...(r.raw?.na ?? {}), ...(r.quality?.na ? { quality: r.quality.na } : {}) },
            previous_bucket: prev?.bucket ?? null,
            changed: Boolean(prev && prev.bucket !== bucket),
        }
    }).sort((x, y) => (_rank(x.bucket) - _rank(y.bucket)) || (y.timing - x.timing) || x.name.localeCompare(y.name))
}

/** Board order: best bucket first, an unscored industry last. */
const _rank = (b) => (b ? BUCKET_ORDER.indexOf(b) : BUCKET_ORDER.length)

// ─── reads ────────────────────────────────────────────────────────────────────

const _io = { db: () => getEngineDb() }
/** Test seam. */
export function _setScreenerIO(io) { Object.assign(_io, io) }

/** The latest COMPLETE (non-partial) engine run → `{ asof, run }` or null. */
export async function latestRun() {
    const db = await _io.db()
    const run = await db.collection(TIMING_RUNS).find({ partial: false }).sort({ asof: -1, finished_at: -1 }).limit(1).next()
    return run ? { asof: run.asof, run } : null
}

/** Every industry_timing row and the regime for one run date. */
export async function readRun(asof) {
    const db = await _io.db()
    const [rows, regime] = await Promise.all([
        db.collection(TIMING).find({ asof }, { projection: { _id: 0 } }).toArray(),
        db.collection(REGIME).findOne({ _id: asof }),
    ])
    return { rows, regime }
}

/**
 * One sub-industry's row from the latest COMPLETE run, and that run's regime → `{ row, regime }`, either
 * null when missing. For Pythia's assessment (pythia-assessment.md §4.2): how far the price has moved.
 */
export async function readTimingRow(code) {
    const latest = await latestRun()
    if (!latest) return { row: null, regime: null }
    const db = await _io.db()
    const [row, regime] = await Promise.all([
        db.collection(TIMING).findOne({ asof: latest.asof, code }, { projection: { _id: 0 } }),
        db.collection(REGIME).findOne({ _id: latest.asof }),
    ])
    return { row, regime }
}

/**
 * Several sub-industries' rows from ONE latest complete run, and its regime → `{ rows: Map(code → row),
 * regime }` — so a theme's links all come from the same run (a per-link read could straddle a run that
 * completed mid-way), in one query.
 */
export async function readTimingRows(codes) {
    const latest = await latestRun()
    if (!latest || !codes?.length) return { rows: new Map(), regime: null }
    const db = await _io.db()
    const [rows, regime] = await Promise.all([
        db.collection(TIMING).find({ asof: latest.asof, code: { $in: [...codes] } }, { projection: { _id: 0 } }).toArray(),
        db.collection(REGIME).findOne({ _id: latest.asof }),
    ])
    return { rows: new Map(rows.map(r => [r.code, r])), regime }
}

// ─── the agent's input (pure) ─────────────────────────────────────────────────

const pct = (v, d = 1) => (typeof v === 'number' ? `${(v * 100).toFixed(d)}%` : 'n/a')

/** One industry as the agent reads it in a screen batch. Pure. */
export function formatScreenRow(r) {
    const s = r.scores ?? {}, q = r.quality ?? {}, x = r.raw ?? {}
    const why = (s.timing_partial === TIMING_GOOD - 2 || s.timing_partial === TIMING_GOOD - 1)
        ? `Q11 decides its bucket (engine timing ${s.timing_partial}/10: needs ${TIMING_GOOD - s.timing_partial} catalyst point${TIMING_GOOD - s.timing_partial > 1 ? 's' : ''} to reach ${TIMING_GOOD})`
        : 'top bucket: needs notes'
    const leaders = (x.leaders ?? []).map(l => `${l.symbol} (6-1 ${pct(l.ret_6_1, 0)}, ${pct(l.from_high, 0)} from high)`).join(', ') || 'none qualify'
    return [
        `${r.code} ${r.name} [${r.sector}]${r.basket_name && r.basket_name !== r.name ? ` — measured at ${r.basket_name}` : ''} — ${why}`,
        `  quality ${q.quality ?? '?'}/10: Q1 ${q.q1 ?? '-'} ${q.q1_reason ?? ''} | Q2 ${q.q2 ?? '-'} ${q.q2_reason ?? ''} | Q3 ${q.q3 ?? '-'} ${q.q3_reason ?? ''} | Q4 ${q.q4 ?? '-'} | Q5 ${q.q5 ?? '-'} (${q.cycle_stage ?? '?'})`,
        `  timing ${s.timing_partial ?? '?'}/10 before Q11: RS ${s.q6 ?? '-'} · trend ${s.q7 ?? '-'} · breadth ${s.q8 ?? '-'} (${pct(x.breadth, 0)}) · extension ${s.q9 ?? '-'} (${pct(x.ext_50)} above the 50-day) · range/liquidity ${s.q10 ?? '-'}; volume ${s.q12 ?? '-'}; 12-1 ${pct(x.ret_12_1, 0)}, 1m vs S&P ${pct(x.rel_1m)}`,
        `  leaders: ${leaders}`,
    ].join('\n')
}

/** The headless instruction for one batch. Pure. */
export function screenPrompt(rows, asof, regime) {
    const until = new Date(Date.parse(asof) + CATALYST_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
    return [
        `WEEKLY INDUSTRY SCREEN — engine run of ${asof}; market regime ${String(regime?.regime ?? 'unknown').toUpperCase()}.`,
        `For each industry below, score Q11 (catalyst) under the rule in your instructions — a DATED event between ${asof} and ${until} — and, for the top-bucket ones, write the notes.`,
        `The bucket is computed by code from these numbers and your Q11; you do not choose it. End with one <industry_screen> block per industry.`,
        '',
        ...rows.map(formatScreenRow),
    ].join('\n')
}
