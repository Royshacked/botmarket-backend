// Step 6 of docs/design/pythia-industries-and-channels.md — the house table SIZED from a few macro
// calls, instead of written one row at a time.
//
//   Pythia:  channel_views   [{ channel_id, dz }]      "real yields fall 1.0 z over the horizon"
//            reactions       [{ bucket, channel_id, reaction: stronger|weaker|opposite, reason }]
//   code:    every fund's expected move beyond the market  E = Σ multiplier × beta × dz
//            → one row per sector, or its industries where they diverge → net to zero, cap
//
// WHY CHANNEL CALLS AND NOT §5's ELASTICITY. Measured 2026-10-01 (aether-engine/scratch/
// backtest_regime_elasticity.py, 66 dates since 2010, 61 funds): a regime-conditional elasticity
// had NO predictive power even with the coming regime known in advance (rank IC −0.02, t −0.6),
// while beta × the channel's ACTUAL move ranked the funds' next-26-week returns at IC +0.13, 68% of
// dates, t +2.8. The betas transmit a correct macro call into the right ranking; whether the call
// is correct is the desk's judgment, and it is now one number per channel that can be graded.
//
// OPTION 3, the reaction override: where Pythia has a reason to expect a bucket to respond
// differently from its history, it says how — never with a made-up decimal, which would only echo
// the beta it was just shown.
//
// SIZED ON THE DEVIATION FROM THE BASE RATE, not on the call. Each channel carries a base rate — what
// it has historically done over the next 26 weeks from where it sits (aether-engine
// state.base_rate). Measured 2026-10-01 (scratch/backtest_base_rate.py): that base rate calls the
// channel's direction 68% of the time (97% from |z| >= 2) and is PRICED — funds sized on it ranked at
// IC −0.05. So E = Σ multiplier × beta × (dz − base_dz): a call that only repeats history sizes
// nothing, and the table carries exactly the desk's disagreement with it. It also ended the sign
// flips: Pythia called real yields −0.8 then +0.8 on the same data, but against a base of −1.78 both
// were the same view — "less reversion than usual" — differing only in conviction. (The alternative,
// sizing on the call with the base rate as an anchor only, gives fuller tables; kept on file.)
//
// DATA VS JUDGMENT. This module is arithmetic. Which channels move, by how much, and which buckets
// react unusually are Pythia's; nothing here decides a view.

import { getDb }  from '../../providers/mongodb.provider.js'
import { toNum }  from '../../services/format.util.js'
import { BUCKET_PROXY, SECTORS, parentSector, resolveBucket } from '../../services/entity/vocabulary.js'
import { BETAS_COLLECTION } from './channelExposures.service.js'
import { LATEST_COLLECTION } from './channelState.service.js'
import { FUND_EVIDENCE_COLLECTION } from './industryReads.service.js'

/** How a stated reaction scales the measured beta. Coarse on purpose — see the header. */
export const REACTIONS = { stronger: 1.5, weaker: 0.5, opposite: -1 }

/** A channel call larger than this many z over one horizon is not a forecast, it is a typo. */
export const MAX_DZ = 3

/**
 * Split a sector into its industries when one of them is expected to move this much more or less than
 * the sector. 0.5%, down from 1% (2026-10-01): the threshold was set when only channels moved the
 * numbers, and an industry's evidence differs from its sector's by under a point — at 1% Semiconductors
 * (evidence +0.33, the strongest of any fund) never split out of Technology.
 */
export const SPLIT_THRESHOLD = 0.005

/**
 * The CHANNEL term's weight against the industry evidence. `beta × deviation` is the move IF the desk's
 * macro call is right; the evidence term is calibrated on what actually happened (K_EVIDENCE is a
 * measured slope). Unweighted, an unproven call outweighed measured evidence about 3 to 1, and tech —
 * sized on evidence alone — lost its rows to channel moves of several percent. 0.4: roughly the
 * evidence's strength against a PERFECT channel call (IC 0.083 vs 0.13), shrunk further for an
 * imperfect forecaster. A placeholder by design — once each call is graded at maturity, the desk's
 * measured hit rate replaces it. Decided with Roy, 2026-10-01.
 */
