import { latestRun, readRun, listRuns, nodeHistory } from '../../services/situation/store.js'
import { buildScorecard } from '../../services/situation/scorecard.js'
import { overrideNode } from '../../services/situation/review.js'
import { canSeeSituation } from '../../services/situation/access.js'
import { makeHandle } from '../_shared/handle.util.js'
import { httpError } from '../../services/httpError.util.js'

const LOG    = '[situation:controller]'
const handle = makeHandle(LOG)
const RUN_ID = /^run_[0-9a-f-]{36}$/
const NODE_ID = /^node_[0-9a-f-]{36}$/

// The situation network's board (docs/design/situation-network.md §11.6). ONLY the allow-list (SITUATION_USERS: Roy and
// Marce during the forward test) — everyone else gets a 404, as if it did not exist. Overrides are Roy's: the admin.

/** The allow-list gate: off it, the routes do not exist. */
export function gate(req, res, next) {
    if (!canSeeSituation(req.user)) return res.status(404).json({ error: 'Not found' })
    next()
}

/** GET /api/situation/access → `{ ok }`: may this user see the board? (The one route off the gate.) */
export function getAccess(req, res) {
    res.json({ ok: canSeeSituation(req.user) })
}

/** GET /api/situation — the latest complete run, whole, and the run list. */
export const getLatest = handle('getLatest', async (req, res) => {
    const head = await latestRun()
    if (!head) return res.json({ run: null, runs: [] })
    const [run, runs] = await Promise.all([readRun(head.run_id), listRuns()])
    res.json({ ...run, runs, canOverride: req.user?.role === 'admin' })
})

/** GET /api/situation/runs/:id — one complete run, whole. */
export const getRun = handle('getRun', async (req, res) => {
    if (!RUN_ID.test(String(req.params.id))) throw httpError(400, 'not a run id')
    const run = await readRun(req.params.id)
    if (!run) throw httpError(404, 'no such run')
    res.json(run)
})

/** GET /api/situation/nodes/:id/history — one node's numbers run by run. */
export const getNodeHistory = handle('getNodeHistory', async (req, res) => {
    if (!NODE_ID.test(String(req.params.id))) throw httpError(400, 'not a node id')
    res.json({ history: await nodeHistory(req.params.id) })
})

/** GET /api/situation/scorecard — the forward test against its declared rule. */
export const getScorecard = handle('getScorecard', async (req, res) => {
    res.json(await buildScorecard())
})

/** POST /api/situation/nodes/:id/override — Roy's numbers `{ p: { option: number } }` → a new run. Admin only. */
export const postOverride = handle('postOverride', async (req, res) => {
    if (req.user?.role !== 'admin') throw httpError(403, 'overrides are the admin\'s')
    if (!NODE_ID.test(String(req.params.id))) throw httpError(400, 'not a node id')
    const p = req.body?.p
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw httpError(400, 'p is { option: number }')
    const r = await overrideNode(req.params.id, p, req.user.id ?? req.user._id)
    if (!r.ok) throw httpError(400, r.reason)
    res.json(r)
})
