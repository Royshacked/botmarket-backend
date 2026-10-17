import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeActRig, shapeOf, TRADER } from '../helpers/actRig.js'
import { makeScannerActions, applyRead, scannerApplyEdit, SCANNER_REASONS } from '../../services/desks/actions/scanner.actions.js'
import { scannerDesk, scannerNextState, _radarBoard } from '../../services/desks/scanner.desk.js'

// Unified-chat phase 8a, Argus: the list is committed FROM THE SESSION through the scan service; the lens and the
// Prometheus read are direct edits, the read applied only to the list it was read for.

const user = TRADER
const LIST = { period: { label: 'week' }, thesis: 'Semis on a pullback', direction: 'long', candidates: [{ ticker: 'NVDA' }, { ticker: 'AMD' }, { ticker: 'MU' }] }
const BOARD = { candidates: [{ ticker: 'NVDA' }], runIds: ['r1', 'r2'], runs: 2 }
const EDITING = { editingScanId: 'scan_9', editing: { kind: 'scan', entityId: 'scan_9' } }

function rig({ state = null, scans = {} } = {}) {
    const calls = { save: [], update: [] }
    const fakeScans = {
        saveScan:   async (scan, uid) => { calls.save.push({ scan, uid }); return scans.save?.() ?? { ok: true, doc: { id: 'scan_1', thesis: scan.thesis, profile: scan.profile } } },
        updateScan: async (id, patch, uid) => { calls.update.push({ id, patch, uid }); return scans.update?.() ?? { ok: true, doc: { id, thesis: patch.thesis, profile: patch.profile } } },
    }
    const r = makeActRig({ agent: 'scanner', desk: { ...scannerDesk, actions: makeScannerActions({ scans: fakeScans }) }, state })
    return { ...r, calls }
}

// ─── commits ──────────────────────────────────────────────────────────────────

test('generate saves the list FROM THE SESSION under its lens, seals onto the scan, and ends the cut', async () => {
    const r = rig({ state: { profile: 'investing', pendingScan: LIST, editingScanId: null } })
    const { s, press, stateOf } = await r.start(user)
    const out = await press('generate', { scan: { thesis: 'EVIL', candidates: [{ ticker: 'X' }] } })
    assert.deepEqual(shapeOf(out), { result: { scan: { id: 'scan_1', thesis: LIST.thesis, profile: 'investing' }, profile: 'investing' } })
    assert.deepEqual(r.calls.save[0].scan, { ...LIST, profile: 'investing' }, 'the session list — a list in the args is ignored')
    assert.deepEqual(r.seals[0], { userId: 'u1', sessionId: s.sessionId, agent: 'scanner', kind: 'scan', entityIds: ['scan_1'], name: LIST.thesis })
    assert.equal(await stateOf(), null)
})

test('a radar cut is saved stamped with its source and the board\'s run ids', async () => {
    const r = rig({ state: { profile: 'trading', radar: true, radarBoard: BOARD, pendingScan: LIST } })
    await (await r.start(user)).press('generate')
    assert.equal(r.calls.save[0].scan.source, 'aether')
    assert.deepEqual(r.calls.save[0].scan.sourceRuns, ['r1', 'r2'])
})

test('generate refuses an empty list and a list already saved; a failed save keeps the list', async () => {
    assert.equal((await (await rig({ state: { pendingScan: { candidates: [] } } }).start(user)).press('generate')).reason, 'nothing_to_commit')
    assert.equal((await (await rig({ state: { pendingScan: LIST, ...EDITING } }).start(user)).press('generate')).reason, 'not_new')
    const r = rig({ state: { pendingScan: LIST }, scans: { save: () => ({ ok: false }) } })
    const { press, stateOf } = await r.start(user)
    assert.equal((await press('generate')).reason, 'save_failed')
    assert.deepEqual((await stateOf()).pendingScan, LIST)
})

