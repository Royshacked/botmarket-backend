// Pythia's weekly CHANGE SCAN — which industries and themes to assess this week (docs/design/pythia-assessment.md
// §8, build step 6). No model: code compares what is measured NOW with what the standing assessment was made
// on, and flags a subject only when something MOVED since — the price, the money — or the assessment ran out.
// An LLM pass over 163 sub-industries and the themes every week would be the expensive way to learn that most
// of them did not change.
//
// Every comparison is against the facts FROZEN on the assessment (its `moved` and `money`), not against last
// week's run. So a subject Pythia has just reassessed carries this run's facts and cannot be flagged again by
// them — which also makes a weekly run that was interrupted safe to rerun: what it already did drops out.
//
// Not scanned yet, by design: news volume (an FMP call per industry, on the key the live loops share) and
// geopolitics (step 4); `change_view_if` is free text a model would have to read. Each joins here when its input
// exists. Insiders, funds and government (step 8) are scanned since 2026-10-12 — against the flows FROZEN on the
// assessment only: an assessment made before step 8 (or a theme, whose links carry companies' money only) has
// none, and comparing today's crowding with nothing would flag every crowded industry every week.

import { ordinal } from './industryAssessment.service.js'

/** The thresholds. Each one is a "something moved" line, not a signal: crossing it buys an assessment. */
export const SCAN = Object.freeze({
    SHARP_MOVE_1M: 0.10,     // the basket's last month against the S&P, either way
    EXCESS_SHIFT: 0.20,      // the 12-month excess over SPY changed by 20 points since the assessment
    STRETCHED: 0.90,         // the extension's percentile in its own two years crossed above this…
    WASHED_OUT: 0.10,        // …or below this
    MONEY_TURN: 0.10,        // capex or buybacks turned (sign flip) and the new change is at least this big
    // Funds' crowding is SHOWN (tool, board) but not SCANNED yet: on the first live read (2026-10-12) 66 of 163
    // sub-industries sat at the top of their own seven quarters at once — a steady drift makes "the top of its own
    // range" fire on most of them, which would buy dozens of reassessments a week on nothing. Turn it on once the
    // history is long enough that the top of the range is rare (and say how rare it measured).
    CROWDED_SCANNED: false,
    CROWDED: 0.90,           // funds' share against the market crossed into the top of its own range…
    CROWD_MIN_QUARTERS: 4,   // …ranked against at least this many quarters
    CONTRACTS_SHIFT: 0.25,   // federal contract money on its lines moved 25%+ (four quarters on the four before)…
    CONTRACTS_MIN_USD: 1e9,  // …on at least $1B a year, this year's or last (a fall below $1B counts): a small line's swing is noise
    CONTRACTS_GAP: 0.5,      // and the frozen change was under half the line (or the other way): revisions near 25% do not re-fire
})

/**
 * Each reason a subject can be flagged for, with its weight (the week's order: the biggest change first) and
 * the words the board shows. `unassessed` weighs least: the backlog drains behind what is moving.
 */
export const REASONS = Object.freeze({
    hype_new:      { weight: 5, text: 'the hype flag turned on' },
    sharp_move:    { weight: 4, text: 'a sharp move against the market in the last month' },
    capex_turn:    { weight: 3, text: 'capex turned' },
    excess_shift:  { weight: 3, text: 'its 12-month move against SPY shifted' },
    stretched:     { weight: 3, text: 'stretched to the top of its own two-year range' },
    washed_out:    { weight: 3, text: 'fell to the bottom of its own two-year range' },
    hype_cleared:  { weight: 3, text: 'the hype flag cleared' },
    decider_due:   { weight: 4, text: 'the date its watch named has come' },
    expired:       { weight: 2, text: 'the assessment expired' },
    buyback_turn:  { weight: 2, text: 'buybacks turned' },
    insider_cluster: { weight: 2, text: 'insiders at several of its companies started buying' },
    crowded:       { weight: 2, text: "funds' ownership reached the top of its range" },
    contracts_shift: { weight: 2, text: 'federal contract money on its lines shifted' },
    link_moved:    { weight: 0, text: 'a link in its chain moved' },   // weighs as its links' biggest reason
    unassessed:    { weight: 1, text: 'never assessed' },
})

