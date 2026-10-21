import { todayHotlist, boardById, hotlistOutcomes } from '../../services/hotlist.service.js'
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

/** GET /api/hotlist/boards/:id — one checkpoint's board. */
export const getBoard = handle('getBoard', async (req, res) => {
    if (!BOARD_ID.test(String(req.params.id))) throw httpError(400, 'not a board id')
    const board = await boardById(req.params.id)
    if (!board) throw httpError(404, 'no such board')
    res.json(board)
})

/** GET /api/hotlist/outcomes — the outcome log summarised: per column and grade, and what is verified. */
export const getOutcomes = handle('getOutcomes', async (req, res) => { res.json(await hotlistOutcomes()) })
