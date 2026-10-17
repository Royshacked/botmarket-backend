// The entity a session reopens for editing, read through its OWN service — owner-checked where it has an
// owner (unified-chat plan phase 5b, the edit route). Coverage is house data with no owner; revising it is
// an admin's job, the same gate the coverage routes keep.

import { setupService } from '../../api/setups/setups.service.js'
import { scanService } from '../../api/scanner/scan.service.js'
import { coverageService } from '../../api/analyst/coverage.service.js'
import { portfolioChatService } from '../../api/portfolio/portfolioChat.service.js'
import { listPortfolios } from '../portfolioState.service.js'

const LOOKUPS = {
    setup:     ({ id, user }) => setupService.getSetup(id, user._id),
    scan:      ({ id, user }) => scanService.getScanById(id, user._id),
    coverage:  async ({ id, user }) => (user.role === 'admin' ? coverageService.getCoverageById(id) : { ok: false, reason: 'forbidden' }),
    // A book is its portfolio_books document — present only for its owner.
    portfolio: async ({ id, user }) => {
        const book = await portfolioChatService.getChatState(id, user._id)
        return book ? { ok: true, doc: { id, portfolioId: id, name: book.portfolioName ?? null } } : { ok: false, reason: 'not_found' }
    },
}

/** @returns {Promise<{ ok: true, doc: object } | { ok: false, reason: string }>} */
export async function lookupForEdit({ kind, id, user }, lookups = LOOKUPS) {
    const fn = lookups[kind]
    if (!fn || !id) return { ok: false, reason: 'not_editable' }
    const res = await fn({ id: String(id), user })
    return res?.ok ? res : { ok: false, reason: res?.reason ?? 'not_found' }
}

// ─── By a HANDLE, not just an id (plan phase 7, J4) ───────────────────────────
// Axl's <edit> names an item the way a person does — "the NVDA setup", "my Growth book" — so its ref is an id
// OR a name. The server's version of the client's resolveForEdit, with the same rule: a NAME answers only
// when it matches exactly one item; on two live NVDA setups a bare ticker is a coin flip, so ambiguity finds
// nothing. A scan is a list, not a name — id or nothing.
const BY_NAME = {
    setup: async ({ ref, user }) => {
        const rows = await setupService.listSetups(user._id)
        const hits = (Array.isArray(rows) ? rows : []).filter(s => String(s.asset ?? '').toUpperCase() === ref.toUpperCase())
        return hits.length === 1 ? hits[0].id : null
    },
    // One coverage per symbol by construction.
    coverage: async ({ ref, user }) => (user.role === 'admin' ? (await coverageService.getCoverageBySymbol(ref.toUpperCase()))?.id ?? null : null),
    portfolio: async ({ ref, user }) => {
        const hits = (await listPortfolios(user._id)).filter(b => String(b.name ?? '').toUpperCase() === ref.toUpperCase())
        return hits.length === 1 ? hits[0].portfolioId : null
    },
}

/** @returns {Promise<{ ok: true, doc: object, id: string } | { ok: false, reason: string }>} */
export async function findForEdit({ kind, ref, user }, { lookups = LOOKUPS, byName = BY_NAME } = {}) {
    if (!kind || !ref) return { ok: false, reason: 'not_editable' }
    const direct = await lookupForEdit({ kind, id: ref, user }, lookups)
    if (direct.ok) return { ...direct, id: String(ref) }
    const id = byName[kind] ? await byName[kind]({ ref: String(ref), user }) : null
    if (!id) return direct
    const named = await lookupForEdit({ kind, id, user }, lookups)
    return named.ok ? { ...named, id: String(id) } : named
}
