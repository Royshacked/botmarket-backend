/**
 * The guard sweep — Talos's tier-0.
 *
 * docs/desks/talos-guards.md. Every Talos read ends by ARMING a set of wake conditions over time
 * AND price; this loop is the thing that evaluates them, and it is deliberately the cheapest code
 * in the monitor: fetch one price per distinct symbol, compare against some numbers, write nothing
 * unless something fired.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
 * Talos's own loop (`dueLoop`) only looks at a setup when `next_check_at` has passed — 30 to 240
 * minutes apart on a swing. Between those glances nothing watched price, so a level was only ever
 * caught if price happened to be sitting on it at the moment of a scheduled look. That is what
 * price BANDS were compensating for, and it is why Mentor spent an ATR read drawing them.
 *
 * This loop closes the gap in the only way that does not cost tokens: it runs on a fast fixed
 * cadence, and it reads the RANGE since its last pass (`priceFeed.rangeSince`) rather than the spot
 * price — so a level touched and left between two passes still fires. Exact levels become as
 * catchable as a wide band ever was, which is what lets the bands go.
 *
 * ── HOW IT WAKES ANYTHING ────────────────────────────────────────────────────
 * It does not run the model and it does not journal. A fired guard simply sets
 * `monitor_state.next_check_at = now`, which makes the document DUE, and Talos's existing loop
 * claims it on its next tick — under the same lease that has always stopped two monitors
 * double-firing an entry. Guards therefore need no execution path of their own, and there is
 * exactly one place a setup is ever assessed.
 *
 * ── SHAPED ON monitoring/paperMark.service.js ────────────────────────────────
 * Same skeleton, deliberately: `createPollLoop`, dedupe by symbol, `partitionByFreshness` so a
 * price someone else already fetched is reused, one fetch per distinct symbol for the rest,
 * `retainOnly` so the feed stays the size of what is live. Our own polling is what caused the FMP
 * 429s before (see the price feed's header), so the discipline is copied rather than reinvented.
 *
 * ONE FETCH PER SYMBOL, NOT PER SETUP: five setups on NVDA cost one quote between them.
 */

import { getDb } from '../providers/mongodb.provider.js'
import { ENTITIES } from '../services/entity/entityCollection.js'
import { PAST_ENTRY } from '../services/entity/vocabulary.js'
import { isAssetOpen } from '../services/market.service.js'
import { guardFires, guardsFromZones } from '../services/setup.schema.js'
import { partitionByFreshness, retainOnly, rangeSince } from '../services/priceFeed.service.js'
import { quoteMapForSymbols } from '../api/broker/paperExecution.service.js'
import { createPollLoop } from './pollLoop.js'
import { logger } from '../services/logger.service.js'
import { config } from '../services/config.js'

const LOG        = '[guardSweep]'
const COLLECTION = ENTITIES
const KIND       = 'setup'

/**
 * How often the guards are evaluated, and therefore the resolution of every price term in the
 * system. Faster catches more wicks and buys more quotes; slower is cheaper and blinder.
 *
 * The floor on what this can usefully be is the publish cadence of whatever is filling the feed —
 * a sweep that runs faster than anything publishes just re-reads the same observation.
 */
const SWEEP_INTERVAL_MS = config.guardSweepIntervalMs

/** The statuses a guard can wake. Pre-entry it is readiness; past entry it is management. */
const WATCHED_STATUSES = ['looking', ...PAST_ENTRY]

const _loop = createPollLoop({ intervalMs: SWEEP_INTERVAL_MS, tick: _tick, log: LOG, name: 'guard sweep' })

export const guardSweepService = { start: _loop.start, stop: _loop.stop, _tick }

/**
 * The window each pass measures over. Held per symbol rather than globally so a symbol that joins
 * late does not inherit a window it was never watched across — which would let its first sweep fire
 * on a "crossing" that happened before anyone was looking.
 */
const _lastSweptAt = new Map()

/**
 * setup id → timer wakes skipped on their price term since its last real read. In memory for the
 * same reason the journal refuses a line per poll: recording a non-event is how a fifty-entry
 * history becomes fifty heartbeats. Cleared when the setup finally fires, and on restart.
 */
const _skipped = new Map()

