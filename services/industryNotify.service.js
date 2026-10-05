// Pythia's card: an industry answer CHANGED. Admin-only, like every house artifact's card — the views are
// the house layer, and only an admin can revise one. A review that reaffirms every grade posts nothing:
// a card per unchanged industry would be 163 cards a year saying "still the same".

import { cardActions } from '../api/chat/chat.service.js'
import { listAdminUserIds } from '../api/user/user.model.js'
import { postCard } from './notifyCard.js'
import { logger } from './logger.service.js'

const LOG = '[industryNotify]'

const _deps = {
    adminUserIds: ()          => listAdminUserIds(),
    post:         (card, ctx) => postCard(card, ctx),
}
export function _setDeps(d) { Object.assign(_deps, d) }

const LABEL = { demand: 'demand', economics: 'economics', cycle: 'cycle' }

/** The card for one admin. Pure → card or null when nothing changed. `changed` is revisionTrail.diffFields' shape. */
export function buildIndustryChanged(doc, changed, userId) {
    if (!userId || !doc?.code || !changed || !Object.keys(changed).length) return null
    const moves = Object.entries(changed)
        .map(([q, { from, to }]) => `${LABEL[q] ?? q} ${from ?? 'unanswered'} → ${to}`).join(', ')
    return {
        userId,
        content:    `${doc.name}: ${moves}.${doc.summary ? ` ${doc.summary}` : ''}`,
        type:       'industry_view',
        payload:    { kind: 'industry_view', code: doc.code, name: doc.name ?? null, industryViewId: doc.id ?? null, changed },
        botId:      'strategy',
        actions:    cardActions('Open industry'),
        visibility: 'admin',
    }
}

/** Post the card to every admin. Never throws. → number of cards posted. */
export async function notifyIndustryChanged(doc, changed, deps = _deps) {
    if (!buildIndustryChanged(doc, changed, '_')) return 0
    let userIds
    try {
        userIds = await deps.adminUserIds()
    } catch (err) {
        logger.warn(LOG, 'industry card not delivered — admin roster read failed', err.message)
        return 0
    }
    let posted = 0
    for (const userId of userIds ?? []) {
        if (await deps.post(buildIndustryChanged(doc, changed, userId), { tag: 'Industry card', log: LOG })) posted++
    }
    return posted
}
