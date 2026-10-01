// THE CALL LEDGER — every channel call Pythia makes, graded against what the channel then did.
//
// A call is a forecast ("real yields fall 0.5z over six months, where history says 1.8z"), and
// until now nothing checked one. This ledger is the check, and its record replaces the guessed
// CHANNEL_CONFIDENCE (0.4) the sizing discounts calls by.
//
// ONE ENTRY PER REAL FORECAST, with its own clock — the same unfalsifiability the row carry fixed.
// Every publish stamps each call "made now", so a call restated monthly would never reach six months.
// So: a call restated with the SAME dz is the same call and keeps its original date, reading and base
// rate; a changed dz, or a channel dropped, SUPERSEDES it — and a superseded call is still graded at
// its six months, so revising a bad forecast does not erase it.
//
// MARKS at 4, 13 and 26 weeks. Each compares the channel's actual z change since the call with the
// call and with the base rate, both pro-rated to the time elapsed, on the point-in-time weekly grid:
//   beat_base        the call landed closer than the base rate did — the edge it claimed
//   direction_right  the channel moved off the base rate the way the call departed from it
// The 4- and 13-week marks are interim; only the 26-week mark is final and counts toward the record.

import { randomUUID } from 'crypto'
import { getDb }      from '../../providers/mongodb.provider.js'
import { toNum }      from '../../services/format.util.js'
import { logger }     from '../../services/logger.service.js'

const LOG = '[channelCalls]'
export const CALLS_COLLECTION = 'pythia_channel_calls'
const STATE_COLLECTION = 'pythia_channel_state'

const DAY_MS = 24 * 60 * 60 * 1000
export const HORIZON_WEEKS = 26
export const MARK_WEEKS = [4, 13, 26]
/** Final grades needed before the record replaces the placeholder confidence. */
export const MIN_GRADED = 10
/** The sizing's discount on the channel term until there is a record — see channelSizing. */
export const PLACEHOLDER_CONFIDENCE = 0.4
/** A departure from the base rate smaller than this has no direction to be right or wrong about. */
const DIRECTION_FLOOR = 0.1

const _r = (v, d = 3) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d)
const _sameDz = (a, b) => toNum(a) !== null && toNum(b) !== null && Math.abs(toNum(a) - toNum(b)) < 0.005

// ─── sync: a published view's calls → the ledger ──────────────────────────────

/**
 * PURE. The view's calls against the ledger's ACTIVE calls → what to do.
 *   reaffirm   [{ call, view }]   same channel, same dz — the call continues, original clock kept
 *   create     [view]             a channel with no active call, or one whose dz changed
 *   supersede  [call]             an active call whose channel was dropped or whose dz changed
 */
export function planCallSync(viewCalls, activeCalls) {
    const active = new Map((activeCalls ?? []).map(c => [c.channel_id, c]))
    const out = { reaffirm: [], create: [], supersede: [] }
    const seen = new Set()
    for (const v of viewCalls ?? []) {
        if (!v?.channel_id || seen.has(v.channel_id)) continue
        seen.add(v.channel_id)
        const held = active.get(v.channel_id)
        if (held && _sameDz(held.dz, v.dz)) out.reaffirm.push({ call: held, view: v })
        else {
            if (held) out.supersede.push(held)
            out.create.push(v)
        }
    }
    for (const c of activeCalls ?? []) if (!seen.has(c.channel_id)) out.supersede.push(c)
    return out
}

/** A new ledger entry for a call as published. */
export function newCall(view, tiltId, nowIso) {
    const setMs = Date.parse(view.set_at ?? nowIso)
    return {
        _id: `call_${randomUUID().slice(0, 12)}`,
        channel_id: view.channel_id,
        dz: toNum(view.dz),
        base_dz: toNum(view.base_dz),
        deviation: toNum(view.deviation) ?? (toNum(view.dz) !== null ? toNum(view.dz) - (toNum(view.base_dz) ?? 0) : null),
        z_at_set: toNum(view.z_at_set),
        rationale: view.rationale ?? null,
        set_at: new Date(setMs).toISOString(),
        matures_at: new Date(setMs + HORIZON_WEEKS * 7 * DAY_MS).toISOString(),
        active: true,
        superseded_at: null,
        tilt_ids: [tiltId],
        marks: {},
        graded: false,
    }
}

