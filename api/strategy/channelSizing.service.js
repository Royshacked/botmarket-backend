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
// DATA VS JUDGMENT. This module is arithmetic. Which channels move, by how much, and which buckets
// react unusually are Pythia's; nothing here decides a view.

import { getDb }  from '../../providers/mongodb.provider.js'
import { toNum }  from '../../services/format.util.js'
import { BUCKET_PROXY, SECTORS, parentSector, resolveBucket } from '../../services/entity/vocabulary.js'
import { BETAS_COLLECTION } from './channelExposures.service.js'
import { LATEST_COLLECTION } from './channelState.service.js'

/** How a stated reaction scales the measured beta. Coarse on purpose — see the header. */
export const REACTIONS = { stronger: 1.5, weaker: 0.5, opposite: -1 }

/** A channel call larger than this many z over one horizon is not a forecast, it is a typo. */
export const MAX_DZ = 3

/** Split a sector into its industries when one of them is expected to move this much more or less than the sector. */
export const SPLIT_THRESHOLD = 0.01
/** An expected move smaller than this is no view: the bucket stays at benchmark weight. */
export const MIN_MOVE = 0.005
/** Per-row caps, bp. A narrow industry fund is a bigger bet per bp than an 11-sector fund (§11). */
export const CAP_BP = { sector: 200, industry: 100 }
/** A row sized below this after netting is rounding, not a stance. */
export const MIN_ROW_BP = 25

const _round5 = (v) => Math.round(v / 5) * 5

// ─── inputs ───────────────────────────────────────────────────────────────────

const _io = {
    betas:  async () => (await getDb()).collection(BETAS_COLLECTION)
        .find({ status: 'measured' }, { projection: { _id: 0, symbol: 1, channel_id: 1, beta: 1, t_stat: 1, significant: 1 } }).toArray(),
    latest: async () => (await getDb()).collection(LATEST_COLLECTION).findOne({ _id: 'latest' }),
}
export function _setSizingIO(io) { Object.assign(_io, io) }

export async function readSizingInputs() {
    const [betas, latest] = await Promise.all([_io.betas(), _io.latest()])
    return { betas, latest }
}

// ─── validation ───────────────────────────────────────────────────────────────

/** Channel calls as stored: known channel, finite non-zero dz within ±MAX_DZ, one per channel. */
export function normalizeViews(raw, knownChannels = null) {
    const seen = new Set()
    const out = []
    for (const v of Array.isArray(raw) ? raw : []) {
        const id = typeof v?.channel_id === 'string' ? v.channel_id.trim() : (typeof v?.channel === 'string' ? v.channel.trim() : '')
        const dz = toNum(v?.dz)
        if (!id || dz === null || dz === 0 || Math.abs(dz) > MAX_DZ || seen.has(id)) continue
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
export function sizeFromChannels({ views, reactions = [], exclude = [], manualRows = [], betas, proxyMap = BUCKET_PROXY } = {}) {
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
            const c = m * beta * v.dz
            e += c
            drivers.push({ channel_id: v.channel_id, beta, dz: v.dz, ...(m !== 1 ? { multiplier: m } : {}), contribution: c })
        }
        return { e, drivers: drivers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)) }
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
                basis: 'channels',
                rationale: _rationale(c),
                drivers: c.drivers.map(d => ({ ...d, contribution: Math.round(d.contribution * 10000) / 10000 })),
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
    const parts = c.drivers.slice(0, 3).map(d =>
        `${d.channel_id} ${d.dz >= 0 ? '+' : ''}${d.dz}z × β ${pct(d.beta)}${d.multiplier ? ` × ${d.multiplier} (reaction)` : ''} = ${pct(d.contribution)}`)
    const scope = c.stands_for && c.stands_for.length > 1 ? ` Graded on ${c.symbol}, which also stands for ${c.stands_for.filter(b => b !== c.bucket).join(', ')}.` : ''
    return `Sized from the desk's channel calls: expected ${pct(c.e)} vs the market — ${parts.join('; ')}.${scope}`
}

// ─── the preview Pythia reads ─────────────────────────────────────────────────

/** sizeFromChannels' result → LLM-ready text. PURE. */
export function formatSizing(result, views) {
    if (!views?.length) return 'No valid channel calls. Each needs a channel id from get_channel_state and a non-zero dz within ±3.'
    const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
    const rows = result.rows.map(r => `  ${r.bucket.padEnd(36)} ${r.stance.padEnd(5)} ${String(r.active_bp).padStart(5)}bp   ${r.drivers.slice(0, 2).map(d => `${d.channel_id} ${pct(d.contribution)}`).join(', ')}`)
    const quiet = result.candidates
        .filter(c => !result.rows.some(r => r.bucket === c.bucket))
        .sort((a, b) => Math.abs(b.e) - Math.abs(a.e))
        .slice(0, 8)
        .map(c => `${c.bucket} ${pct(c.e)}`)
    return [
        `PROPOSED TABLE from ${views.length} channel call(s): ${views.map(v => `${v.channel_id} ${v.dz >= 0 ? '+' : ''}${v.dz}z`).join(', ')}`,
        '',
        ...(rows.length ? rows : ['  (no bucket clears the minimum expected move — the calls are too small, or reach no measured exposure)']),
        '',
        ...(quiet.length ? [`Left at benchmark weight (largest first): ${quiet.join(', ')}.`] : []),
        ...result.notes,
        '',
        'This is what publishing these calls produces. To change it, change the CALLS, add a reaction where a bucket should respond differently from its history, exclude a bucket with a reason, or write your own row for a call that is not a channel view (bottom_up and the like) — your own rows take precedence and the sized rows absorb their net. Do not retype these rows in the <tilt> block.',
    ].join('\n')
}

/** For the tool: read, size, format. */
export async function previewSizing({ channel_views, reactions, exclude, manual_rows } = {}) {
    const { betas, latest } = await readSizingInputs()
    const known = new Set([...(betas ?? []).map(b => b.channel_id), ...Object.keys(latest?.channels ?? {})])
    const views = normalizeViews(channel_views, known.size ? known : null)
    const result = sizeFromChannels({ views, reactions: normalizeReactions(reactions), exclude: Array.isArray(exclude) ? exclude : [], manualRows: Array.isArray(manual_rows) ? manual_rows : [], betas })
    return formatSizing(result, views)
}

/**
 * A parsed <tilt> draft carrying `channel_views` → the same draft with the sized rows merged in
 * and each call stamped with the z it was made at, so it can be graded at maturity. A draft
 * without channel views is returned untouched.
 */
export async function expandChannelDraft(draft, now = new Date().toISOString()) {
    if (!draft || !Array.isArray(draft.channel_views) || !draft.channel_views.length) return draft
    const { betas, latest } = await readSizingInputs()
    const known = new Set([...(betas ?? []).map(b => b.channel_id), ...Object.keys(latest?.channels ?? {})])
    const views = normalizeViews(draft.channel_views, known.size ? known : null)
    if (!views.length) return draft
    const reactions = normalizeReactions(draft.reactions)
    const manualRows = Array.isArray(draft.tilts) ? draft.tilts : []
    const exclusions = normalizeExclusions(draft.exclude)
    const { rows } = sizeFromChannels({ views, reactions, exclude: exclusions, manualRows, betas })
    return {
        ...draft,
        exclusions,
        tilts: [...manualRows, ...rows],
        channel_views: views.map(v => ({ ...v, z_at_set: toNum(latest?.channels?.[v.channel_id]?.z), set_at: now })),
        reactions,
    }
}