test('update writes the refined list onto the saved scan and STAYS on it for more refining', async () => {
    const r = rig({ state: { profile: 'trading', pendingScan: LIST, ...EDITING, readCut: { dropped: [], survived: true } } })
    const { press, stateOf } = await r.start(user)
    await press('update')
    assert.deepEqual(r.calls.update[0], { id: 'scan_9', uid: 'u1', patch: { period: LIST.period, thesis: LIST.thesis, direction: 'long', candidates: LIST.candidates, profile: 'trading' } })
    assert.equal(r.seals[0].onlyIfEditing, true)
    const after = await stateOf()
    assert.equal(after.editingScanId, 'scan_9')
    assert.deepEqual(after.editing, EDITING.editing)
    assert.equal(after.readCut, null)
})

test('update answers the scan service\'s refusal; later leaves the saved list without writing it', async () => {
    assert.equal((await (await rig({ state: { pendingScan: LIST, ...EDITING }, scans: { update: () => ({ ok: false, reason: 'not_found' }) } }).start(user)).press('update')).reason, 'not_found')
    const r = rig({ state: { pendingScan: LIST, ...EDITING } })
    const { press, stateOf } = await r.start(user)
    assert.deepEqual(shapeOf(await press('later')), { result: {} })
    assert.equal(r.calls.update.length, 0)
    assert.equal(await stateOf(), null)
    assert.equal((await (await rig({ state: { pendingScan: LIST } }).start(user)).press('later')).reason, 'nothing_to_commit')
})

// ─── the Prometheus read ──────────────────────────────────────────────────────

const ROWS = [
    { ticker: 'NVDA', keep: true, direction: 'long', flag: null, why: 'guided up', read: { verdict: 'credible', net: 'helped', read: 'the filing backs it' } },
    { ticker: 'AMD', keep: false, why: 'contradicted by the 10-Q', read: { verdict: 'contradicted' } },
    { ticker: 'EVIL', keep: true, why: 'not on the list' },
]

test('a read rewrites the list to what survived, annotates the survivors, and reports the dropped', () => {
    const out = applyRead({ pendingScan: LIST }, { tickers: ['nvda', 'AMD', 'MU'], rows: ROWS })
    assert.deepEqual(out.state.pendingScan.candidates.map(c => c.ticker), ['NVDA', 'MU'], 'a name the read never reached keeps its place')
    assert.deepEqual(out.state.pendingScan.candidates[0].prometheus, { verdict: 'credible', net: 'helped', direction: 'long', flag: null, why: 'guided up', read: 'the filing backs it' })
    assert.deepEqual(out.state.readCut, { dropped: [{ ticker: 'AMD', why: 'contradicted by the 10-Q', verdict: 'contradicted', flag: null }], survived: true })
    assert.ok(!out.state.pendingScan.candidates.some(c => c.ticker === 'EVIL'), 'a read never adds a name')
    assert.equal('editList' in out.state, false, 'not refining a saved list — no editList to touch')
})

test('C3: while a saved list is refined, the read rewrites the list Argus refines from too', () => {
    const out = applyRead({ pendingScan: LIST, editList: LIST, ...EDITING }, { tickers: ['NVDA', 'AMD', 'MU'], rows: ROWS })
    assert.deepEqual(out.state.editList.candidates.map(c => c.ticker), ['NVDA', 'MU'])
    assert.deepEqual(out.state.editList, out.state.pendingScan)
})

test('C6: a read\'s fields are typed and capped; a repeated name cannot stand in for a missing one', () => {
    const wild = [{ ticker: 'NVDA', keep: true, direction: { evil: 1 }, flag: 'x'.repeat(500), why: 'y'.repeat(5000), read: { verdict: 7, net: ['n'] } }]
    const p = applyRead({ pendingScan: LIST }, { tickers: ['NVDA', 'AMD', 'MU'], rows: wild }).state.pendingScan.candidates[0].prometheus
    assert.deepEqual([p.verdict, p.net, p.direction], [null, null, null])
    assert.equal(p.flag.length, 40)
    assert.equal(p.why.length, 600)
    const dup = { ...LIST, candidates: [{ ticker: 'A' }, { ticker: 'A' }, { ticker: 'B' }] }
    assert.equal(applyRead({ pendingScan: dup }, { tickers: ['A', 'B', 'B'], rows: [] }).reason, 'stale_read')
})

