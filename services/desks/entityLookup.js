// The entity a session reopens for editing, read through its OWN service — owner-checked where it has an
// owner (unified-chat plan phase 5b, the edit route). Coverage is house data with no owner; revising it is
// an admin's job, the same gate the coverage routes keep.

import { setupService } from '../../api/setups/setups.service.js'
import { scanService } from '../../api/scanner/scan.service.js'
import { coverageService } from '../../api/analyst/coverage.service.js'
import { portfolioChatService } from '../../api/portfolio/portfolioChat.service.js'

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
