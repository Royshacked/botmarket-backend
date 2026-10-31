// THE RUN-UP YARDSTICK — what a stock has done INTO its own reports (docs/design/horizon-chains.md §3, "Found live").
//
// A Hotlist "this week" name with a report inside the window is a run-up trade: in on the board, out the day before the
// report. compute_event_delta cannot size that — nothing has happened yet, so there is no event to put in revenue terms
// (RCL, 2026-10-23: a pass with no target). The honest yardstick is the stock's own record: over each of its last
// reports, the move from the same number of sessions before the report to the close before it, and the same for SPY.
// The median is the target, the quartiles the band; the options' implied move is the outside check (the prompt's).
//
// Deterministic: the tool reads the report dates and the daily closes and does the arithmetic; the model copies its
// line into the <catalyst_read> block as `runup`, and catalystRead.service turns it into the target.

import { getEarningsRowsRaw } from '../../providers/fmp.provider.js'
import { getTickerAggregates } from '../../providers/candles.provider.js'
import { makeToolHandler } from '../agentUtils.js'

const LOG = '[runupTools]'
const DAY_MS = 86_400_000
/** Sessions before a report a run-up is measured over: at least 2, at most 15 (three weeks). */
export const LEAD_MIN = 2, LEAD_MAX = 15
/**
 * The FULL run-up a cycle is measured against: the sessions before a report a run-up usually takes (Roy, 2026-10-24:
 * "run-up reads — explain" → the read did not know how far the stock had ALREADY run this cycle). Measuring only from
 * today, a stock up 5% over the last week into its report still looked like it had its whole usual run-up ahead.
 */
export const FULL_LEAD = 10

/**
 * This cycle's move so far: the last close against the close `elapsed` sessions before it — the start of the full
 * run-up window. Pure. A bar dated `today` (a session in progress) is left out: the read prices from the last close.
 * Null when there is nothing elapsed or too few bars.
 */
export function soFarPct(bars, elapsed, today) {
    const closed = (bars ?? []).filter(b => _etDay(b.timestamp) < today && b.close > 0)
    if (!(elapsed > 0) || closed.length <= elapsed) return null
    return _r2((closed.at(-1).close / closed.at(-1 - elapsed).close - 1) * 100)
}

/** Whether this cycle has already moved its usual full run-up — then nothing typical is left for the trade. Pure. */
export function runupSpent({ full_median_pct, so_far_pct } = {}) {
    return Number.isFinite(full_median_pct) && full_median_pct > 0 && Number.isFinite(so_far_pct) && so_far_pct >= full_median_pct
}
/** Fewer past reports than this and the record says nothing. */
export const MIN_REPORTS = 4

