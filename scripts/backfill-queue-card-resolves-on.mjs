// Re-stamp the market-open nudge as a card that CLOSES WHEN OPENED. Idempotent; run once:
//
//   node scripts/backfill-queue-card-resolves-on.mjs
//
// WHY A BACKFILL AND NOT JUST THE PRODUCER. The resolution policy is stamped onto the message at
// POST time (chat.service cardActions → the stored `actions.primary.resolvesOn`), and the client
// reads it off the message it is rendering. Fixing `buildQueueReady` therefore fixes every FUTURE
// open and nothing already in a user's chat: the cards sitting there now still say 'work'.
//
// For `queue_ready` that is not merely stale, it is unresolvable. A work card is closed by the
// user's write landing on the entity it names (resolveCardsFor) — and this card names no entity: it
// points at a BATCH, so it carries no `subject` for any write to match. Left as 'work' those cards
// can only ever be dismissed, and until then each one keeps restating a count ("2 items waiting")
// that went stale the moment the first item was executed.
//
// Only PENDING cards are touched. A card the user already dismissed is settled, and re-stamping a
// settled card would rewrite history to claim a policy it was never resolved under.

import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'
import { logger } from '../services/logger.service.js'
import { MSGS } from '../api/chat/chat.service.js'

const LOG = '[backfill:queue-card]'

async function run() {
    const db = await getDb()

    const res = await db.collection(MSGS).updateMany(
        { type: 'queue_ready', status: 'pending', 'actions.primary.resolvesOn': { $ne: 'open' } },
        { $set: { 'actions.primary.resolvesOn': 'open' } },
    )

    const left = await db.collection(MSGS).countDocuments({ type: 'queue_ready', status: 'pending' })
    logger.info(LOG, `re-stamped ${res.modifiedCount} pending queue_ready card(s) — ${left} still open, each now closable by opening the list`)
}

run()
    .then(() => process.exit(0))
    .catch(err => { logger.error(LOG, 'Backfill failed:', err); process.exit(1) })
