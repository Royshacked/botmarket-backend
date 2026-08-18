// Leader election for the background loops — the enforcement half of the single-instance constraint.
//
// WHY. `docs/architecture/single-instance.md` says this backend must run as exactly ONE process, and
// it is right, but a document cannot stop anyone. The way the constraint gets violated is not a
// decision — it is `replicas: 2` typed into a file that is not in this repo, by someone who has never
// read that document. Nothing fails loudly when it happens: the loops just start running twice, and
// `execution.reconciler` begins cancelling exit orders the other process placed.
//
// So this does not lift the ceiling. It makes crossing it INERT: the second process wins no lease,
// starts no loops, and says so. It still serves HTTP, and `/api/health/ready` still reports honestly.
//
// WHAT IT DOES NOT FIX, and this matters before anyone reaches for `replicas: 2` afterwards: only
// LOOP work is arbitrated here. `chatWs.socketMap` is per-process REQUEST-path state, so a user
// connected to the follower still never receives a card the leader emitted. This buys safety, not
// scale — scaling out additionally needs the chat fan-out (Redis / change stream). See §2 of that doc.
//
// THE MECHANISM is the one `dueLoop._claim` already uses, one level up: a conditional write only one
// caller can win. A single upsert, guarded on "unheld or expired":
//
//   • the document does not exist          → the insert succeeds        → we are the leader
//   • it exists, held by us, or expired    → the update matches         → we are the leader
//   • it exists and someone else holds it  → the upsert collides on _id → we are a follower
//
// That last case is a duplicate-key error, and it is the SIGNAL rather than a fault: `_id` is fixed,
// so an upsert whose filter misses can only try to insert a second document with the same `_id`.

import { logger } from './logger.service.js'

const LOG = '[instanceLock]'

export const LOCK_COLLECTION = 'system_locks'
export const LOOPS_LOCK_KEY  = 'background_loops'

/** Mongo's duplicate-key code. Here it means "another instance holds the lease", not an error. */
const DUPLICATE_KEY = 11000

/**
 * @param {object}   spec
 * @param {Function} spec.getCollection  async () => a Mongo-like collection (injected, so the suite
 *                                       can drive every branch without a database)
 * @param {string}   spec.instanceId     who we are — appears in the lease and in the logs
 * @param {number}   [spec.ttlMs]        how long a lease survives without renewal
 * @param {number}   [spec.renewMs]      how often the holder renews. MUST be well under ttlMs
 * @param {Function} [spec.onAcquired]   called when this process BECOMES the leader (incl. takeover)
 * @param {Function} [spec.onLost]       called when it STOPS being the leader. See the note below —
 *                                       this is the callback that keeps two leaders from coexisting
 * @param {Function} [spec.now]          clock seam
 * @param {string}   [spec.key]
 */
export function createInstanceLock({
    getCollection, instanceId, ttlMs = 30_000, renewMs = 10_000,
    onAcquired = null, onLost = null, now = () => Date.now(), key = LOOPS_LOCK_KEY,
}) {
    // A lease renewed as often as it expires is a lease that expires. The renew interval has to be
    // comfortably inside the TTL so a single slow round trip does not hand leadership away.
    if (!(renewMs < ttlMs / 2)) {
        throw new Error(`instanceLock: renewMs (${renewMs}) must be < half of ttlMs (${ttlMs})`)
    }

    let leader = false
    let timer  = null

    /**
     * Try to take or extend the lease. NEVER throws: an unreachable database means we cannot prove
     * we are alone, and the safe reading of "cannot prove" is "we are not the leader".
     *
     * @returns {Promise<boolean>} whether this process holds the lease afterwards
     */
    async function tryAcquire() {
        const t = now()
        try {
            const col = await getCollection()
            await col.updateOne(
                {
                    _id: key,
                    // Ours to renew, or nobody's to take. Anything else and the upsert collides.
                    $or: [{ holder: instanceId }, { expiresAt: { $lte: new Date(t).toISOString() } }],
                },
                { $set: { holder: instanceId, expiresAt: new Date(t + ttlMs).toISOString() } },
                { upsert: true },
            )
            return true
        } catch (err) {
            if (err?.code === DUPLICATE_KEY) return false   // held, and not by us — the normal path
            logger.error(LOG, 'lease write failed:', err?.message ?? err)
            return false
        }
    }

    /** Apply a leadership transition exactly once, and never let a callback throw into the timer. */
    async function _settle(nextLeader) {
        if (nextLeader === leader) return
        leader = nextLeader
        try {
            if (leader) {
                logger.info(LOG, `${instanceId} IS the leader — starting background loops`)
                await onAcquired?.()
            } else {
                // THE case that keeps two leaders from coexisting. If renewal fails — a Mongo blip,
                // a long GC pause — the lease can expire and another process can legitimately take
                // it. This process must then stand its loops down, or for a while there are two
                // reconcilers, which is the exact failure the whole file exists to prevent.
                logger.error(LOG, `${instanceId} LOST the lease — stopping background loops`)
                await onLost?.()
            }
        } catch (err) {
            logger.error(LOG, 'leadership callback failed:', err?.message ?? err)
        }
    }

    return {
        /**
         * Claim leadership if it is free, then keep checking. A FOLLOWER keeps trying on the same
         * interval, so a leader that dies is replaced within roughly one TTL rather than leaving the
         * fleet stopped until someone notices.
         */
        async start() {
            if (timer) return
            await _settle(await tryAcquire())
            if (!leader) {
                logger.warn(LOG, `${instanceId} is a FOLLOWER — another instance holds the lease. `
                    + 'No background loops will run here. See docs/architecture/single-instance.md')
            }
            timer = setInterval(async () => {
                await _settle(await tryAcquire())
            }, renewMs)
            timer.unref?.()   // never the reason the process stays alive
        },

        /**
         * Stop renewing and hand the lease back, so a redeploy's replacement can take over at once
         * instead of waiting out the TTL. Guarded on `holder` — a process that already lost the
         * lease must not delete the new leader's.
         */
        async stop() {
            if (timer) { clearInterval(timer); timer = null }
            if (!leader) return
            leader = false
            try {
                const col = await getCollection()
                await col.deleteOne({ _id: key, holder: instanceId })
                logger.info(LOG, `${instanceId} released the lease`)
            } catch (err) {
                logger.warn(LOG, 'lease release failed (it will expire):', err?.message ?? err)
            }
        },

        isLeader: () => leader,

        /**
         * One renewal cycle — exactly what the interval runs. Exposed so the suite can drive a
         * leadership TRANSITION (the onLost path in particular) without waiting on a real timer;
         * a test that cannot reach that path is a test that does not cover the failure it names.
         */
        _tick: async () => { await _settle(await tryAcquire()) },
        _tryAcquire: tryAcquire,
    }
}