const _r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const _etDay = (ts) => new Date(ts > 1e12 ? ts : ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

/** Weekdays strictly between `from` and `report` (YYYY-MM-DD) — the sessions left to hold before the report. Pure. */
export function sessionsBefore(from, report) {
    let n = 0
    for (let t = Date.parse(`${from}T12:00:00Z`) + DAY_MS; t < Date.parse(`${report}T12:00:00Z`); t += DAY_MS) {
        const d = new Date(t).getUTCDay()
        if (d !== 0 && d !== 6) n++
    }
    return n
}

/** The q-quantile of a sorted array, interpolated. Pure. */
function _quantile(sorted, q) {
    if (!sorted.length) return null
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

/**
 * The run-up record. Pure. `reports` — past report dates (YYYY-MM-DD); `bars` / `spyBars` — ascending daily candles
 * ({timestamp, close}); `lead` — sessions. For each report: entry = the close `lead` sessions before the last session
 * BEFORE the report, exit = that last session's close (safe for a report before the open or after the close alike).
 * → `{ n, rows, median_pct, mean_pct, p25_pct, p75_pct, up_share, median_excess_pct }`, the stats null when n is 0.
 */
export function runUpStats({ reports = [], bars = [], spyBars = [], lead }) {
    const days = bars.map(b => _etDay(b.timestamp))
    const spy = new Map(spyBars.map(b => [_etDay(b.timestamp), b.close]))
    const rows = []
    for (const report of [...new Set(reports)].sort().reverse()) {
        let exit = -1
        for (let i = days.length - 1; i >= 0; i--) if (days[i] < report) { exit = i; break }
        const entry = exit - lead
        if (exit < 0 || entry < 0 || !(bars[entry].close > 0)) continue
        const pct = (bars[exit].close / bars[entry].close - 1) * 100
        const s0 = spy.get(days[entry]), s1 = spy.get(days[exit])
        const spyPct = s0 > 0 && s1 > 0 ? (s1 / s0 - 1) * 100 : null
        rows.push({ report, from: days[entry], to: days[exit], pct: _r2(pct), excess_pct: spyPct == null ? null : _r2(pct - spyPct) })
    }
    const sorted = rows.map(r => r.pct).sort((a, b) => a - b)
    const ex = rows.map(r => r.excess_pct).filter(v => v != null).sort((a, b) => a - b)
    const n = rows.length
    return {
        n, rows,
        median_pct: _r2(_quantile(sorted, 0.5)),
        mean_pct:   n ? _r2(sorted.reduce((a, b) => a + b, 0) / n) : null,
        p25_pct:    _r2(_quantile(sorted, 0.25)),
        p75_pct:    _r2(_quantile(sorted, 0.75)),
        up_share:   n ? _r2(rows.filter(r => r.pct > 0).length / n) : null,
        median_excess_pct: _r2(_quantile(ex, 0.5)),
    }
}

/**
 * THROUGH THE REPORT (docs/design/runup-reads.md §3): over each past report, the close of the last session BEFORE it to
 * the close of the first session AFTER it — the reaction whether the report came before the open or after the close.
 * Pure. `beats` — the report dates that beat (actual over estimate). → `{ n, median_pct, p25_pct, p75_pct, up_share,
 * beat_n, beat_median_pct }`, the stats null when n is 0.
 */
export function throughStats({ reports = [], bars = [], beats = [] }) {
    const days = bars.map(b => _etDay(b.timestamp))
    const beat = new Set(beats)
    const rows = []
    for (const report of [...new Set(reports)].sort().reverse()) {
        let before = -1
        for (let i = days.length - 1; i >= 0; i--) if (days[i] < report) { before = i; break }
        const after = days.findIndex(d => d > report)
        if (before < 0 || after < 0 || !(bars[before].close > 0)) continue
        rows.push({ report, pct: _r2((bars[after].close / bars[before].close - 1) * 100), beat: beat.has(report) })
    }
    const stat = (rs) => {
        const sorted = rs.map(r => r.pct).sort((a, b) => a - b)
        return { median: _r2(_quantile(sorted, 0.5)), p25: _r2(_quantile(sorted, 0.25)), p75: _r2(_quantile(sorted, 0.75)),
            up: rs.length ? _r2(rs.filter(r => r.pct > 0).length / rs.length) : null }
    }
    const all = stat(rows), beaten = rows.filter(r => r.beat)
    return { n: rows.length, rows, median_pct: all.median, p25_pct: all.p25, p75_pct: all.p75, up_share: all.up,
        beat_n: beaten.length, beat_median_pct: stat(beaten).median }
}

/** The tool's reply: the record per report, the summary, and the one line to copy. Pure. */
export function runUpReadText(sym, { report, lead, stats, cycle = null, through = null }) {
    const head = `${sym} — run-up into its reports, the last ${lead} session${lead === 1 ? '' : 's'} before each (close before the report):`
    if (stats.n < MIN_REPORTS) return `${head}\nOnly ${stats.n} past report${stats.n === 1 ? '' : 's'} with prices — too few to size a run-up. Say so; no runup line.`
    const lines = [head, ...stats.rows.map(r => `  ${r.report}: ${r.pct > 0 ? '+' : ''}${r.pct}% (${r.from} → ${r.to})${r.excess_pct != null ? `, ${r.excess_pct > 0 ? '+' : ''}${r.excess_pct}% vs SPY` : ''}`)]
    lines.push(`Median ${stats.median_pct}% (quartiles ${stats.p25_pct}% to ${stats.p75_pct}%), up ${Math.round(stats.up_share * 100)}% of the time, median vs SPY ${stats.median_excess_pct ?? 'n/a'}%.`)
    // THIS CYCLE: the usual FULL run-up, and how much of it the stock has already moved — the remaining median above is
    // what is typically left only if the cycle has not run yet.
    if (cycle?.full_median_pct != null && cycle.full_lead > lead) {
        const spent = runupSpent(cycle)
        lines.push(`This cycle: its usual run-up over the full ${cycle.full_lead} sessions before a report is a median ${cycle.full_median_pct}%; `
            + `over the ${cycle.full_lead - lead} sessions of it already gone it has moved ${cycle.so_far_pct ?? 'n/a'}%.`
            // Context, not a veto (runup-reads.md §1: a median under 1% made an ordinary up week "spent"; the rule never filtered on it).
            + (spent ? ' It has already moved as much as its usual full run-up — context: say whether that changes your call, and why.' : ''))
    }
    // Through the report (runup-reads.md §3): what holding the report itself has done — the question a `hold` answers.
    const hasThrough = through?.n >= MIN_REPORTS
    if (hasThrough) {
        lines.push(`Through the report (the close before each report to the close the session after it): median ${through.median_pct}% `
            + `(quartiles ${through.p25_pct}% to ${through.p75_pct}%), up ${Math.round(through.up_share * 100)}% of the time over ${through.n} reports`
            + `${through.beat_n ? `; after the ${through.beat_n} that beat, median ${through.beat_median_pct}%` : ''}.`)
    }
    const line = { basis: 'run_up', report, lead_days: lead, n: stats.n, median_pct: stats.median_pct, p25_pct: stats.p25_pct, p75_pct: stats.p75_pct,
        up_share: stats.up_share, median_excess_pct: stats.median_excess_pct,
        ...(cycle?.full_median_pct != null && cycle.full_lead > lead ? { full_lead: cycle.full_lead, full_median_pct: cycle.full_median_pct, so_far_pct: cycle.so_far_pct ?? null } : {}),
        ...(hasThrough ? { through_n: through.n, through_median_pct: through.median_pct, through_p25_pct: through.p25_pct, through_p75_pct: through.p75_pct,
            through_up_share: through.up_share, through_beat_median_pct: through.beat_median_pct } : {}) }
    lines.push(`Copy this line, unchanged, as "runup" in your block: ${JSON.stringify(line)}`)
    return lines.join('\n')
}

const _io = {
    earnings: (sym) => getEarningsRowsRaw(sym, 12),
    bars:     (sym, from, to) => getTickerAggregates(sym, { timeSpan: 'day', multiplier: 1, from, to }),
    today:    () => _etDay(Date.now()),
}
/** Test seam. */
export function _setIO(io) { Object.assign(_io, io) }

async function _getRunupHistory({ ticker, lead_days } = {}) {
    const sym = String(ticker || '').toUpperCase().trim()
    if (!sym) throw new Error('no ticker')
    const today = _io.today()
    const rows = (await _io.earnings(sym)) ?? []
    // The next report: the first one not yet reported — TODAY's included (after the close, it has no actual yet), or the
    // tool would skip to next quarter's (code review 2026-10-24).
    const next = rows.filter(r => r.date && r.date >= today && r.epsActual == null).map(r => r.date).sort()[0] ?? null
    const past = rows.filter(r => r.date && r.date <= today && r.epsActual != null).map(r => r.date)
    if (!next) return `${sym}: no report date ahead in the feed — this is not a run-up trade. No runup line.`
    if (next === today) return `${sym}: the report is TODAY (${next}) — no run-up is left to trade; out before it. No runup line.`
    // A report past the short swing's reach is not a run-up inside the window — the line would size a move weeks away.
    const left = sessionsBefore(today, next) + 1
    if (left > LEAD_MAX) return `${sym}: the next report (${next}) is ${left} sessions away — past a short swing's window, so this is not a run-up trade. No runup line.`
    if (past.length < MIN_REPORTS) return `${sym}: only ${past.length} past reports in the feed — too few to size a run-up. No runup line.`
    const asked = Number(lead_days)
    const lead = Math.min(LEAD_MAX, Math.max(LEAD_MIN, Number.isFinite(asked) && asked > 0 ? Math.round(asked) : left))
    const from = Date.parse(`${[...past].sort()[0]}T00:00:00Z`) - 40 * DAY_MS
    const [bars, spyBars] = await Promise.all([_io.bars(sym, from, Date.now()), _io.bars('SPY', from, Date.now())])
    if (!bars?.length) throw new Error('no daily prices')
    const stats = runUpStats({ reports: past, bars, spyBars: spyBars ?? [], lead })
    // The full window and this cycle's share of it: only when part of it has already gone.
    const full = Math.max(lead, FULL_LEAD)
    const cycle = full > lead
        ? { full_lead: full, full_median_pct: runUpStats({ reports: past, bars, spyBars: [], lead: full }).median_pct, so_far_pct: soFarPct(bars, full - lead, today) }
        : null
    const beats = rows.filter(r => r.date && r.date <= today && r.epsActual != null && r.epsEstimated != null && Number(r.epsActual) > Number(r.epsEstimated)).map(r => r.date)
    const through = throughStats({ reports: past, bars, beats })
    return runUpReadText(sym, { report: next, lead, stats, cycle, through })
}

export const RUNUP_TOOLS = [{
    name: 'get_runup_history',
    description: 'The run-up yardstick for a name with a report AHEAD: over each of its last reports (up to 12), the move from `lead_days` sessions before the report to the close before it, and the same against SPY — the median, the quartiles, how often it rose; and the move THROUGH each report (the close before it to the close the session after), all and after beats — what holding the report has done. The target for a run-up trade (in now, out the day before the report) comes from this line, not from compute_event_delta, which needs an event that has happened. lead_days defaults to the sessions left until the report, today included.',
    input_schema: {
        type: 'object',
        properties: {
            ticker:    { type: 'string', description: 'e.g. RCL' },
            lead_days: { type: 'number', description: `Optional: sessions before the report to measure from (${LEAD_MIN}–${LEAD_MAX}). Omit to use the sessions left until the next report.` },
        },
        required: ['ticker'],
    },
}]

export const RUNUP_TOOL_HANDLERS = {
    get_runup_history: makeToolHandler('get_runup_history', _getRunupHistory, (e, { ticker }) => `Could not read the run-up record for ${ticker}: ${e.message}`, LOG),
}
