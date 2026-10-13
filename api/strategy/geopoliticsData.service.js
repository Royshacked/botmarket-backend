// Geopolitical risk, as the engine measured it — the read side of Pythia's fifth input (docs/design/pythia-geopolitics.md,
// step 4). aether-engine writes one document a week (`geopolitical_risk`, scripts/fetch_geopolitical_risk.py): the
// Caldara–Iacoviello index — global, its daily line, 44 countries, each against its own trailing ten years — and every
// risk of the reviewed exposure map with its intensity and the GICS sub-industries it hurts and helps.
//
// DATA, not judgment. Two things travel with every read, because both are easy to over-read: the index counts
// newspaper articles (ATTENTION, not impact), and the map's directions FAILED their history test (T3, §6: judged on
// 2005–2025, 1995–2004 reported) — they are hypotheses, shown as such.

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
    // A reading without the map's risks (written before the map, or a broken run) is NOT "no risk touches it":
    // freezing an empty list would make every already-elevated risk read as newly elevated later (QA 2026-10-13).
    if (!reading || !Array.isArray(reading.risks)) return null
    const g = reading.global ?? {}
    const risks = []
    for (const r of reading.risks ?? []) {
        for (const side of ['hurts', 'helps']) {
            const line = (r[side] ?? []).find(l => l.code === code)
            if (line) {
                risks.push({ id: r.id, name: r.name, side, strength: line.strength ?? null, why: line.why ?? null,
                    z: _num(r.z), trend: _num(r.trend), elevated: Boolean(r.elevated), hottest: r.hottest ?? null,
                    words: Array.isArray(r.words) ? r.words.slice(0, 8) : [] })
            }
        }
    }
    risks.sort((a, b) => (b.z ?? -Infinity) - (a.z ?? -Infinity))
    return {
        asof: reading.asof ?? null, monthly_through: reading.monthly_through ?? null,
        global: { level: _num(g.level), z: _num(g.z), trend: _num(g.trend), elevated: Boolean(g.elevated),
            week: _num(reading.daily?.ma7), week_percentile: _num(reading.daily?.ma7_percentile), daily_through: reading.daily?.through ?? null },
        risks,
        // Every risk this reading measured — the scan compares only these, so a risk or a line the map gains later
        // never reads as "turned elevated" against a reading that could not have seen it.
        map_risks: reading.risks.map(r => r.id),
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
const _int = (v) => (typeof v === 'number' ? String(Math.round(v)) : 'n/a')
const _how = (s) => (s === 1 ? ' directly' : s === 2 ? ' through a customer, supplier or price' : '')

/** The reading as text — global first, then the risks (all, or those touching `facts`' industry). Pure. */
export function formatGeo(reading, facts = null) {
    if (!reading) return 'Geopolitical risk: not measured yet (the engine has not run).'
    const g = reading.global ?? {}
    const lines = [
        `GEOPOLITICAL RISK (Caldara–Iacoviello index; monthly to ${reading.monthly_through ?? 'n/a'}, daily to ${reading.daily?.through ?? 'n/a'}):`,
        `  World: ${_int(g.level)} over the last three months — ${_z(g.z)} standard deviations against its own ten years${g.elevated ? ' (ELEVATED)' : ''}, ${_pct(g.trend)} on the three months before; this week's line above ${typeof reading.daily?.ma7_percentile === 'number' ? `${Math.round(reading.daily.ma7_percentile * 100)}%` : 'n/a'} of the last ten years' weeks.`,
    ]
    const risk = (r, side = null) => `  ${r.name}: ${_z(r.z)}${r.elevated ? ' ELEVATED' : ''} (hottest: ${r.hottest ?? 'n/a'}, trend ${_pct(r.trend)})`
        + (side ? ` — the map says it ${side === 'hurts' ? 'HURTS' : 'HELPS'} this industry${_how(r.strength)}: ${r.why}` : '')
        + (r.words?.length ? `. News words: ${r.words.map(w => `"${w}"`).join(', ')}` : '')
    if (facts) {
        lines.push(facts.risks.length ? 'RISKS THE MAP SAYS TOUCH THIS INDUSTRY:' : 'No mapped risk touches this industry.')
        lines.push(...facts.risks.map(r => risk(r, r.side)))
    } else {
        lines.push('THE MAPPED RISKS (hottest first):', ...(reading.risks ?? []).map(r => risk(r)))
    }
    lines.push('Read it as ATTENTION, not impact: the index counts newspaper articles. The map\'s directions are HYPOTHESES — they FAILED their history test (1995–2025: after a risk turned elevated, the industries it was said to hurt did no worse than those it was said to help). An elevated risk is a reason to READ the news on it (its words above), never a verdict on its own.')
    return lines.join('\n')
}

/**
 * The `get_geopolitics` tool's answer (Pythia): the whole reading, or one industry's view when `industry` names one.
 * Exported with its reads injectable, as `industryNews` is, so the handler is tested without a database.
 */
export async function geopoliticsText(input, deps = {}) {
    const read = deps.reading ?? latestReading
    const readSub = deps.readSub
    const reading = await read()
    const key = typeof input?.industry === 'string' ? input.industry.trim() : ''
    if (!key) return formatGeo(reading)
    const b = readSub ? await readSub(key) : null
    if (!b) return 'Unknown sub-industry — call list_industries for the codes and names.'
    return `${b.sub.name} (${b.sub.code})\n${formatGeo(reading, geoFacts(reading, b.sub.code))}`
}
