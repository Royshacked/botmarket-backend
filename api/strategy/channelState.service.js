// The macro CHANNELS — what each driver reads now, which way it is moving, and how unusual that is
// against its own twenty years. Pythia's Phase-1 backdrop and the vocabulary its kill-criteria are
// written in.
//
// WRITTEN BY PYTHON, READ HERE. aether-engine/scripts/build_channel_state.py computes everything
// (z-scores, the 4- and 13-week trend, the percentile, the regime) into ONE document,
// `pythia_channel_latest`. This module only reads and formats it; no arithmetic lives on this side,
// so the two repos cannot disagree about what a channel says.
//
// A STALE READ IS WORSE THAN A MISSING ONE — the lesson of the archived engine, whose /shock-feed
// kept serving cards built on June's state in September. So age is always printed, and past
// STALE_DAYS the whole read is headed as stale rather than passed off as current.
//
// Revived 2026-09-30, design: docs/design/pythia-industries-and-channels.md §4 and §12 step 4.

import { getDb }  from '../../providers/mongodb.provider.js'
import { toNum }  from '../../services/format.util.js'

export const LATEST_COLLECTION = 'pythia_channel_latest'

/** A daily job that has missed a week has stopped, not paused. */
export const STALE_DAYS = 8

const DAY_MS = 24 * 60 * 60 * 1000

const _io = {
    latest: async () => (await getDb()).collection(LATEST_COLLECTION).findOne({ _id: 'latest' }),
}
export function _setChannelIO(io) { Object.assign(_io, io) }

export async function readChannelState() {
    return _io.latest()
}

const _day = (d) => {
    const ms = d instanceof Date ? d.getTime() : Date.parse(d ?? '')
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '—'
}
const _z = (v) => {
    const n = toNum(v)
    return n === null ? '    —' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}`.padStart(5)
}

/**
 * The latest document → LLM-ready text. PURE — `nowMs` is injected.
 *
 * Sorted by |z|, because what is unusual is what a regime call has to explain. Each line carries
 * its own as-of date: monthly series lag by weeks, and "consumer_credit +1.8" means something
 * different when the reading is from July.
 */
export function formatChannelState(doc, nowMs = Date.now()) {
    const channels = doc?.channels && typeof doc.channels === 'object' ? Object.entries(doc.channels) : []
    if (!channels.length) {
        return 'Channel state is not available — the engine has not written it. Do not infer channel readings; argue from the other observables and say the channels were unavailable.'
    }

    const computedMs = doc.computed_at instanceof Date ? doc.computed_at.getTime() : Date.parse(doc.computed_at ?? '')
    const ageDays = Number.isFinite(computedMs) ? Math.floor((nowMs - computedMs) / DAY_MS) : null
    const stale = ageDays === null || ageDays > STALE_DAYS

    const rows = channels
        .map(([id, c]) => ({ id, ...c, z: toNum(c?.z) }))
        .filter(r => r.z !== null)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))

    const header = stale
        ? `⚠ STALE CHANNEL STATE — computed ${ageDays === null ? 'at an unknown time' : `${ageDays} days ago`}. Treat every reading below as old, say so, and do not write a kill-criterion that depends on it being current.`
        : `CHANNEL STATE — computed ${_day(doc.computed_at)}, week of ${_day(doc.week)}. Regime (VIX + credit spread): ${doc.regime ?? 'unknown'}.`

    const pct = (v) => { const n = toNum(v); return n === null ? '  —' : `${Math.round(n * 100)}%`.padStart(4) }
    const lines = rows.map(r => {
        const dir = r.sign_convention === -1 ? ' (sign inverted)' : ''
        return `  ${r.id.padEnd(27)} z ${_z(r.z)}   4w ${_z(r.z_4w)}   13w ${_z(r.z_13w)}   pct ${pct(r.pct)}   as of ${_day(r.as_of)}${dir}\n      ${r.description ?? ''}`
    })

    const missing = doc.missing && typeof doc.missing === 'object' ? Object.entries(doc.missing) : []
    return [
        header,
        '',
        'z = trailing-2-year z-score (positive = more pressure in that channel). 4w/13w = the reading one and three months earlier, on the channel\'s own series. pct = share of its own history since 2005 at or below today.',
        '',
        ...lines,
        ...(missing.length ? ['', `Not measured: ${missing.map(([id, why]) => `${id} (${why})`).join(', ')}.`] : []),
        '',
        'These are READINGS, not forecasts, and not yet evidence about any sector: which buckets actually move with a channel is measured separately and is not available yet. Use them to name the regime and to write kill-criteria as checkable conditions, e.g. "energy_cost z below +0.5".',
    ].join('\n')
}
