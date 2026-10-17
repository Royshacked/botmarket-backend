import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memDb } from '../helpers/memDb.js'
import { makeSessionService } from '../../services/session.service.js'
import { makeAct } from '../../services/desks/act.js'
import { makeScannerActions, applyRead, scannerApplyEdit, scannerReason } from '../../services/desks/actions/scanner.actions.js'
import { scannerDesk, scannerNextState, _radarBoard } from '../../services/desks/scanner.desk.js'

// Unified-chat phase 8a, Argus: the list is committed FROM THE SESSION through the scan service; the lens and the
// Prometheus read are direct edits, the read applied only to the list it was read for.

const user = { _id: 'u1', role: 'trader' }
const LIST = { period: { label: 'week' }, thesis: 'Semis on a pullback', direction: 'long', candidates: [{ ticker: 'NVDA' }, { ticker: 'AMD' }, { ticker: 'MU' }] }
const BOARD = { candidates: [{ ticker: 'NVDA' }], runIds: ['r1', 'r2'], runs: 2 }

function rig({ argus = null, scans = {} } = {}) {
    const { db } = memDb()
    const sessions = makeSessionService({ getDb: async () => db })
    const calls = { save: [], update: [], seal: [] }
    const fakeScans = {
        saveScan:   async (scan, uid) => { calls.save.push({ scan, uid }); return scans.save?.() ?? { ok: true, doc: { id: 'scan_1', thesis: scan.thesis, profile: scan.profile } } },
        updateScan: async (id, patch, uid) => { calls.update.push({ id, patch, uid }); return scans.update?.() ?? { ok: true, doc: { id, thesis: patch.thesis, profile: patch.profile } } },
    }
    const desks = { scanner: { ...scannerDesk, actions: makeScannerActions({ scans: fakeScans }) } }
    const sealing = { sealFromSession: async (args) => { calls.seal.push(args); await sessions.setAgentState({ sessionId: args.sessionId, userId: args.userId, agent: args.agent, state: null }); return { sealed: 1 } } }
    const { act, editState } = makeAct({ sessions, desks, sealing, lock: (_id, fn) => fn() })
    return { sessions, calls, async start() {
        const s = await sessions.getActive({ userId: 'u1', scope: 'main' })
        if (argus) await sessions.setAgentState({ sessionId: s.sessionId, userId: 'u1', agent: 'scanner', state: argus })
        return {
            s,
            press: (action, args) => act({ user, sessionId: s.sessionId, agent: 'scanner', action, args }),
            edit:  (e) => editState({ user, sessionId: s.sessionId, agent: 'scanner', edit: e }),
        }
    } }
}
const stateOf = async (r, s) => (await r.sessions.get({ sessionId: s.sessionId, userId: 'u1' })).agentState?.scanner ?? null

// ─── commits ──────────────────────────────────────────────────────────────────

test('generateList saves the list FROM THE SESSION under its lens, seals onto the scan, and ends the cut', async () => {
    const r = rig({ argus: { profile: 'investing', pendingScan: LIST, editingScanId: null } })
    const { s, press } = await r.start()
    const out = await press('generateList', { scan: { thesis: 'EVIL', candidates: [{ ticker: 'X' }] } })
    assert.deepEqual(out.result, { scan: { id: 'scan_1', thesis: LIST.thesis, profile: 'investing' }, profile: 'investing' })
    assert.deepEqual(r.calls.save[0].scan, { ...LIST, profile: 'investing' }, 'the session list — a list in the args is ignored')
    assert.deepEqual(r.calls.seal[0], { userId: 'u1', sessionId: s.sessionId, agent: 'scanner', kind: 'scan', entityIds: ['scan_1'], name: LIST.thesis })
    assert.equal(await stateOf(r, s), null)
})

test('a radar cut is saved stamped with its source and the board\'s run ids', async () => {
    const r = rig({ argus: { profile: 'trading', radar: true, radarBoard: BOARD, pendingScan: LIST } })
    const { press } = await r.start()
    await press('generateList')
    assert.equal(r.calls.save[0].scan.source, 'aether')
    assert.deepEqual(r.calls.save[0].scan.sourceRuns, ['r1', 'r2'])
})

test('generateList refuses an empty list and a list already saved; a failed save keeps the list', async () => {
    assert.equal((await (await rig({ argus: { pendingScan: { candidates: [] } } }).start()).press('generateList')).reason, 'nothing_to_commit')
    assert.equal((await (await rig({ argus: { pendingScan: LIST, editingScanId: 'scan_9' } }).start()).press('generateList')).reason, 'not_new_list')
    const r = rig({ argus: { pendingScan: LIST }, scans: { save: () => ({ ok: false }) } })
    const { s, press } = await r.start()
    assert.equal((await press('generateList')).reason, 'save_failed')
    assert.deepEqual((await stateOf(r, s)).pendingScan, LIST)
})

test('updateList writes the refined list onto the saved scan and STAYS on it for more refining', async () => {
    const editing = { kind: 'scan', entityId: 'scan_9' }
    const r = rig({ argus: { profile: 'trading', pendingScan: LIST, editingScanId: 'scan_9', editing, readCut: { dropped: [], survived: true } } })
    const { s, press } = await r.start()
    await press('updateList')
    assert.deepEqual(r.calls.update[0], { id: 'scan_9', uid: 'u1', patch: { period: LIST.period, thesis: LIST.thesis, direction: 'long', candidates: LIST.candidates, profile: 'trading' } })
    assert.equal(r.calls.seal[0].onlyIfEditing, true)
    const after = await stateOf(r, s)
    assert.equal(after.editingScanId, 'scan_9')
    assert.deepEqual(after.editing, editing)
    assert.equal(after.readCut, null)
})

test('updateList answers the scan service\'s refusal; Later leaves the saved list without writing it', async () => {
    const r = rig({ argus: { pendingScan: LIST, editingScanId: 'scan_9' }, scans: { update: () => ({ ok: false, reason: 'not_found' }) } })
    assert.equal((await (await r.start()).press('updateList')).reason, 'not_found')
    const r2 = rig({ argus: { pendingScan: LIST, editingScanId: 'scan_9' } })
    const { s, press } = await r2.start()
    assert.deepEqual(await press('later'), { result: {} })
    assert.equal(r2.calls.update.length, 0)
    assert.equal(await stateOf(r2, s), null)
    assert.equal((await (await rig({ argus: { pendingScan: LIST } }).start()).press('later')).reason, 'nothing_to_commit')
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
    const editing = { kind: 'scan', entityId: 'scan_9' }
    const r = rig({ argus: { pendingScan: LIST, editingScanId: 'scan_9', editing } })
    const { s, edit } = await r.start()
    assert.deepEqual(await edit({ read: { tickers: ['NVDA', 'AMD'], rows: ROWS } }), { reason: 'stale_read' })
    assert.equal((await stateOf(r, s)).readCut, undefined)
    assert.deepEqual(await edit({ read: { tickers: ['NVDA', 'AMD', 'MU'], rows: ROWS } }), { ok: true })
    const after = await stateOf(r, s)
    assert.equal(after.pendingScan.candidates.length, 2)
    assert.deepEqual(after.editing, editing)
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

test('a turn\'s radar board is checked, capped, cut in that turn, and kept for the cut', async () => {
    assert.equal(_radarBoard(null), null)
    assert.equal(_radarBoard({ candidates: [] }), null)
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
    assert.equal(scannerReason('stale_read')[0], 409)
    assert.equal(scannerReason('not_new_list')[0], 409)
    assert.equal(scannerReason('nope'), null)
})