const _n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const _pct = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`
const _turned = (now, then) => _n(now) != null && _n(then) != null && Math.sign(now) !== Math.sign(then) && Math.abs(now) >= SCAN.MONEY_TURN

/**
 * What changed between the facts an assessment was made on (`then`) and today's (`now`), each `{ moved, money }`
 * shaped as on the assessment (industryAssessment.factsFor, industryData.moneyFacts). Pure → `[{ key, detail }]`.
 *
 * The price legs fire only when there IS a newer price run than the assessment's (`moved.asof`): the same run's
 * numbers read twice are not a change. The money legs compare whatever the metrics hold now.
 */
export function changes(now, then) {
    const out = []
    const m = now?.moved, t = then?.moved
    if (m && (!t?.asof || !m.asof || m.asof > t.asof)) {
        // The hype flag is compared only on the same BASIS: an assessment frozen under the equal-weight flag read
        // against today's size-weighted one would "clear" hypes nothing moved (code review 2026-10-11).
        const sameBasis = !t || (t.hype_basis ?? null) === (m.hype_basis ?? null)
        if (sameBasis && m.hype === true && t?.hype !== true) {
            // In the flag's own numbers — by size — and never a missing value printed as +0%.
            const r = _n(m.ret_24m_vw) ?? _n(m.ret_24m), b = _n(m.spy_24m_vw) ?? _n(m.spy_24m)
            out.push({ key: 'hype_new', detail: r != null && b != null ? `24m ${_pct(r)} by size vs SPY ${_pct(b)}` : null })
        }
        if (sameBasis && m.hype === false && t?.hype === true) out.push({ key: 'hype_cleared', detail: null })
        // A NEW sharp month: the assessment had not already seen one this size, this way (code review 2026-10-11: the
        // trailing month holds a move for ~4 weekly runs, and each re-fired a paid reassessment).
        const r1 = _n(m.rel_1m), r0 = _n(t?.rel_1m)
        const seen = r0 != null && Math.abs(r0) >= SCAN.SHARP_MOVE_1M && Math.sign(r0) === Math.sign(r1)
        if (r1 != null && Math.abs(r1) >= SCAN.SHARP_MOVE_1M && !seen) out.push({ key: 'sharp_move', detail: `${_pct(r1)} against the S&P in a month` })
        if (_n(m.excess_12m) != null && _n(t?.excess_12m) != null && Math.abs(m.excess_12m - t.excess_12m) >= SCAN.EXCESS_SHIFT) {
            out.push({ key: 'excess_shift', detail: `12m vs SPY ${_pct(t.excess_12m)} → ${_pct(m.excess_12m)}` })
        }
        const p = _n(m.ext_percentile), q = _n(t?.ext_percentile)
        if (p != null && p >= SCAN.STRETCHED && (q == null || q < SCAN.STRETCHED)) out.push({ key: 'stretched', detail: `${Math.round(p * 100)}th percentile` })
        if (p != null && p <= SCAN.WASHED_OUT && (q == null || q > SCAN.WASHED_OUT)) out.push({ key: 'washed_out', detail: `${Math.round(p * 100)}th percentile` })
    }
    const mo = now?.money, to = then?.money
    if (_turned(mo?.capex_change, to?.capex_change)) out.push({ key: 'capex_turn', detail: `capex ${_pct(to.capex_change)} → ${_pct(mo.capex_change)}` })
    if (_turned(mo?.buybacks_change, to?.buybacks_change)) out.push({ key: 'buyback_turn', detail: `buybacks ${_pct(to.buybacks_change)} → ${_pct(mo.buybacks_change)}` })
    out.push(...flowChanges(now?.flows, then?.flows))
    return out
}

/**
 * Step 8's legs: insiders, funds, government — today's flows against the FROZEN ones. Nothing without frozen
 * flows (see the header). Pure → `[{ key, detail }]`.
 */
export function flowChanges(now, then, scan = SCAN) {
    if (!now || !then) return []
    const out = []
    const i = now.insiders, ti = then.insiders
    // A cluster STARTING buys a look; one ending does not — it had no tested edge, and its 90-day window ends every
    // cluster about 13 weeks on, which would buy a second paid run for nothing (QA 2026-10-12). The tool and the
    // board show the cluster as it stands.
    if (i && ti && i.cluster && !ti.cluster) out.push({ key: 'insider_cluster', detail: `${i.companies_buying} of ${i.n_companies} companies` })
    const f = now.funds, tf = then.funds
    if (scan.CROWDED_SCANNED && f && tf && _n(f.percentile) != null && f.history_quarters >= scan.CROWD_MIN_QUARTERS && f.percentile >= scan.CROWDED
        && !(_n(tf.percentile) != null && tf.percentile >= scan.CROWDED)) {
        out.push({ key: 'crowded', detail: `${ordinal(Math.round(f.percentile * 100))} percentile of ${f.history_quarters} quarters` })
    }
    const g = now.government, tg = then.government
    const size = Math.max(_n(g?.now) ?? 0, _n(g?.before) ?? 0)
    if (g && tg && _n(g.change) != null && Math.abs(g.change) >= scan.CONTRACTS_SHIFT && size >= scan.CONTRACTS_MIN_USD) {
        const was = _n(tg.change)
        if (was == null || Math.sign(was) !== Math.sign(g.change) || Math.abs(was) < scan.CONTRACTS_GAP * scan.CONTRACTS_SHIFT) {
            out.push({ key: 'contracts_shift', detail: `${_pct(g.change)} over a year` })
        }
    }
    return out
}

const _expired = (a, now) => Boolean(a?.expires_at) && Date.parse(a.expires_at) <= Date.parse(now)

/**
 * A WATCH names the date that decides it (`decides_by`, at most WATCH_MAX_DAYS out). Once that date has passed —
 * the day after it, so the report it waited for is out — the watch is due: reassessed now, not at its expiry.
 */
export function deciderDue(a, now) {
    if (a?.verdict !== 'watch' || !a.decides_by) return null
    const due = Date.parse(`${a.decides_by}T23:59:59Z`)
    return Number.isFinite(due) && due < Date.parse(now) ? { key: 'decider_due', detail: `decides by ${a.decides_by}` } : null
}
const _score = (reasons) => Math.max(0, ...reasons.map(r => r.weight ?? REASONS[r.key]?.weight ?? 0))
const _words = (r) => ({ ...r, weight: r.weight ?? REASONS[r.key]?.weight ?? 0, text: REASONS[r.key]?.text ?? r.key })

/**
 * One sub-industry → its flag, or null when nothing moved. `now` is today's `{ moved, money }`; `assessment`
 * the standing one (or null). Pure. → `{ kind, code, name, reasons, score, size }`; `size` (the 12-month move's
 * absolute size) orders the never-assessed backlog — the ones that moved most go first.
 */
export function scanIndustry({ code, name, now, assessment = null, at }) {
    let reasons
    if (!assessment) reasons = [{ key: 'unassessed', detail: null }]
    else {
        reasons = changes(now, { moved: assessment.moved, money: assessment.money, flows: assessment.flows ?? null })
        const due = deciderDue(assessment, at)
        if (due) reasons.push(due)
        if (_expired(assessment, at)) reasons.push({ key: 'expired', detail: `on ${String(assessment.expires_at).slice(0, 10)}` })
    }
    if (!reasons.length) return null
    const words = reasons.map(_words)
    return { kind: 'industry', code, name, reasons: words, score: _score(words), size: Math.abs(_n(now?.moved?.excess_12m) ?? 0) }
}

/**
 * One APPROVED theme → its flag, or null. Its links are compared one by one with what the theme's assessment
 * froze for that link (its `moved.links` and `money.links`); a link that moved flags the theme at that link's
 * weight, named. `nowByCode` maps a sub-industry code to today's `{ moved, money }`. Pure.
 */
export function scanTheme({ theme, nowByCode, assessment = null, at }) {
    let reasons = []
    if (!assessment) reasons = [{ key: 'unassessed', detail: null }]
    else {
        const movedThen = new Map((assessment.moved?.links ?? []).map(l => [l.code, l]))
        const moneyThen = new Map((assessment.money?.links ?? []).map(l => [l.code, l]))
        const moved = []
        for (const link of theme.links ?? []) {
            if (link.order > 2) continue   // the suppliers' suppliers are context; a move there is not the theme's
            const now = nowByCode.get(link.code)
            if (!now) continue
            const then = movedThen.get(link.code)
            // Each frozen link carries its own run date (industryAssessment.themeFacts).
            const c = changes(now, { moved: then ?? null, money: moneyThen.get(link.code) ?? null })
            if (c.length) moved.push({ link, weight: _score(c.map(_words)), keys: c.map(x => x.key) })
        }
        if (moved.length) {
            moved.sort((a, b) => b.weight - a.weight)
            reasons.push({ key: 'link_moved', weight: moved[0].weight,
                detail: moved.slice(0, 3).map(x => `${x.link.name} (${x.keys.map(k => REASONS[k].text).join(', ')})`).join('; ') })
        }
        const due = deciderDue(assessment, at)
        if (due) reasons.push(due)
        if (_expired(assessment, at)) reasons.push({ key: 'expired', detail: `on ${String(assessment.expires_at).slice(0, 10)}` })
    }
    if (!reasons.length) return null
    const words = reasons.map(_words)
    return { kind: 'theme', id: theme.id, name: theme.name, reasons: words, score: _score(words), size: assessment ? 0 : THEME_FIRST }
}

/**
 * A never-assessed APPROVED theme goes ahead of the never-assessed industries: an admin approving it was the
 * request to assess it, and by the 12-month size it would sort last (2026-10-11 dry run: behind 162 industries).
 * Larger than any industry's |12-month excess| can plausibly be.
 */
export const THEME_FIRST = 100

/**
 * The week's list: every flag, biggest change first, then by size; `cap` of them are assessed, the rest wait for
 * next week (where they will still be flagged — nothing is lost, only queued). Pure → `{ picked, waiting }`.
 */
export function pickForWeek(flags, cap) {
    const sorted = [...flags].sort((a, b) => (b.score - a.score) || (b.size - a.size) || String(a.name).localeCompare(String(b.name)))
    const n = Math.max(0, Math.floor(Number(cap) || 0))
    return { picked: sorted.slice(0, n), waiting: sorted.slice(n) }
}
