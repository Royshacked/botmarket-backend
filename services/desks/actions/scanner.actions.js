// Argus's commits and direct edits, run against the SESSION (unified-chat plan phase 8, K2/K3).
//
// The list is read from Argus's agentState — never from the client — and handed to the SAME service the scan
// routes use (scanService.saveScan / updateScan). The action contract is mentor.actions.js's.
//
// THE PROMETHEUS READ is an edit, not an action. It runs for minutes (aetherBatchRead: one model call per name),
// so it cannot hold the session lock a commit holds — a turn the user sends meanwhile ("drop MOS, add KLAC") must
// still land. The client runs the read on its existing route and hands the rows back here, and the rows are
// applied only to the list they were read for: a list that changed since answers `stale_read` (the panel's epoch,
// on the server). A read can drop or annotate a name, never add one.

import { scanService as defaultScans } from '../../../api/scanner/scan.service.js'
import { _scannerMode } from '../scanner.desk.js'

const TEXT_MAX = 600   // a read's `why` / `read` prose, as shown on the row

const _str  = (v, max = TEXT_MAX) => (typeof v === 'string' ? v.slice(0, max) : '')
const _tick = (v) => String(v ?? '').trim().toUpperCase()
const listOf  = (state) => (state?.pendingScan?.candidates?.length ? state.pendingScan : null)

/** The scan as it is saved: the list, the lens it was cut under, and — for a radar cut — the board it came from. */
function scanToSave(state) {
    const scan = { ...state.pendingScan, profile: state.profile === 'investing' ? 'investing' : 'trading' }
    // A radar cut is named apart so the next cut can hold back its names; its run ids are what "unless a new event
    // names it" is answered against tomorrow. Stamped here, where the mode is known.
    if (state.radar === true) return { ...scan, source: 'aether', sourceRuns: Array.isArray(state.radarBoard?.runIds) ? state.radarBoard.runIds : [] }
    return scan
}

export function makeScannerActions({ scans = defaultScans } = {}) {
    return {
        /** Save the list as a new scan. The cut is over once its list exists — the radar board goes with it. */
        async generateList({ user, state }) {
            if (!listOf(state)) return { reason: 'nothing_to_commit' }
            if (state.editingScanId) return { reason: 'not_new_list' }
            const out = await scans.saveScan(scanToSave(state), user._id)
            if (!out.ok) return { reason: 'save_failed' }
            return {
                // `profile` so the client can offer the research hand-off on an investing list.
                result: { scan: out.doc, profile: out.doc.profile ?? state.profile ?? 'trading' },
                seal:   { kind: 'scan', entityIds: [out.doc.id], name: out.doc.thesis ?? null },
                after:  null,
            }
        },

        /**
         * Update the saved list being refined. The desk STAYS on it for more refining (the panel's rule): the turns
         * so far are sealed onto the scan, and the next update appends to the context it reopened.
         */
        async updateList({ user, state }) {
            const id = state?.editingScanId ? String(state.editingScanId) : null
            if (!id || !listOf(state)) return { reason: 'nothing_to_commit' }
            const { period, thesis, direction, candidates } = state.pendingScan
            const out = await scans.updateScan(id, { period, thesis, direction, candidates, profile: state.profile }, user._id)
            if (!out.ok) return { reason: out.reason ?? 'save_failed' }
            return {
                result: { scan: out.doc, profile: out.doc.profile ?? state.profile ?? 'trading' },
                seal:   { kind: 'scan', entityIds: [id], name: out.doc.thesis ?? null, onlyIfEditing: true },
                after:  { ...state, readCut: null },
            }
        },

        /** Stop refining a saved list without updating it. */
        async later({ state }) {
            if (!state?.editingScanId) return { reason: 'nothing_to_commit' }
            return { result: {}, after: null }
        },
    }
}

export const scannerActions = makeScannerActions()

/**
 * Apply a Prometheus read to the list it was read for. Pure. → `{ state }` or `{ reason }`.
 *
 * It REWRITES the list rather than annotating it, because the cut is the point: what the user generates should be
 * what survived. What was refused is kept beside it (`readCut.dropped`), with the reason. NOTHING SURVIVING DOES
 * NOT REWRITE — an empty list would take Generate off screen and strand the user; the verdict is shown over the
 * untouched list instead. A name the read never reached keeps its place: a gap in the read, not a refusal.
 */
export function applyRead(state, read) {
    const list = listOf(state)
    if (!list) return { reason: 'nothing_to_edit' }
    const asked = Array.isArray(read?.tickers) ? read.tickers.map(_tick).filter(Boolean) : []
    const rows  = Array.isArray(read?.rows) ? read.rows.filter(r => r && typeof r === 'object') : null
    if (!asked.length || !rows) return { reason: 'invalid_edit' }
    // The list this read was about must still be the list on the table — a turn since replaced it.
    const now = list.candidates.map(c => _tick(c?.ticker))
    if (now.length !== asked.length || !now.every(t => asked.includes(t))) return { reason: 'stale_read' }

    const byTicker = new Map(rows.map(r => [_tick(r.ticker), r]).filter(([t]) => now.includes(t)))
    const kept = list.candidates
        .filter(c => byTicker.get(_tick(c.ticker))?.keep !== false)
        .map(c => {
            const r = byTicker.get(_tick(c.ticker))
            return r ? { ...c, prometheus: {
                verdict:   r.read?.verdict ?? null,
                net:       r.read?.net ?? null,
                direction: r.direction ?? null,
                flag:      r.flag ?? null,
                why:       _str(r.why),
                read:      _str(r.read?.read),
            } } : c
        })
    const dropped = [...byTicker.values()].filter(r => r.keep === false)
        .map(r => ({ ticker: _tick(r.ticker), why: _str(r.why), verdict: r.read?.verdict ?? null, flag: r.flag ?? null }))
    return {
        state: {
            ...state,
            ...(kept.length ? { pendingScan: { ...list, candidates: kept } } : {}),
            readCut: { dropped, survived: kept.length > 0 },
        },
    }
}

/**
 * A direct edit (K3): `{ profile }` — the lens; `{ read: { tickers, rows } }` — a Prometheus read of the list.
 * The angle chips are not an edit: they compose the next turn's message, and that turn is the commit.
 */
export function scannerApplyEdit(state, edit = {}) {
    if ('profile' in edit) {
        if (edit.profile !== 'trading' && edit.profile !== 'investing') return { reason: 'invalid_edit' }
        // A hand-off asks for ONE tradeable name — the lens is locked to trading there.
        if (state?.handoff === true && edit.profile !== 'trading') return { reason: 'invalid_edit' }
        // The lens can be chosen before the first message, with no state yet.
        return { state: { ...(state ?? _scannerMode({})), profile: edit.profile } }
    }
    if ('read' in edit) return applyRead(state, edit.read)
    return { reason: 'invalid_edit' }
}

const SCANNER_REASONS = {
    not_new_list: [409, 'This list is already saved — update it instead'],
    stale_read:   [409, 'The list changed while Prometheus was reading — read it again'],
    save_failed:  [500, 'Could not save the list'],
}
export const scannerReason = (reason) => SCANNER_REASONS[reason] ?? null
