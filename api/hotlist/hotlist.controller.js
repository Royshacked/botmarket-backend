import { todayHotlist, boardWithResults, hotlistOutcomes } from '../../services/hotlist.service.js'
import { catalystReadService } from '../../services/catalystRead.service.js'
import { hotlistResearchService } from '../../services/hotlistResearch.service.js'
import { makeHandle } from '../_shared/handle.util.js'
import { httpError } from '../../services/httpError.util.js'

const LOG    = '[hotlist:controller]'
const handle = makeHandle(LOG)

const DAY = /^\d{4}-\d{2}-\d{2}$/
const BOARD_ID = /^hb_\d{4}-\d{2}-\d{2}_[a-z]+$/

// The Floor's Hotlist (docs/design/daily-names.md §8). Reads only — the boards are written by the
// screener's checkpoints, for everyone (research binds to no account, so no workspace scope).

/** GET /api/hotlist?day=YYYY-MM-DD — the latest board of the day (or of the latest day) + its checkpoints. */
export const getToday = handle('getToday', async (req, res) => {
    const day = req.query.day
    if (day != null && !DAY.test(String(day))) throw httpError(400, 'day must be YYYY-MM-DD')
    res.json(await todayHotlist({ day: day ?? null }))
})

/** GET /api/hotlist/boards/:id — one checkpoint's board, each row with its results once scored. */
export const getBoard = handle('getBoard', async (req, res) => {
    if (!BOARD_ID.test(String(req.params.id))) throw httpError(400, 'not a board id')
    const board = await boardWithResults(req.params.id)
    if (!board) throw httpError(404, 'no such board')
    res.json(board)
})

/** GET /api/hotlist/outcomes — the outcome log summarised: per column and grade, and what is verified. */
export const getOutcomes = handle('getOutcomes', async (req, res) => { res.json(await hotlistOutcomes()) })

/**
 * GET /api/hotlist/reads — Prometheus's catalyst reads on the week's picks (docs/design/horizon-chains.md §3): the live ones
 * and those settled in the last two weeks, with their targets, what is still open, the window and the grade.
 */
export const getReads = handle('getReads', async (req, res) => { res.json(await catalystReadService.listReads()) })

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/
// What a refused ask says — a 409 the panel shows as it is, never a failure.
const READ_REFUSED = {
    no_board: [404, 'That board is gone — reload the Hotlist.'],
    stale_board: [409, 'Reads are asked for on today\'s board only.'],
    not_on_week: [409, 'That name is not graded for this week.'],
    live_read: [409, 'Prometheus already has a live read on that name.'],
    already_queued: [409, 'That name is already waiting for a read.'],
    daily_cap: [429, 'Today\'s catalyst reads are used up — try again tomorrow.'],
    queue_unavailable: [503, 'The research queue could not be reached.'],
}

/**
 * POST /api/hotlist/reads { board, symbol } — a user asks Prometheus for a catalyst read on a This week row Argus did not
 * pick (horizon-chains.md §3). → `{ outcome: 'started' | 'queued' }`; the read lands in GET /reads when it is done.
 */
export const requestRead = handle('requestRead', async (req, res) => {
    const board = String(req.body?.board ?? '')
    const symbol = String(req.body?.symbol ?? '').toUpperCase().trim()
    if (!BOARD_ID.test(board)) throw httpError(400, 'not a board id')
    if (!SYMBOL.test(symbol)) throw httpError(400, 'not a symbol')
    const r = await hotlistResearchService.requestRead({ boardId: board, symbol, userId: req.user?._id })
    if (!r.ok) { const [code, msg] = READ_REFUSED[r.reason] ?? [500, 'The read was not asked for.']; throw httpError(code, msg) }
    res.status(202).json({ outcome: r.outcome })
})