export const CHANNEL_CONFIDENCE = 0.4
/** An expected move smaller than this is no view: the bucket stays at benchmark weight. */
export const MIN_MOVE = 0.005
/** Per-row caps, bp. A narrow industry fund is a bigger bet per bp than an 11-sector fund (§11). */
export const CAP_BP = { sector: 200, industry: 100 }
/** A row sized below this after netting is rounding, not a stance. */
export const MIN_ROW_BP = 25

const _round5 = (v) => Math.round(v / 5) * 5

/**
 * INDUSTRY EVIDENCE → expected move: the fund's next-26-week return over SPY per unit of its
 * evidence score (centred -0.5..+0.5). MEASURED, not chosen: the mean cross-sectional slope over 66
 * dates since 2010 (aether-engine scratch/backtest_industry_reads.py), on the SHRUNK score production
 * writes (small samples pulled to the middle; median +0.058, t +1.6). It was 0.035 on the unshrunk
 * score — shrinking narrows the scores, so the same evidence needs a larger slope. A strongly
 * evidenced fund (score ~±0.4) expects about ±2% over the market from evidence alone: a tilt beside
 * the channel term, and the WHOLE of the sizing for tech, where no channel reaches.
 */
export const K_EVIDENCE = 0.055

// ─── inputs ───────────────────────────────────────────────────────────────────

const _io = {
    betas:  async () => (await getDb()).collection(BETAS_COLLECTION)
        .find({ status: 'measured' }, { projection: { _id: 0, symbol: 1, channel_id: 1, beta: 1, t_stat: 1, significant: 1 } }).toArray(),
    latest: async () => (await getDb()).collection(LATEST_COLLECTION).findOne({ _id: 'latest' }),
    evidence: async () => (await getDb()).collection(FUND_EVIDENCE_COLLECTION)
        .find({}, { projection: { evidence: 1, beat: 1, surprise: 1, momentum: 1 } }).toArray(),
}
export function _setSizingIO(io) { Object.assign(_io, io) }

/** → { betas, latest, evidence: { symbol: { score, beat, surprise, momentum } } } */
export async function readSizingInputs() {
    const [betas, latest, ev] = await Promise.all([_io.betas(), _io.latest(), _io.evidence ? _io.evidence() : []])
    const evidence = {}
    for (const d of Array.isArray(ev) ? ev : []) {
        const score = toNum(d?.evidence)
        if (d?._id && score !== null) evidence[d._id] = { score, beat: toNum(d.beat), surprise: toNum(d.surprise), momentum: toNum(d.momentum) }
    }
    return { betas, latest, evidence }
}

// ─── validation ───────────────────────────────────────────────────────────────

/** Channel calls as stored: known channel, finite non-zero dz within ±MAX_DZ, one per channel. */
export function normalizeViews(raw, knownChannels = null) {
    const seen = new Set()
    const out = []
    for (const v of Array.isArray(raw) ? raw : []) {
        const id = typeof v?.channel_id === 'string' ? v.channel_id.trim() : (typeof v?.channel === 'string' ? v.channel.trim() : '')
        const dz = toNum(v?.dz)
        // dz = 0 is a real call now ("the channel stays put"): against a base rate that expects it
        // to move, it is a deviation, and it sizes.
        if (!id || dz === null || Math.abs(dz) > MAX_DZ || seen.has(id)) continue
        if (knownChannels && !knownChannels.has(id)) continue
        seen.add(id)
        out.push({ channel_id: id, dz, rationale: typeof v.rationale === 'string' ? v.rationale.trim() || null : null })
    }
    return out
}