// ─── grading ──────────────────────────────────────────────────────────────────

/** The grid's z on the last Friday on or before `ms` → number | null. `grid` is [{ t, z }] oldest first. */
function _zAt(grid, ms) {
    let found = null
    for (const p of grid) {
        if (p.t > ms) break
        found = p.z
    }
    return found
}

/**
 * PURE. The marks now due for one call → { [weeks]: mark }, only those not already present and whose
 * date has passed AND whose grid reading exists (the grid lags; a mark waits for its data rather than
 * grading against a stale week).
 */
export function dueMarks(call, grid, nowMs) {
    const setMs = Date.parse(call.set_at)
    const out = {}
    const z0 = _zAt(grid, setMs)
    if (!Number.isFinite(setMs) || z0 === null) return out
    const lastGridMs = grid.length ? grid[grid.length - 1].t : -Infinity
    for (const k of MARK_WEEKS) {
        if (call.marks?.[k]) continue
        const atMs = setMs + k * 7 * DAY_MS
        if (atMs > nowMs || atMs > lastGridMs + 7 * DAY_MS) continue
        const zk = _zAt(grid, atMs)
        if (zk === null) continue
        const f = k / HORIZON_WEEKS
        const actual = zk - z0
        const expCall = (toNum(call.dz) ?? 0) * f
        const expBase = (toNum(call.base_dz) ?? 0) * f
        const callErr = Math.abs(actual - expCall), baseErr = Math.abs(actual - expBase)
        const dev = toNum(call.deviation) ?? 0
        out[k] = {
            weeks: k, at: new Date(atMs).toISOString(), final: k === HORIZON_WEEKS,
            z_set: _r(z0), z_now: _r(zk), actual_dz: _r(actual),
            expected_dz: _r(expCall), base_expected_dz: _r(expBase),
            call_err: _r(callErr), base_err: _r(baseErr),
            beat_base: callErr < baseErr,
            direction_right: Math.abs(dev) >= DIRECTION_FLOOR ? Math.sign(actual - expBase) === Math.sign(dev) : null,
        }
    }
    return out
}

// ─── the record ───────────────────────────────────────────────────────────────

/**
 * PURE. Calls → { graded, beat, hit_rate, confidence, interim } where confidence is what the sizing
 * should discount the channel term by: the PLACEHOLDER until MIN_GRADED calls are final, then
 * clamp(2 × hit − 1, 0, 1) — 0 at a coin flip, 0.4 at a 70% hit rate (the placeholder's level),
 * 0.7 at 85%, 1 only for a forecaster who always beats the base rate.
 */
export function trackRecord(calls) {
    const finals = (calls ?? []).map(c => c?.marks?.[HORIZON_WEEKS]).filter(Boolean)
    const beat = finals.filter(m => m.beat_base).length
    const hit = finals.length ? beat / finals.length : null
    const measured = finals.length >= MIN_GRADED
    const interim = (calls ?? [])
        .filter(c => !c?.graded && c?.marks && Object.keys(c.marks).length)
        .map(c => {
            const latest = Object.values(c.marks).sort((a, b) => b.weeks - a.weeks)[0]
            return { channel_id: c.channel_id, dz: c.dz, active: c.active, weeks: latest.weeks, beat_base: latest.beat_base, direction_right: latest.direction_right }
        })
    return {
        graded: finals.length,
        beat,
        hit_rate: hit === null ? null : _r(hit, 3),
        confidence: measured ? _r(Math.min(1, Math.max(0, 2 * hit - 1)), 3) : PLACEHOLDER_CONFIDENCE,
        measured,
        interim,
    }
}

