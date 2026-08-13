/**
 * WHICH BOOK the user is standing in front of — one durable fact, held per user.
 *
 * There are THREE workspaces, not two. `live` is real money at a connected broker, `paper` is the
 * simulation, and `manual` is real money at an institution we cannot wire to — the user places the
 * order at their bank and confirms the fill here. They are siblings: same UI, different book, and
 * an idea belongs to exactly one of them (see ideaWorkspace in the frontend's tradeIdea.utils).
 *
 * ── WHY THIS RECORD EXISTS ────────────────────────────────────────────────────
 * Paper and live never needed one: paper being connected IS the switch, so the server could derive
 * the workspace from the broker connections alone. Manual has no such flag — it is broker-less by
 * definition — so the frontend kept the choice in localStorage, and the server could not see it.
 * Everything server-side therefore read a user sitting in MANUAL as sitting in LIVE.
 *
 * That was survivable while the workspace only scoped a UI list. It stopped being survivable when
 * the venue block started telling every desk, every turn, which book "my account" means: a manual
 * user asking "what am I risking" would be answered about a live broker account they are not
 * trading through. So the choice is persisted, and the server is the one who knows.
 *
 * ── THE PRECEDENCE RULE, IN ONE PLACE ─────────────────────────────────────────
 * `resolveWorkspace` is the whole rule, and it is deliberately identical to the frontend's copy in
 * useWorkspaceMode.js — the two must agree or the user sees one workspace while the desks discuss
 * another. Paper-connected WINS over anything stored, because the paper flag is a real server-side
 * toggle the profile screen can flip on its own; the stored value only decides between the two
 * broker-less-of-flag cases (manual vs live).
 *
 * NOT on the user document and NOT in `preferences`, for the reasons experience.model.js records:
 * `stripUser` returns every field it does not explicitly remove and `GET /api/users` has no
 * ownership gating, while `preferences` is rewritten wholesale by the client from localStorage and
 * would destroy anything the server put there.
 */

import { getDb } from '../../providers/mongodb.provider.js'

export const COLLECTION = 'user_workspace'

export const WORKSPACES = ['live', 'paper', 'manual']

export function isValidWorkspace(w) {
    return WORKSPACES.includes(w)
}

/**
 * The workspace the user is in, from the two things that decide it.
 *
 * @param {boolean} paperConnected  brokerService.listConnections(userId).paper — the paper toggle
 * @param {string|null} stored      what this record holds, or null if the user never chose
 * @returns {'live'|'paper'|'manual'}
 */
export function resolveWorkspace(paperConnected, stored = null) {
    if (paperConnected) return 'paper'
    return stored === 'manual' ? 'manual' : 'live'
}

export function buildWorkspaceDoc(userId, workspace, now = new Date()) {
    return { userId, workspace, updatedAt: now.getTime() }
}

export async function ensureWorkspaceIndexes() {
    try {
        const db = await getDb()
        // One row per user — the record is a current state, not a history.
        await db.collection(COLLECTION).createIndex({ userId: 1 }, { unique: true })
    } catch (err) {
        console.warn('[workspace] ensureWorkspaceIndexes failed:', err.message)
    }
}