export function normalizeReactions(raw) {
    const out = []
    for (const r of Array.isArray(raw) ? raw : []) {
        const bucket = resolveBucket(r?.bucket)?.bucket
        const id = typeof r?.channel_id === 'string' ? r.channel_id.trim() : (typeof r?.channel === 'string' ? r.channel.trim() : '')
        if (!bucket || !id || !(r?.reaction in REACTIONS)) continue
        out.push({ bucket, channel_id: id, reaction: r.reaction, reason: typeof r.reason === 'string' ? r.reason.trim() || null : null })
    }
    return out
}

/**
 * Exclusions as stored: [{ bucket, reason }]. A bare string is accepted and kept with a null
 * reason, so the preview can say it is missing — leaving a bucket out of a sized table is a call,
 * and a call without a reason cannot be reviewed.
 */
export function normalizeExclusions(raw) {
    const out = []
    for (const x of Array.isArray(raw) ? raw : []) {
        const bucket = resolveBucket(typeof x === 'string' ? x : x?.bucket)?.bucket
        if (!bucket || out.some(o => o.bucket === bucket)) continue
        const reason = typeof x === 'object' && typeof x?.reason === 'string' ? x.reason.trim() || null : null
        out.push({ bucket, reason })
    }
    return out
}

/** A base rate this small is "no expected move": a call's sign against it is not a disagreement. */
export const BASE_SIGN_FLOOR = 0.3
/** A call this close to zero has no direction to disagree with. */
const CALL_SIGN_FLOOR = 0.1

/**
 * Calls → calls with their base rate and DEVIATION attached, and a flag wherever a call reverses the
 * base rate's direction or the standing view's call on the same channel. PURE.
 *
 * `latest` is pythia_channel_latest; `previous` the standing view's channel_views. A channel with
 * no base rate deviates from 0 and says so.
 */
export function withBases(views, latest, previous = []) {
    const prevBy = Object.fromEntries((Array.isArray(previous) ? previous : []).filter(p => p?.channel_id).map(p => [p.channel_id, p]))
    return views.map(v => {
        const base = toNum(latest?.channels?.[v.channel_id]?.base_dz)
        const deviation = Math.round((v.dz - (base ?? 0)) * 1000) / 1000
        const flags = []
        if (base === null) flags.push('no_base_rate')
        else if (Math.abs(base) >= BASE_SIGN_FLOOR && Math.abs(v.dz) >= CALL_SIGN_FLOOR && Math.sign(v.dz) !== Math.sign(base)) flags.push('against_base_rate')
        const prev = prevBy[v.channel_id]
        const prevDev = toNum(prev?.deviation) ?? (toNum(prev?.dz) !== null && toNum(prev?.base_dz) !== null ? toNum(prev.dz) - toNum(prev.base_dz) : null)
        if (prevDev !== null && Math.abs(prevDev) >= CALL_SIGN_FLOOR && Math.abs(deviation) >= CALL_SIGN_FLOOR && Math.sign(prevDev) !== Math.sign(deviation)) flags.push('reverses_standing_call')
        return { ...v, base_dz: base, deviation, ...(prev ? { previous_dz: toNum(prev.dz) } : {}), flags }
    })
}

// ─── the arithmetic ───────────────────────────────────────────────────────────

/** {symbol: {channel_id: beta}} — SIGNIFICANT betas only. A measured zero transmits nothing. */
function _betaIndex(betas) {
    const idx = {}
    for (const b of Array.isArray(betas) ? betas : []) {
        if (!b?.significant || !b.symbol || !b.channel_id) continue
        const beta = toNum(b.beta)
        if (beta === null) continue
        ;(idx[b.symbol] ??= {})[b.channel_id] = beta
    }
    return idx
}

/** {symbol: [bucket…]} and each bucket's grain, from the proxy map. */
function _fundsOf(proxyMap) {
    const bySymbol = {}
    for (const [bucket, meta] of Object.entries(proxyMap)) {
        if (!meta?.symbol) continue
        ;(bySymbol[meta.symbol] ??= []).push({ bucket, grain: SECTORS.includes(bucket) ? 'sector' : 'industry', exact: meta.exact })
    }
    return bySymbol
}