/** The record → the lines Pythia reads at the top of a review. PURE. */
export function formatRecord(record) {
    if (!record) return null
    const head = record.graded
        ? `YOUR CALL RECORD — ${record.graded} call(s) graded at six months; ${record.beat} beat the base rate (${Math.round((record.hit_rate ?? 0) * 100)}%).`
        : 'YOUR CALL RECORD — no call has reached its six-month grade yet.'
    const conf = record.measured
        ? `Your channel calls are weighted at ${record.confidence} in the sizing — your measured record.`
        : `Your channel calls are weighted at ${record.confidence} in the sizing — a placeholder until ${MIN_GRADED} calls are graded.`
    const interim = (record.interim ?? []).map(i =>
        `  ${i.channel_id} (call ${i.dz}z${i.active ? '' : ', superseded'}) at ${i.weeks}w: ${i.beat_base ? 'AHEAD of' : 'BEHIND'} the base rate${i.direction_right === null ? '' : i.direction_right ? ', moving the way you called' : ', moving against your call'}`)
    return [head, conf, ...(interim.length ? ['Interim marks (not yet graded):', ...interim] : [])].join('\n')
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

const _io = {
    coll: async () => (await getDb()).collection(CALLS_COLLECTION),
    grid: async (channelId) => (await getDb()).collection(STATE_COLLECTION)
        .find({ channel_id: channelId }, { projection: { _id: 0, date: 1, z_score: 1 } }).sort({ date: 1 }).toArray(),
}
export function _setCallsIO(io) { Object.assign(_io, io) }

/**
 * Publish hook: bring the ledger in line with a view about to be stored, and stamp each of the view's
 * calls with its ledger id and — for a restated call — its ORIGINAL date, reading and base rate.
 * Mutates `doc.channel_views`; never throws (a ledger failure must not cost the publish).
 */
export async function syncCallLedger(doc, now = new Date().toISOString()) {
    try {
        const c = await _io.coll()
        const active = await c.find({ active: true }).toArray()
        const plan = planCallSync(doc.channel_views ?? [], active)
        for (const old of plan.supersede) {
            await c.updateOne({ _id: old._id }, { $set: { active: false, superseded_at: now } })
        }
        const byChannel = {}
        for (const { call } of plan.reaffirm) {
            await c.updateOne({ _id: call._id }, { $addToSet: { tilt_ids: doc.id } })
            byChannel[call.channel_id] = call
        }
        for (const v of plan.create) {
            const fresh = newCall(v, doc.id, now)
            await c.insertOne(fresh)
            byChannel[v.channel_id] = fresh
        }
        doc.channel_views = (doc.channel_views ?? []).map(v => {
            const call = byChannel[v.channel_id]
            return call ? { ...v, call_id: call._id, set_at: call.set_at, z_at_set: call.z_at_set, base_dz: call.base_dz, deviation: call.deviation } : v
        })
        if (plan.supersede.length || plan.create.length) {
            logger.info(LOG, 'ledger synced', { reaffirmed: plan.reaffirm.length, created: plan.create.length, superseded: plan.supersede.length })
        }
    } catch (err) {
        logger.warn(LOG, 'call ledger sync failed — view published without ledger ids', err.message)
    }
    return doc
}

/** Monitor hook: write every mark now due across the ledger. Never throws. → number of marks written. */
export async function gradeChannelCalls(nowMs = Date.now()) {
    let written = 0
    try {
        const c = await _io.coll()
        const pending = await c.find({ graded: false }).toArray()
        const grids = {}
        for (const call of pending) {
            grids[call.channel_id] ??= (await _io.grid(call.channel_id))
                .map(r => ({ t: (r.date instanceof Date ? r.date : new Date(r.date)).getTime(), z: toNum(r.z_score) }))
                .filter(p => Number.isFinite(p.t) && p.z !== null)
            const marks = dueMarks(call, grids[call.channel_id], nowMs)
            const keys = Object.keys(marks)
            if (!keys.length) continue
            const set = Object.fromEntries(keys.map(k => [`marks.${k}`, marks[k]]))
            if (marks[HORIZON_WEEKS]) set.graded = true
            await c.updateOne({ _id: call._id }, { $set: set })
            written += keys.length
        }
        if (written) logger.info(LOG, 'calls graded', { marks: written })
    } catch (err) {
        logger.warn(LOG, 'grading failed — marks wait for the next tick', err.message)
    }
    return written
}

/** The record, read. Null on failure — the sizing then keeps the placeholder. */
export async function readTrackRecord() {
    try {
        const c = await _io.coll()
        return trackRecord(await c.find({}).toArray())
    } catch (err) {
        logger.warn(LOG, 'record unreadable — placeholder confidence', err.message)
        return null
    }
}
