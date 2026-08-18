/**
 * "What am I watching?" — every artifact the user keeps in the app, in one read.
 *
 * A CROSS-KIND question, which is why it is one read and not five. Asked five separate ways, the
 * characteristic failure is answering with two of them and sounding complete; nothing downstream
 * can tell that the setups were missed. Complete by default, narrowed on purpose.
 *
 * It COMPOSES the owning services rather than querying Mongo itself. Standing up a second
 * makeEntityCrud for kind:'setup' when setups.service.js already owns one is the duplicate the
 * shared-mechanism rule forbids — and it would skip each kind's own judgment on the way out
 * (scan staleness is derived in scan.service, not stored).
 *
 * Returns structured rows and NEVER formatted text. The tool adapter formats for the model; a
 * future card or route renders the same fields. `asOf` is a ms epoch at the top level only, so a
 * future time series is literally an array of what this already returns.
 */

import { logger } from './logger.service.js'
import { isTerminal } from './entity/vocabulary.js'
import { WATCH_ROW_PROJECTORS } from './entity/toWatchRow.js'
import { setupService } from '../api/setups/setups.service.js'
import { scanService } from '../api/scanner/scan.service.js'
import { coverageService } from '../api/analyst/coverage.service.js'
import { listPortfolios } from './portfolioState.service.js'
import { resolveMode } from './venue.resolve.service.js'

const LOG = '[watchlist]'

/**
 * The kinds reported unless asked otherwise.
 *
 * `idea` is absent on purpose. ideaService.getIdeas returns portfolio holdings AND loose legacy
 * ideas from the retired Idea agent — and its chat no longer exists, so reporting one invites an
 * offer to open a desk that isn't there. Holdings are reported as their BOOK instead.
 *
 * `call` left for the same reason on 2026-08-18: Kairos is archived, so a call has no desk to be
 * opened in. Listing one would offer the user a door that is not there — the exact failure the
 * paragraph above describes, which is why it goes rather than being quietly kept for old rows.
 */
export const DEFAULT_KINDS = ['setup', 'portfolio', 'coverage', 'scan']

/**
 * The kinds that BELONG to a workspace, and therefore get scoped to it.
 *
 * A call, a setup and a book each bind to an account, so each is real money or simulated money and
 * never both — listing them together is listing two different books as one. Scans, coverage and the
 * house forecast are deliberately absent: they are research, they bind to no account, and they are
 * SHARED across all three workspaces by decision. There is nothing to scope them by and nothing
 * gained by trying.
 */
export const WORKSPACE_SCOPED_KINDS = ['setup', 'portfolio']

/**
 * @param {string} userId
 * @param {object} [opts]
 * @param {string[]} [opts.kinds]   subset of DEFAULT_KINDS
 * @param {boolean}  [opts.includeFinished]  include terminal items (closed calls/setups)
 * @param {string}   [opts.symbol]  narrow to one name
 * @param {string}   [opts.workspace]  'live'|'paper'|'manual' — scope the account-bound kinds to the
 *                                     book the user is standing in. Omitted = every workspace, which
 *                                     is what this did before and what a caller with no workspace to
 *                                     report should still get.
 * @returns {Promise<{ asOf:number, items:object[], counts:object, unavailable:string[] }>}
 */
export async function listWatchedItems(userId, { kinds = DEFAULT_KINDS, includeFinished = false, symbol = null, workspace = null } = {}, deps = {}) {
    const {
        setups = (uid) => setupService.listSetups(uid, { onError: 'throw' }),
        scans = (uid) => scanService.getScans(uid, { onError: 'throw' }),
        coverage = (uid) => coverageService.getCoverage(uid, { onError: 'throw' }),
        portfolios = listPortfolios,
    } = deps

    const asOf = deps.now ?? Date.now()
    if (!userId) return { asOf, items: [], counts: {}, unavailable: [] }

    const want = new Set(Array.isArray(kinds) && kinds.length ? kinds : DEFAULT_KINDS)
    // Both sides upper-cased: a stored asset is usually uppercase but nothing enforces it, and a
    // silent miss here reads to the user as "you have nothing on NVDA".
    const wantSymbol = symbol ? String(symbol).toUpperCase() : null
    const sources = [
        ['setup', setups], ['portfolio', portfolios],
        ['coverage', coverage], ['scan', scans],
    ].filter(([kind]) => want.has(kind))

    // Each source is settled independently: one desk's read failing must not cost the user the
    // other four. Which ones failed is REPORTED rather than swallowed — see `unavailable` below.
    const settled = await Promise.allSettled(sources.map(([, read]) => read(userId)))

    const items = []
    const counts = {}
    const unavailable = []

    for (const [i, [kind]] of sources.entries()) {
        const result = settled[i]
        if (result.status === 'rejected') {
            logger.warn(LOG, `${kind} read failed`, result.reason?.message)
            unavailable.push(kind)
            continue
        }
        const project = WATCH_ROW_PROJECTORS[kind]
        const rows = (Array.isArray(result.value) ? result.value : [])
            // Scoped BEFORE projection, because the venue fields live on the source document and a
            // watch row deliberately does not carry them (it is the shape a model reads, not the
            // shape a venue is derived from). A book reports every workspace it holds something in;
            // everything else resolves to exactly one.
            .filter(d => !workspace || !WORKSPACE_SCOPED_KINDS.includes(kind)
                || (Array.isArray(d?.modes) ? d.modes.includes(workspace) : resolveMode(d) === workspace))
            .map(project)
            .filter(Boolean)
            // A finished call is history, not something being watched. `isTerminal` is the shared
            // vocabulary — never a hand-rolled status list. Kinds with no status (books, scans)
            // have nothing to be terminal about and always pass.
            .filter(r => includeFinished || r.status == null || !isTerminal(r.status))
            .filter(r => !wantSymbol || String(r.symbol ?? '').toUpperCase() === wantSymbol)

        counts[kind] = rows.length
        items.push(...rows)
    }

    // Newest first across kinds — a mixed list is only useful in one order.
    items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

    // `workspace` echoes back so the formatter can SAY which book this is — an empty list is a very
    // different statement with and without it.
    return { asOf, items, counts, unavailable, workspace }
}
