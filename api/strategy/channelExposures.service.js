// Which BUCKETS move with which CHANNEL — measured, not asserted. Pythia's Phase-3 evidence.
//
// aether-engine/scripts/build_channel_betas.py regresses every sector and industry FUND's weekly
// return on the market and on one channel's weekly z-change (design: pythia-industries-and-
// channels.md §4). A significant beta says the fund has reliably moved, beyond the market, when
// that channel moved. This module reads those betas and says which buckets each fund stands for.
//
// WHAT A BETA IS NOT. It is not an edge. It is what the market ALREADY does with a channel, so a
// high beta means the channel's move is traded, not ignored (§5: "beta is not the signal, it is
// the subtraction"). What it does settle is whether an exposure is REAL: "utilities are rate
// sensitive" stops being a story once XLU's beta to real yields is measured at t −7.7 — and a
// claimed exposure the fund has never shown is a claim the table should not rest on.
//
// MEASURED ZERO IS NOT UNMEASURED. A fund regressed with no significant beta is evidence the
// market does not trade that channel through it; a fund never regressed is ignorance. Both are
// counted, separately, and never printed as a zero.

import { getDb }  from '../../providers/mongodb.provider.js'
import { toNum }  from '../../services/format.util.js'
import { LATEST_COLLECTION } from './channelState.service.js'
import { FUND_UNIVERSE_COLLECTION } from './fundUniverse.service.js'

export const BETAS_COLLECTION = 'pythia_channel_betas'

const _io = {
    betas:    async () => (await getDb()).collection(BETAS_COLLECTION).find({}, { projection: { _id: 0 } }).toArray(),
    universe: async () => (await getDb()).collection(FUND_UNIVERSE_COLLECTION).findOne({ _id: 'current' }),
    latest:   async () => (await getDb()).collection(LATEST_COLLECTION).findOne({ _id: 'latest' }),
}
export function _setExposureIO(io) { Object.assign(_io, io) }

export async function readChannelExposures() {
    const [betas, universe, latest] = await Promise.all([_io.betas(), _io.universe(), _io.latest()])
    return { betas, universe, latest }
}

const _pct = (v, digits = 2) => {
    const n = toNum(v)
    return n === null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`
}

/** { symbol: 'Railroads, Trucking (+2)' } — what each fund stands for, from the published universe. */
function _bucketsBySymbol(universe) {
    const out = {}
    for (const f of universe?.funds ?? []) {
        const names = (f.buckets ?? []).map(b => b.bucket)
        out[f.symbol] = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} (+${names.length - 3})`
    }
    return out
}

/**
 * { betas, universe, latest } → LLM-ready text. PURE.
 *
 * Grouped by channel, channels ordered by how unusual they read today (|z|), because the channels
 * the regime has to explain are the ones whose exposures matter. Within a channel, significant
 * funds by |t|. `channel` narrows to one.
 */
export function formatChannelExposures({ betas, universe, latest } = {}, { channel = null } = {}) {
    const rows = Array.isArray(betas) ? betas : []
    if (!rows.length) {
        return 'Channel exposures are not available — the engine has not fitted them. Do not assert that a bucket is exposed to a channel as if it were measured; use `rate_sensitivity` and say the exposure is unmeasured.'
    }
    const names = _bucketsBySymbol(universe)
    const zNow = latest?.channels ?? {}

    const byChannel = new Map()
    for (const b of rows) {
        if (!b?.channel_id || (channel && b.channel_id !== channel)) continue
        const g = byChannel.get(b.channel_id) ?? { sig: [], zero: 0, unmeasured: 0 }
        if (b.status === 'unmeasured') g.unmeasured++
        else if (b.significant) g.sig.push(b)
        else g.zero++
        byChannel.set(b.channel_id, g)
    }
    if (!byChannel.size) return `No exposures recorded for channel "${channel}". Check the id against get_channel_state.`

    const order = [...byChannel.keys()].sort((a, b) =>
        Math.abs(toNum(zNow[b]?.z) ?? 0) - Math.abs(toNum(zNow[a]?.z) ?? 0) || a.localeCompare(b))

    const blocks = order.map(cid => {
        const g = byChannel.get(cid)
        const z = toNum(zNow[cid]?.z)
        const head = `${cid}  (z now ${z === null ? '—' : (z >= 0 ? '+' : '') + z.toFixed(2)})  — ${g.sig.length} fund(s) measurably exposed, ${g.zero} measured with no exposure${g.unmeasured ? `, ${g.unmeasured} unmeasured` : ''}`
        const lines = g.sig
            .sort((a, b) => Math.abs(b.t_stat) - Math.abs(a.t_stat))
            .map(b => {
                const priced = z === null ? '—' : _pct(b.beta * z, 1)
                return `    ${String(b.symbol).padEnd(5)} ${_pct(b.beta).padStart(7)} per 1z  t ${(b.t_stat >= 0 ? '+' : '') + Number(b.t_stat).toFixed(1)}   at today's z ${priced.padStart(6)}   ${names[b.symbol] ?? '(held by an open stance)'}`
            })
        return [head, ...lines].join('\n')
    })

    return [
        'CHANNEL EXPOSURES — each fund\'s weekly return beyond the market per 1.0 move in the channel\'s z, fitted on weekly data since ~2006. Only |t| ≥ 3 is listed.',
        '"at today\'s z" = beta × today\'s z: roughly how far the fund has ALREADY moved, relative to the market, for the channel to sit where it does. A large number there means the channel is traded through that fund — a view needs the channel to move FROM here, not to be where it is.',
        '',
        ...blocks,
        '',
        'A measured beta proves an exposure is REAL; it is not an edge. Use it to choose WHICH buckets a regime reaches and to replace an asserted exposure with a measured one (basis `channels`). A bucket measured with NO exposure to the channel your stance rests on is not exposed to it, whatever the story says.',
    ].join('\n')
}