/** The bucket a shared fund's row is written under: the one it is exact for, else the first by name. */
function _label(entries) {
    const sorted = [...entries].sort((a, b) => a.bucket.localeCompare(b.bucket))
    return (sorted.find(e => e.exact) ?? sorted[0]).bucket
}

/**
 * The whole computation. PURE.
 *
 * → { rows, candidates, silent, notes }
 *   rows        publishable tilt rows (basis 'channels', each with its `drivers`)
 *   candidates  every bucket considered, with its expected move — what the preview shows
 *   silent      channel calls that reach no fund through a significant beta
 *
 * Manual rows (Pythia's own, on bottom_up and the like) take precedence: a computed row for the
 * same bucket, or one that would double-count with it (a sector and its own industry), is dropped,
 * and the computed rows absorb the manual rows' net so the table still balances.
 */
export function sizeFromChannels({ views = [], reactions = [], exclude = [], manualRows = [], betas, evidence = {}, proxyMap = BUCKET_PROXY } = {}) {
    const idx = _betaIndex(betas)
    // Funds the engine has FITTED at all (significant or not). A fund added to the map since the
    // last weekly fit has no betas yet; read as "expected move 0" it would argue for splitting its
    // sector and the sector's whole exposure would vanish with it.
    const fitted = new Set((Array.isArray(betas) ? betas : []).map(b => b?.symbol).filter(Boolean))
    const funds = _fundsOf(proxyMap)
    const mult = {}
    for (const r of reactions) {
        const sym = proxyMap[r.bucket]?.symbol
        if (sym) (mult[sym] ??= {})[r.channel_id] = REACTIONS[r.reaction]
    }

    const expected = (sym) => {
        const drivers = []
        let e = 0
        for (const v of views) {
            const beta = idx[sym]?.[v.channel_id]
            if (beta === undefined) continue
            const m = mult[sym]?.[v.channel_id] ?? 1
            // The DEVIATION from the base rate when one is attached (withBases); the raw call otherwise.
            const move = v.deviation ?? v.dz
            const c = CHANNEL_CONFIDENCE * m * beta * move
            e += c
            drivers.push({
                channel_id: v.channel_id, beta, dz: v.dz,
                ...(v.base_dz !== undefined ? { base_dz: v.base_dz, deviation: move } : {}),
                ...(m !== 1 ? { multiplier: m } : {}), contribution: c,
            })
        }
        // The industry evidence, added in the same units: an expected move over the market.
        const ev = evidence[sym]
        const evidencePart = ev ? K_EVIDENCE * ev.score : 0
        return {
            e: e + evidencePart,
            channelPart: e,
            evidencePart,
            ...(ev ? { evidence: { ...ev, contribution: evidencePart } } : {}),
            drivers: drivers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
        }
    }

    const silent = views.filter(v => !Object.values(idx).some(chs => v.channel_id in chs)).map(v => v.channel_id)

    // One candidate per sector, or one per industry fund inside it where they diverge.
    const candidates = []
    for (const sector of SECTORS) {
        const sectorSym = proxyMap[sector]?.symbol
        if (!sectorSym) continue
        const sec = { bucket: sector, grain: 'sector', symbol: sectorSym, ...expected(sectorSym) }
        const industrySyms = Object.entries(funds)
            .filter(([sym, entries]) => sym !== sectorSym && fitted.has(sym) && entries.some(e => e.grain === 'industry' && parentSector(e.bucket) === sector))
            .map(([sym, entries]) => ({
                bucket: _label(entries.filter(e => e.grain === 'industry' && parentSector(e.bucket) === sector)),
                stands_for: entries.filter(e => parentSector(e.bucket) === sector).map(e => e.bucket).sort(),
                grain: 'industry', symbol: sym, ...expected(sym),
            }))
        const spread = industrySyms.reduce((m, i) => Math.max(m, Math.abs(i.e - sec.e)), 0)
        if (industrySyms.length && spread >= SPLIT_THRESHOLD) candidates.push(...industrySyms)
        else candidates.push(sec)
    }

    // ONE ROW PER FUND. Candidates are built sector by sector, so a fund that grades industries in
    // SEVERAL sectors came out once per sector: MOO (Agricultural Inputs / Farm Products / Machinery,
    // in Materials, Consumer Defensive and Industrials) published as three +40bp rows on one fund —
    // a 120bp bet reading as three independent views (tilt_SPX_11807d9e, 2026-10-01). Collapsed here
    // to the bucket the fund is exact for, else the first by name, standing for all of them.
    const bySym = new Map()
    for (const c of candidates) {
        if (c.grain !== 'industry') continue
        ;(bySym.get(c.symbol) ?? bySym.set(c.symbol, []).get(c.symbol)).push(c)
    }
    for (const [sym, dupes] of bySym) {
        if (dupes.length < 2) continue
        const entries = (funds[sym] ?? []).filter(e => e.grain === 'industry')
        const label = _label(entries)
        const keep = dupes.find(c => c.bucket === label) ?? [...dupes].sort((a, b) => a.bucket.localeCompare(b.bucket))[0]
        keep.stands_for = [...new Set(dupes.flatMap(c => c.stands_for ?? [c.bucket]))].sort()
        for (const c of dupes) {
            if (c !== keep) candidates.splice(candidates.indexOf(c), 1)
        }
    }

    // Manual rows win, and so does an exclusion.
    const exclusions = normalizeExclusions(exclude)
    const excluded = new Set(exclusions.map(x => x.bucket))
    const manual = manualRows.map(r => ({ ...r, bucket: resolveBucket(r.bucket)?.bucket })).filter(r => r.bucket)
    const manualBuckets = new Set(manual.map(r => r.bucket))
    const manualSectors = new Set(manual.map(r => (SECTORS.includes(r.bucket) ? r.bucket : null)).filter(Boolean))
    const manualParents = new Set(manual.map(r => parentSector(r.bucket)).filter(Boolean))
    const clashes = (c) => manualBuckets.has(c.bucket)
        || (c.grain === 'industry' && manualSectors.has(parentSector(c.bucket)))
        || (c.grain === 'sector' && manualParents.has(c.bucket) && !manualSectors.has(c.bucket))
        || (c.stands_for ?? []).some(b => manualBuckets.has(b))

    // Excluding a SECTOR excludes its industries too: whether a sector is held whole or split depends
    // on the size of the calls, and "leave Financials alone" must not lapse when the banks split out.
    const isExcluded = (c) => excluded.has(c.bucket) || (c.grain === 'industry' && excluded.has(parentSector(c.bucket)))
    const sizable = candidates.filter(c => !isExcluded(c) && !clashes(c) && Math.abs(c.e) >= MIN_MOVE)
    const manualNet = manual.reduce((s, r) => s + (toNum(r.active_bp) ?? 0), 0)

    // BALANCE BY SCALING SIDES, NEVER BY SHIFTING ROWS. The expected moves are already relative to
    // the market — the betas control for SPY, and under a typical set of calls the eleven sector
    // funds' moves average ~0% at index weights. Subtracting the candidates' mean as well counted
    // the market twice: measured 2026-10-01, it left Real Estate (expected +2.95%) at benchmark
    // weight because the candidate list was heavy in metals and energy industries that all gained.
    // So a row's SIGN is its expected move's sign. Each SIDE is sized on its own scale — rows
    // proportional to their expected move, the largest at its grain's cap — and the larger side's
    // total is brought down to the smaller's (less whatever the desk's own rows net). A row too small
    // to keep hands its share to the rest of its side; it is never shrunk into nothing along with
    // everything else. (The first version shrank the bigger side toward a side of small rows, the
    // rows fell under the minimum, and on real data the whole table sized to zero.)
    let rows = []
    const sideNote = []
    if (sizable.length) {
        const sideOf = (sign) => sizable.map((c, j) => ({ c, j })).filter(({ c }) => Math.sign(c.e) === sign)
        const overs = sideOf(1), unders = sideOf(-1)

        // Natural scale of one side: proportional to |e|, largest at the sector cap, each row at its grain cap.
        const natural = (side) => {
            const m = Math.max(...side.map(({ c }) => Math.abs(c.e)))
            return side.map(({ c }) => Math.min(CAP_BP[c.grain], (Math.abs(c.e) / m) * CAP_BP.sector))
        }
        // Fit a side to a target total: scale, and while a row is under the minimum, drop the SMALLEST
        // one and give its share to the rest. One at a time: dropping every under-minimum row at once
        // emptied a side of eleven gainers facing one 100bp loser (each scaled to ~9bp), and the
        // table published as that single loser, unbalanced — measured on Pythia's first sized run.
        const fit = (side, sizes, target) => {
            if (target <= 0) return side.map(() => 0)
            let live = side.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a])
            let out = side.map(() => 0)
            while (live.length) {
                const sum = live.reduce((s, i) => s + sizes[i], 0)
                const k = target / sum
                out = side.map((_, i) => (live.includes(i) ? Math.min(CAP_BP[side[i].c.grain], sizes[i] * k) : 0))
                const smallest = live[live.length - 1]
                if (out[smallest] >= MIN_ROW_BP || live.length === 1) break
                live = live.slice(0, -1)
            }
            return out.map(v => (v >= MIN_ROW_BP ? v : 0))
        }

        const w = sizable.map(() => 0)
        if (overs.length && unders.length) {
            const nO = natural(overs), nU = natural(unders)
            const O = nO.reduce((a, b) => a + b, 0), U = nU.reduce((a, b) => a + b, 0)
            // over − under = −absorb, at the largest gross both sides can carry. `absorb` is the desk's
            // own net when the sized rows can carry it, and 0 when they cannot.
            let absorb = manualNet
            let tO = Math.min(O, U - absorb), tU = tO + absorb
            if (tO <= 0 || tU <= 0 || tU > U) {
                absorb = 0
                tO = tU = Math.min(O, U)
                if (manualNet) sideNote.push(`Your own rows net ${manualNet > 0 ? '+' : ''}${manualNet}bp, more than the sized rows can offset — the table will publish unbalanced. Trim your own rows or add an opposing channel call.`)
            }
            let fO = fit(overs, nO, tO), fU = fit(unders, nU, tU)
            // Caps and the row minimum can stop a side short of its target; re-fit the other to match.
            const sO = fO.reduce((a, b) => a + b, 0), sU = fU.reduce((a, b) => a + b, 0)
            if (sO - sU > -absorb + 1) fO = fit(overs, nO, sU - absorb)
            else if (sO - sU < -absorb - 1) fU = fit(unders, nU, sO + absorb)
            fO.forEach((v, i) => { w[overs[i].j] = v })
            fU.forEach((v, i) => { w[unders[i].j] = -v })
        } else if (!manual.length) {
            sideNote.push('Every bucket these calls reach moves the same way relative to the market, so no balanced table follows from them alone — add an opposing call or your own row.')
        } else {
            // One-sided, but the desk's own rows can fund it: size the one side against their net.
            const side = overs.length ? overs : unders
            const sign = overs.length ? 1 : -1
            const target = sign * -manualNet
            if (target > 0) fit(side, natural(side), Math.min(target, natural(side).reduce((a, b) => a + b, 0))).forEach((v, i) => { w[side[i].j] = sign * v })
            else sideNote.push('Every bucket these calls reach moves the same way as your own rows, so nothing balances them — add an opposing call.')
        }
        rows = sizable
            .map((c, j) => ({ c, bp: _round5(w[j]) }))
            .filter(({ bp }) => bp !== 0)
            .map(({ c, bp }) => ({
                bucket: c.bucket,
                stance: bp > 0 ? 'over' : 'under',
                active_bp: bp,
                // Named for whichever part carries the row. A tech row is always `evidence`: no channel reaches it.
                basis: Math.abs(c.channelPart ?? c.e) >= Math.abs(c.evidencePart ?? 0) ? 'channels' : 'evidence',
                rationale: _rationale(c),
                drivers: c.drivers.map(d => ({ ...d, contribution: Math.round(d.contribution * 10000) / 10000 })),
                ...(c.evidence ? { evidence: { ...c.evidence, contribution: Math.round(c.evidence.contribution * 10000) / 10000 } } : {}),
            }))
    }

    const notes = [...sideNote]
    if (silent.length) notes.push(`No fund has a significant beta to ${silent.join(', ')} — those calls size nothing.`)
    if (excluded.size) notes.push(`Excluded by the desk: ${[...excluded].join(', ')}.`)
    const unexplained = exclusions.filter(x => !x.reason).map(x => x.bucket)
    if (unexplained.length) notes.push(`Excluded WITHOUT a reason: ${unexplained.join(', ')}. Give each one — an exclusion is a call, and it is stored with the view.`)
    return { rows, candidates, silent, notes }
}

