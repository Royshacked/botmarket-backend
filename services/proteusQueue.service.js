// PROTEUS'S MEASURED PROFILE, AHEAD OF ANY ASK (docs/design/proteus.md §4.4–4.5, §8.1 — build step 4, 2026-11-12).
//
// Every day-board name (09:20 · 10:30 · 14:30) and every name the house chain picks gets its measured profile in
// the background, so whoever opens the name — Mentor before a trade, the user in chat, the Hotlist badge (step 5) —
// finds it ready instead of waiting seconds for it. Code only, no model: the WRITTEN read stays on open (§8.1).
//
// ONE queue, ONE name at a time (a profile is ~0.5 s of CPU and ~15 FMP calls — 10 years daily, a year of 1-hour bars,
// ~3 months of 5-minute bars): the triggers only add names; the worker drains them in order, a pause between names so
// a 25-name board never competes with live pricing for the key. A name already profiled this week costs nothing
// (profileFor's week cache), and a name queued twice is profiled once.
//
// The queue lives in memory on the loop leader, like every background loop here (docs/architecture/single-instance.md):
// a restart forgets what was waiting, and the next board or a name's first open profiles it. Never throws — a name
// that fails is logged and skipped; a rate limit pauses the queue and keeps the name.

import { profileFor } from './behaviourProfile.service.js'
import { isLoopLeader } from './loopLeader.js'
import { logger } from './logger.service.js'

const LOG = '[proteusQueue]'

export const GAP_MS = 2_000          // between names — the board's own FMP pacing stays the priority
export const RATE_LIMIT_PAUSE_MS = 60_000
export const MAX_WAITING = 500        // a runaway trigger cannot grow the queue without end
const MAX_RATE_LIMIT_RETRIES = 3

const _deps = {
    profile: (symbol) => profileFor(symbol),
    leader:  () => isLoopLeader(),
    sleep:   (ms) => new Promise(r => setTimeout(r, ms)),
}
/** Test seam. */
export function _setDeps(d) { Object.assign(_deps, d) }

const _waiting = []                  // symbols, in order
const _known = new Set()             // waiting or in work — one entry per name
let _draining = null                 // the worker's promise while it runs
const _stats = { done: 0, failed: 0 }

/**
 * Add names to profile. Symbols are upper-cased, blanks and duplicates dropped; a name waiting or in work is not added
 * twice. Not the loop leader → nothing (the leader's boards and chain do this). Returns how many were added; the work
 * runs in the background.
 * @param {string[]} symbols
 * @param {{ source?: string }} [opts]  who asked, for the log ("hd_2026-11-12_open", "house_scan")
 */
export function queueProfiles(symbols, { source = 'unknown' } = {}) {
    if (!_deps.leader()) return 0
    let added = 0
    for (const raw of Array.isArray(symbols) ? symbols : []) {
        const sym = String(raw ?? '').trim().toUpperCase()
        if (!sym || _known.has(sym)) continue
        if (_waiting.length >= MAX_WAITING) { logger.warn(LOG, `queue full (${MAX_WAITING}) — ${source}'s other names wait for the next ask`); break }
        _waiting.push(sym)
        _known.add(sym)
        added++
    }
    if (added) {
        logger.info(LOG, `${added} name(s) queued from ${source} (${_waiting.length} waiting)`)
        if (!_draining) _draining = _drain().finally(() => { _draining = null })
    }
    return added
}

async function _drain() {
    while (_waiting.length) {
        const sym = _waiting[0]
        let tries = 0
        for (;;) {
            try {
                await _deps.profile(sym)
                _stats.done++
                break
            } catch (err) {
                // A rate limit is the key being busy, not the name being bad: pause the queue and try the same name again.
                if (err?.status === 429 && tries < MAX_RATE_LIMIT_RETRIES) {
                    tries++
                    logger.warn(LOG, `${sym}: rate limited — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s (try ${tries}/${MAX_RATE_LIMIT_RETRIES})`)
                    await _deps.sleep(RATE_LIMIT_PAUSE_MS)
                    continue
                }
                _stats.failed++
                logger.warn(LOG, `${sym}: not profiled — ${err?.message ?? err}`)
                break
            }
        }
        _waiting.shift()
        _known.delete(sym)
        if (_waiting.length) await _deps.sleep(GAP_MS)
    }
    logger.info(LOG, `queue drained (${_stats.done} profiled, ${_stats.failed} failed since start)`)
}

/** What is waiting, for the admin's health view and tests. */
export function queueState() {
    return { waiting: [..._waiting], running: Boolean(_draining), ..._stats }
}

/** Tests: wait for the worker to finish. */
export function _drained() {
    return _draining ?? Promise.resolve()
}

/** Tests: forget everything. */
export function _reset() {
    _waiting.length = 0
    _known.clear()
    _stats.done = 0
    _stats.failed = 0
}