test('a read of a list that changed since is stale; nothing surviving leaves the list untouched', () => {
    assert.equal(applyRead({ pendingScan: LIST }, { tickers: ['NVDA', 'AMD'], rows: ROWS }).reason, 'stale_read')
    assert.equal(applyRead({ pendingScan: LIST }, { tickers: ['NVDA', 'AMD', 'KLAC'], rows: ROWS }).reason, 'stale_read')
    const all = applyRead({ pendingScan: LIST }, { tickers: ['NVDA', 'AMD', 'MU'], rows: LIST.candidates.map(c => ({ ticker: c.ticker, keep: false })) })
    assert.deepEqual(all.state.pendingScan, LIST)
    assert.equal(all.state.readCut.survived, false)
    assert.equal(applyRead(null, { tickers: ['NVDA'], rows: [] }).reason, 'nothing_to_edit')
    assert.equal(applyRead({ pendingScan: LIST }, { tickers: ['NVDA'] }).reason, 'invalid_edit')
})

test('the read goes through the state route: kept markers survive, a stale read writes nothing', async () => {
    const r = rig({ state: { pendingScan: LIST, ...EDITING } })
    const { edit, stateOf } = await r.start(user)
    assert.deepEqual(await edit({ read: { tickers: ['NVDA', 'AMD'], rows: ROWS } }), { reason: 'stale_read' })
    assert.equal((await stateOf()).readCut, undefined)
    assert.equal((await edit({ read: { tickers: ['NVDA', 'AMD', 'MU'], rows: ROWS } })).ok, true)
    const after = await stateOf()
    assert.equal(after.pendingScan.candidates.length, 2)
    assert.deepEqual(after.editing, EDITING.editing)
})

// ─── the lens ─────────────────────────────────────────────────────────────────

test('the lens is a direct edit — before the first message too — and locked to trading on a hand-off', () => {
    assert.equal(scannerApplyEdit(null, { profile: 'investing' }).state.profile, 'investing')
    assert.equal(scannerApplyEdit({ profile: 'trading', pendingScan: LIST }, { profile: 'investing' }).state.pendingScan, LIST)
    assert.equal(scannerApplyEdit({ handoff: true }, { profile: 'investing' }).reason, 'invalid_edit')
    assert.equal(scannerApplyEdit({}, { profile: 'momentum' }).reason, 'invalid_edit')
    assert.equal(scannerApplyEdit({}, { angles: ['x'] }).reason, 'invalid_edit')
})

// ─── the radar board on a session turn ────────────────────────────────────────

test('a turn\'s radar board is checked, capped, cut in that turn, and kept for the cut', () => {
    assert.equal(_radarBoard(null), null)
    assert.equal(_radarBoard({ candidates: [] }), null)
    assert.equal(_radarBoard({ candidates: ['NVDA', 7, null] }), null, 'C6: candidates are objects')
    assert.equal(_radarBoard({ candidates: Array.from({ length: 500 }, (_, i) => ({ ticker: `T${i}` })) }).candidates.length, 200)
    const prepared = scannerDesk.prepareInput({ radarBoard: BOARD, accounts: [] })
    assert.deepEqual(prepared.radarBoard.runIds, ['r1', 'r2'])

    const next = scannerNextState({ profile: 'trading' }, { scan: LIST }, prepared)
    assert.equal(next.radar, true)
    assert.deepEqual(next.radarBoard.candidates, BOARD.candidates)
    // The mode carries on the next turn without a board; a new list clears a read.
    const later = scannerNextState({ ...next, readCut: { dropped: [], survived: true } }, { reply: 'which?' }, {})
    assert.equal(later.radar, true)
    assert.deepEqual(later.readCut, { dropped: [], survived: true })
    assert.equal(scannerNextState(later, { scan: LIST }, {}).readCut, null)
    // A route landing is new work: the board goes.
    assert.equal(scannerDesk.onRouted(next, {}).radar, false)
})

test('Argus refusals answer in its own words', () => {
    assert.equal(SCANNER_REASONS.stale_read[0], 409)
    assert.equal(scannerDesk.reasons, SCANNER_REASONS)
})
