// Geopolitical risk, as the engine measured it — the read side of Pythia's fifth input (docs/design/pythia-geopolitics.md,
// step 4). aether-engine writes one document a week (`geopolitical_risk`, scripts/fetch_geopolitical_risk.py): the
// Caldara–Iacoviello index — global, its daily line, 44 countries, each against its own trailing ten years — and every
// risk of the reviewed exposure map with its intensity and the GICS sub-industries it hurts and helps.
//
// DATA, not judgment. Two things travel with every read, because both are easy to over-read: the index counts
// newspaper articles (ATTENTION, not impact), and the map's directions FAILED their 40-year test (T3, §6) — they are
// hypotheses, shown as such.

import { getEngineDb } from '../../services/engineDb.js'

export const COLLECTION = 'geopolitical_risk'
export const RUNS = 'geopolitical_risk_runs'

const _io = { db: () => getEngineDb() }
/** Test seam. */
export function _setGeoIO(io) { Object.assign(_io, io) }

/** The latest COMPLETE reading, or null (a run is written whole and then marked complete). */
export async function latestReading() {
    const db = await _io.db()
    const run = await db.collection(RUNS).find({ complete: true }, { projection: { asof: 1 } }).sort({ asof: -1 }).limit(1).next()
    if (!run) return null
    return db.collection(COLLECTION).findOne({ _id: run.asof }, { projection: { _id: 0, countries: 0 } })
}

const _num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * What an assessment freezes for one sub-industry: the global reading and the map's risks that touch it, each with
 * its side (hurts / helps), strength and why. Pure → null without a reading.
 */
export function geoFacts(reading, code) {
    if (!reading) return null
    const g = reading.global ?? {}
    const risks = []
    for (const r of reading.risks ?? []) {
        for (const side of ['hurts', 'helps']) {
            const line = (r[side] ?? []).find(l => l.code === code)
            if (line) {
                risks.push({ id: r.id, name: r.name, side, strength: line.strength ?? null, why: line.why ?? null,
                    z: _num(r.z), trend: _num(r.trend), elevated: Boolean(r.elevated), hottest: r.hottest ?? null })
            }
        }
    }
    risks.sort((a, b) => (b.z ?? -Infinity) - (a.z ?? -Infinity))
    return {
        asof: reading.asof ?? null, monthly_through: reading.monthly_through ?? null,
        global: { level: _num(g.level), z: _num(g.z), trend: _num(g.trend), elevated: Boolean(g.elevated),
            week: _num(reading.daily?.ma7), week_percentile: _num(reading.daily?.ma7_percentile), daily_through: reading.daily?.through ?? null },
        risks,
    }
}

/** One sub-industry's facts from the latest reading (null when the engine has not run). */
export async function readGeoFacts(code) {
    return geoFacts(await latestReading(), code)
}

/** A function code → facts over ONE reading, for the weekly change scan (one read for every industry). */
export async function readAllGeo() {
    const reading = await latestReading()
    return (code) => geoFacts(reading, code)
}

const _z = (z) => (typeof z === 'number' ? `${z >= 0 ? '+' : ''}${z.toFixed(1)}` : 'n/a')
const _pct = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%` : 'n/a')

/** The reading as text — global first, then the risks (all, or those touching `facts`' industry). Pure. */
export function formatGeo(reading, facts = null) {
    if (!reading) return 'Geopolitical risk: not measured yet (the engine has not run).'
    const g = reading.global ?? {}
    const lines = [
        `GEOPOLITICAL RISK (Caldara–Iacoviello index; monthly to ${reading.monthly_through}, daily to ${reading.daily?.through ?? 'n/a'}):`,
        `  World: ${Math.round(g.level ?? 0)} over the last three months — ${_z(g.z)} standard deviations against its own ten years${g.elevated ? ' (ELEVATED)' : ''}, ${_pct(g.trend)} on the three months before; this week's line above ${Math.round((reading.daily?.ma7_percentile ?? 0) * 100)}% of the last ten years' weeks.`,
    ]
    const risk = (r, side = null) => `  ${r.name}: ${_z(r.z)}${r.elevated ? ' ELEVATED' : ''} (hottest: ${r.hottest ?? 'n/a'}, trend ${_pct(r.trend)})`
        + (side ? ` — the map says it ${side === 'hurts' ? 'HURTS' : 'HELPS'} this industry${r.strength === 1 ? ' directly' : ' through a customer, supplier or price'}: ${r.why}` : '')
    if (facts) {
        lines.push(facts.risks.length ? 'RISKS THE MAP SAYS TOUCH THIS INDUSTRY:' : 'No mapped risk touches this industry.')
        lines.push(...facts.risks.map(r => risk(r, r.side)))
    } else {
        lines.push('THE MAPPED RISKS (hottest first):', ...(reading.risks ?? []).map(r => risk(r)))
    }
    lines.push('Read it as ATTENTION, not impact: the index counts newspaper articles. The map\'s directions are HYPOTHESES — they FAILED a 40-year test (after a risk turned elevated, the industries it was said to hurt did no worse than those it was said to help). An elevated risk is a reason to READ the news on it, never a verdict on its own.')
    return lines.join('\n')
}
