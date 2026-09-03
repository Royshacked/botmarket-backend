// Aether change stream — watches aether_opportunities and aether_predicted_signals for new
// inserts. When a document lands for a ticker that's in active coverage, schedules a re-model
// so the next coverage monitor tick triggers a Prometheus PT revision.
//
// Change streams require a replica set or Atlas — on a standalone mongod this is a no-op (the
// watch() call fails; the stream logs a warning and the app continues without it).

import { getDb }                from '../providers/mongodb.provider.js'
import { COLLECTIONS }          from '../api/aether/aether.model.js'
import { coverageService }      from '../api/analyst/coverage.service.js'
import { logger }               from '../services/logger.service.js'

const LOG = '[aetherChangeStream]'
const WATCHED = [COLLECTIONS.OPPORTUNITIES, COLLECTIONS.PREDICTED_SIGNALS]

export function startAetherChangeStream() {
    for (const col of WATCHED) _watchCollection(col)
}

async function _watchCollection(colName) {
    try {
        const db     = await getDb()
        const stream = db.collection(colName).watch(
            [{ $match: { operationType: 'insert' } }],
            { fullDocument: 'updateLookup' },
        )

        stream.on('change', async (event) => {
            const doc = event.fullDocument
            if (!doc?.ticker) return
            const scheduled = await coverageService.scheduleAetherRemodel(
                doc.ticker,
                colName === COLLECTIONS.OPPORTUNITIES ? 'confirmed opportunity' : 'provisional signal',
            )
            if (scheduled) {
                logger.info(LOG, `aether → coverage remodel scheduled: ${doc.ticker} (${colName})`)
            }
        })

        stream.on('error', (err) => {
            logger.warn(LOG, `change stream error on ${colName}:`, err.message)
        })

        logger.info(LOG, `watching ${colName} for new inserts`)
    } catch (err) {
        // Standalone mongod has no oplog — change streams are unavailable. This is not fatal.
        logger.warn(LOG, `could not open change stream for ${colName} (replica set required):`, err.message)
    }
}