function _rationale(c) {
    const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
    const sz = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100) / 100}z`
    const parts = c.drivers.slice(0, 3).map(d => {
        const move = d.deviation !== undefined
            ? `${d.channel_id} call ${sz(d.dz)} vs base ${d.base_dz === null ? 'n/a' : sz(d.base_dz)} = ${sz(d.deviation)}`
            : `${d.channel_id} ${sz(d.dz)}`
        return `${move} × β ${pct(d.beta)}${d.multiplier ? ` × ${d.multiplier} (reaction)` : ''} = ${pct(d.contribution)}`
    })
    if (c.evidence && Math.abs(c.evidence.contribution) >= 0.0005) {
        const ev = c.evidence
        parts.push(`industry evidence ${ev.score >= 0 ? '+' : ''}${ev.score.toFixed(2)} (beat ${ev.beat === null ? '—' : Math.round(ev.beat * 100) + '%'}, momentum ${ev.momentum === null ? '—' : pct(ev.momentum)}) = ${pct(ev.contribution)}`)
    }
    const scope = c.stands_for && c.stands_for.length > 1 ? ` Graded on ${c.symbol}, which also stands for ${c.stands_for.filter(b => b !== c.bucket).join(', ')}.` : ''
    return `Sized: expected ${pct(c.e)} vs the market — ${parts.join('; ')}.${scope}`
}

// ─── the preview Pythia reads ─────────────────────────────────────────────────

/** sizeFromChannels' result → LLM-ready text. PURE. */
export function formatSizing(result, views = []) {
    if (!views?.length && !result.rows.length) return 'No valid channel calls and no industry evidence to size. Each call needs a channel id from get_channel_state and a dz within ±3.'
    const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
    const rows = result.rows.map(r => {
        const parts = r.drivers.slice(0, 2).map(d => `${d.channel_id} ${pct(d.contribution)}`)
        if (r.evidence && Math.abs(r.evidence.contribution) >= 0.0005) parts.push(`evidence ${pct(r.evidence.contribution)}`)
        return `  ${r.bucket.padEnd(36)} ${r.stance.padEnd(5)} ${String(r.active_bp).padStart(5)}bp   [${r.basis}] ${parts.join(', ')}`
    })
    const quiet = result.candidates
        .filter(c => !result.rows.some(r => r.bucket === c.bucket))
        .sort((a, b) => Math.abs(b.e) - Math.abs(a.e))
        .slice(0, 8)
        .map(c => `${c.bucket} ${pct(c.e)}`)
    const sz = (v) => (v === null || v === undefined ? '  n/a' : `${v >= 0 ? '+' : ''}${(Math.round(v * 100) / 100).toFixed(2)}`.padStart(5))
    const FLAG = {
        against_base_rate: 'AGAINST THE BASE RATE — history says the other direction; state why this time differs',
        reverses_standing_call: 'REVERSES THE STANDING CALL — name what changed in the readings since it was made',
        no_base_rate: 'no base rate for this channel — sized on the raw call',
    }
    const callLines = views.map(v => {
        const head = `  ${v.channel_id.padEnd(26)} call ${sz(v.dz)}z   base ${sz(v.base_dz)}z   sized on ${sz(v.deviation ?? v.dz)}z`
            + (v.previous_dz !== undefined ? `   (standing call ${sz(v.previous_dz)}z)` : '')
        return [head, ...(v.flags ?? []).map(f => `      ⚑ ${FLAG[f] ?? f}`)].join('\n')
    })
    return [
        views.length
            ? `PROPOSED TABLE from ${views.length} channel call(s) plus the industry evidence. Only each call's DEVIATION from its base rate is sized — a call that repeats history is already priced and sizes nothing:`
            : 'PROPOSED TABLE from the industry evidence alone — no channel calls:',
        ...callLines,
        '',
        ...(rows.length ? rows : ['  (no bucket clears the minimum expected move — the calls are too small, or reach no measured exposure)']),
        '',
        ...(quiet.length ? [`Left at benchmark weight (largest first): ${quiet.join(', ')}.`] : []),
        ...result.notes,
        '',
        'This is what publishing these calls produces. To change it, change the CALLS, add a reaction where a bucket should respond differently from its history, exclude a bucket with a reason, or write your own row for a call that is not a channel view (bottom_up and the like) — your own rows take precedence and the sized rows absorb their net. Do not retype these rows in the <tilt> block.',
    ].join('\n')
}