async function _tick() {
    const db = await getDb()
    const setups = await db.collection(COLLECTION)
        .find({ kind: KIND, status: { $in: WATCHED_STATUSES } },
              { projection: { _id: 0, id: 1, asset: 1, asset_class: 1, direction: 1, status: 1, cadence: 1, scenarios: 1, monitor_state: 1 } })
        .toArray()
    if (!setups.length) { _lastSweptAt.clear(); _skipped.clear(); return }

    // A SHUT MARKET HAS NO CROSSINGS, so buying a quote for one is pure waste — and at this cadence
    // it is a lot of waste: an equity book would fetch every symbol, every sweep, all night, and our
    // own polling is what caused the FMP 429s before.
    //
    // Dropped from the sweep rather than rescheduled: guards are evaluated, not scheduled, so there
    // is nothing to push out. Talos still parks a closed setup on the next open through its own
    // `market_closed` branch, and a crossing cannot be missed by not looking at a market where none
    // can happen. Crypto is open around the clock and simply never takes this branch.
    const live = setups.filter(s => s.asset && isAssetOpen(s.asset, s.asset_class))
    if (!live.length) return

    const symbols = [...new Set(live.map(s => s.asset))]

    // Read before fetching, exactly as the mark loop does: anything else in the app that priced this
    // symbol recently has already published it, and a mark younger than half our interval is as good
    // as the one we would go and buy. HALF, never the whole, or our own previous publication would
    // satisfy the next pass and the feed would freeze.
    const { fresh, stale } = partitionByFreshness(symbols, SWEEP_INTERVAL_MS / 2)
    // `quoteMapForSymbols` publishes what it fetched, so the trail grows as a side effect. The fresh
    // half is deliberately NOT republished: it was read FROM the trail, and writing it back would
    // stack duplicate observations and make a still price look like movement.
    const fetched = stale.length ? await quoteMapForSymbols(stale) : new Map()

    const now  = Date.now()
    const seen = new Set([...fresh.keys(), ...fetched.keys()])
    const ops = []
    let armed = 0, fired = 0

    for (const setup of live) {
        const symbol = setup.asset
        if (!symbol) continue

        // A setup whose next scheduled look has already passed is about to be claimed by Talos
        // anyway. Firing a guard at it would be a write that changes nothing.
        const nextAt = Date.parse(setup.monitor_state?.next_check_at ?? '')
        if (Number.isFinite(nextAt) && nextAt <= now) continue

        const guards = _guardsFor(setup)
        if (!guards.length) continue
        armed++

        // Since the last SWEEP for the price term (did it cross since anyone looked) and since the
        // last READ for the time term (how long has the model been away). Two different clocks, and
        // conflating them would let a busy sweep cadence reset the model's own patience.
        const since   = _lastSweptAt.get(symbol) ?? (now - SWEEP_INTERVAL_MS)
        const range   = rangeSince(symbol, since)
        // Never read → Infinity, so the backstop fires on the first sweep. A setup nobody has ever
        // assessed is the one case where looking immediately is unambiguously right.
        const lastRead   = Date.parse(setup.monitor_state?.last_read_at ?? '')
        const elapsedMin = Number.isFinite(lastRead) ? (now - lastRead) / 60_000 : Infinity

        const hit = guards.find(g => guardFires(g, { elapsedMin, range }))
        if (!hit) {
            // THE WAKE DELIBERATELY NOT TAKEN. A conjunctive guard whose time term held while its
            // price term did not is the saving this design exists for, made countable: under a
            // plain timer each of these would have bought a model call whose only answer was
            // "still nowhere near".
            //
            // Counted in memory and never written, because writing it would break the one rule the
            // journal depends on — a free poll appends nothing. It rides out on the next entry that
            // was worth paying for, and a process restart simply loses a diagnostic.
            if (guards.some(g => g.price != null && g.after_min != null && elapsedMin >= g.after_min)) {
                _skipped.set(setup.id, (_skipped.get(setup.id) ?? 0) + 1)
            }
            continue
        }

        fired++
        ops.push({
            updateOne: {
                filter: { id: setup.id },
                // DUE NOW, and nothing else. The sweep records no verdict, writes no journal line and
                // touches no lifecycle field — it only says "look at this one next tick". Everything
                // that interprets the wake belongs to the read that follows it.
                update: { $set: {
                    'monitor_state.next_check_at': new Date(now).toISOString(),
                    'monitor_state.woke_on': {
                        ...hit,
                        at: new Date(now).toISOString(),
                        // WHEN THIS LINE WAS DRAWN — the whole point of recording the guard at all.
                        // It is the last read's timestamp because guards are armed as a set, whole,
                        // by exactly that read.
                        armed_at: setup.monitor_state?.last_read_at ?? null,
                        skipped:  _skipped.get(setup.id) ?? 0,
                    },
                } },
            },
        })
        _skipped.delete(setup.id)
    }

    // Advance the window only for symbols this pass actually observed. Advancing one we saw nothing
    // for would silently discard the interval it went unwatched across — the next pass would then
    // measure from now and a crossing inside the gap would never be evidence for anything.
    for (const symbol of seen) _lastSweptAt.set(symbol, now)
    retainOnly(symbols)
    const stillWatched = new Set(symbols)
    for (const symbol of [..._lastSweptAt.keys()]) if (!stillWatched.has(symbol)) _lastSweptAt.delete(symbol)

    if (ops.length) await db.collection(COLLECTION).bulkWrite(ops, { ordered: false })
    // Logged only when something happened. A line per quiet sweep would be the same noise the
    // journal refuses for the same reason (docs/desks/talos-guards.md, "a free poll never writes").
    if (fired) {
        logger.info(LOG, `${fired} guard(s) fired across ${armed} armed setup(s), ${symbols.length} symbol(s)` +
            ` — ${fetched.size} fetched, ${fresh.size} read from the feed`)
    }
}

/**
 * The guards to evaluate for one setup.
 *
 * MIGRATION HAPPENS HERE, not in a backfill script. A document armed before this design carries
 * zones and no `monitor_state.guards`, and treating it as "nothing to watch" would silently stop
 * monitoring a live trade. So its zones stand in until its next real read writes its own.
 */
function _guardsFor(setup) {
    const stored = setup?.monitor_state?.guards
    return Array.isArray(stored) && stored.length ? stored : guardsFromZones(setup)
}
