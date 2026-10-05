// The database the AETHER ENGINE works in — one answer for every reader.
//
// The engine writes the house's research data (industry_metrics, gics_companies, the cost of capital,
// the statements) into ONE database: the house one when AETHER_DB is set (a laptop on its own dev
// database still runs the engine against the shared data), else the one Node is on. On Render the two
// are the same. The scheduler that spawns the engine and the desks that read what it wrote must agree on
// which database that is, so the rule lives here once rather than in each of them.

import { getDbName, getSiblingDb } from '../providers/mongodb.provider.js'
import { config } from './config.js'

/** The engine's database name. */
export function engineDbName() {
    return config.aetherDb ?? getDbName()
}

/** A handle on the engine's database, over the one connected client. */
export function getEngineDb() {
    return getSiblingDb(engineDbName())
}