/**
 * For the tool: read, size, format. `previous` is the standing view's channel_views, so a call that
 * reverses one is flagged in the preview — before it is published, not after.
 */
export async function previewSizing({ channel_views, reactions, exclude, manual_rows } = {}, { previous = [] } = {}) {
    const { betas, latest, evidence } = await readSizingInputs()
    const known = new Set([...(betas ?? []).map(b => b.channel_id), ...Object.keys(latest?.channels ?? {})])
    const views = withBases(normalizeViews(channel_views, known.size ? known : null), latest, previous)
    const result = sizeFromChannels({ views, reactions: normalizeReactions(reactions), exclude: Array.isArray(exclude) ? exclude : [], manualRows: Array.isArray(manual_rows) ? manual_rows : [], betas, evidence })
    return formatSizing(result, views)
}

/**
 * A parsed <tilt> draft → the same draft with the sized rows merged in and each call stamped with
 * the z it was made at, so it can be graded at maturity. Sized from the channel calls AND the
 * industry evidence — so a draft with no calls is still sized wherever there is evidence (that is
 * how tech gets rows at all). Returned untouched only when there is neither.
 */
export async function expandChannelDraft(draft, now = new Date().toISOString(), { previous = [] } = {}) {
    if (!draft) return draft
    const { betas, latest, evidence } = await readSizingInputs()
    const known = new Set([...(betas ?? []).map(b => b.channel_id), ...Object.keys(latest?.channels ?? {})])
    const views = withBases(normalizeViews(draft.channel_views, known.size ? known : null), latest, previous)
    if (!views.length && !Object.keys(evidence ?? {}).length) return draft
    const reactions = normalizeReactions(draft.reactions)
    const manualRows = Array.isArray(draft.tilts) ? draft.tilts : []
    const exclusions = normalizeExclusions(draft.exclude)
    const { rows } = sizeFromChannels({ views, reactions, exclude: exclusions, manualRows, betas, evidence })
    return {
        ...draft,
        exclusions,
        tilts: [...manualRows, ...rows],
        channel_views: views.map(v => ({ ...v, z_at_set: toNum(latest?.channels?.[v.channel_id]?.z), set_at: now })),
        reactions,
    }
}
