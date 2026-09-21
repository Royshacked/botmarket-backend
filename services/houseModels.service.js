// THE HOUSE MODELS — the one place the model everyone else runs on is chosen (2026-09-21).
//
// Until now the chat model was the user's own pick, sent by the client on every turn off
// localStorage, and the Talos model their own `hermesModel` preference. Roy is the developer and
// the only one weighing models against the ledger, so the pick is his for EVERY account, his own
// included: there is one selector, the admin's, and nobody has a per-user one any more — whatever
// a client still sends is not consulted. (The first cut kept the admin's own selectors next to
// the house's so a candidate could be trialled on one account first; Roy asked for that
// separation to go the same day — whatever he chooses is for everyone.)
//
// Two ids, one document: `chatModel` for every desk turn (and the house runs that have no user —
// the market brief, the coverage re-model), `talosModel` for every setup read. The
// stored ids are NOT validated on read: each consumer resolves through its own registry
// (resolveStreamFn → DEFAULT_MODEL, resolveTalosModel → ASSESS_MODEL), so a model removed from a
// registry degrades to that registry's default rather than failing every turn. They ARE validated
// on write, with the predicates the caller passes — this module imports neither registry, so it
// sits below both (assess.shared imports it) without a cycle.
//
// Read on every turn, so cached: one document, a minute of staleness after the admin saves is
// nothing next to a model change that takes effect at the next turn anyway.

import { getDb as _defaultGetDb } from '../providers/mongodb.provider.js'
import { httpError } from './httpError.util.js'
import { logger } from './logger.service.js'

export const COLLECTION = 'house_settings'
export const DOC_ID     = 'models'
const LOG    = '[houseModels]'
const TTL_MS = 60_000

let _cache = null // { value, at }

/** The stored house models — `{ chatModel, talosModel, updatedAt, updatedBy }`, each id possibly unset. */
export async function getHouseModels(getDb = _defaultGetDb) {
    if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.value
    const db  = await getDb()
    const doc = await db.collection(COLLECTION).findOne({ _id: DOC_ID })
    const value = {
        chatModel:  typeof doc?.chatModel  === 'string' ? doc.chatModel  : null,
        talosModel: typeof doc?.talosModel === 'string' ? doc.talosModel : null,
        updatedAt:  doc?.updatedAt ?? null,
        updatedBy:  doc?.updatedBy ?? null,
    }
    _cache = { value, at: Date.now() }
    return value
}

/**
 * Set one or both house models. `allowed` carries the two registries' predicates (the controller
 * passes them); an id that fails its predicate is a 400, and a body naming neither is a 400 too.
 * Returns the stored document, cache already refreshed.
 */
export async function setHouseModels({ chatModel, talosModel } = {}, by = null, { allowed = {}, getDb = _defaultGetDb } = {}) {
    const $set = {}
    if (chatModel !== undefined) {
        if (typeof chatModel !== 'string' || !allowed.chat?.(chatModel)) throw httpError(400, `chatModel is not a registered chat model: ${chatModel}`)
        $set.chatModel = chatModel
    }
    if (talosModel !== undefined) {
        if (typeof talosModel !== 'string' || !allowed.talos?.(talosModel)) throw httpError(400, `talosModel is not a registered Talos model: ${talosModel}`)
        $set.talosModel = talosModel
    }
    if (!Object.keys($set).length) throw httpError(400, 'nothing to set: pass chatModel and/or talosModel')
    $set.updatedAt = new Date()
    $set.updatedBy = by ? String(by) : null
    const db = await getDb()
    await db.collection(COLLECTION).updateOne({ _id: DOC_ID }, { $set }, { upsert: true })
    logger.info(LOG, 'house models set', { ...$set })
    _cache = null
    return getHouseModels(getDb)
}

/** Drop the read cache (tests; a process that must see a save at once). */
export function _resetHouseModelsCache() { _cache = null }
