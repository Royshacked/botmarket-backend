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
import { kairosService } from '../api/kairos/kairos.service.js'
import { setupService } from '../api/setups/setups.service.js'
import { scanService } from '../api/scanner/scan.service.js'
import { coverageService } from '../api/analyst/coverage.service.js'
import { listPortfolios } from './portfolioState.service.js'

const LOG = '[watchlist]'

/**
 * The kinds reported unless asked otherwise.
 *
 * `idea` is absent on purpose. ideaService.getIdeas returns portfolio holdings AND loose legacy
 * ideas from the retired Idea agent — and its chat no longer exists, so reporting one invites an
 * offer to open a desk that isn't there. Holdings are reported as their BOOK instead.
 */
export const DEFAULT_KINDS = ['call', 'setup', 'portfolio', 'coverage', 'scan']

/**
 * @param {string} userId
 * @param {object} [opts]
 * @param {string[]} [opts.kinds]   subset of DEFAULT_KINDS
 * @param {boolean}  [opts.includeFinished]  include terminal items (closed calls/setups)
 * @param {string}   [opts.symbol]  narrow to one name
 * @returns {Promise<{ asOf:number, items:object[], counts:object, unavailable:string[] }>}
 */
export async function listWatchedItems(userId, { kinds = DEFAULT_KINDS, includeFinished = false, symbol = null } = {}, deps = {}) {
    const {
        calls = (uid) => kairosService.listKairosCalls(uid, { onError: 'throw' }),
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
        ['call', calls], ['setup', setups], ['portfolio', portfolios],
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

    return { asOf, items, counts, unavailable }
}
