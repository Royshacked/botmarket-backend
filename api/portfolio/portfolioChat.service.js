import { getDb }    from '../../providers/mongodb.provider.js'
import { logger }  from '../../services/logger.service.js'

const LOG        = '[portfolioChat]'
const COLLECTION = 'portfolio_chats'

export const portfolioChatService = { saveChatState, getChatState, deleteChatState }

async function saveChatState(portfolioId, messages, userId) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).findOneAndUpdate(
            { portfolioId, userId },
            { $set: { portfolioId, messages, userId, savedAt: Date.now() } },
            { upsert: true }
        )
        logger.info(LOG, 'Chat state saved', { portfolioId })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to save chat state', err)
        return { ok: false }
    }
}

async function deleteChatState(portfolioId, userId) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).deleteOne({ portfolioId, userId })
        logger.info(LOG, 'Chat state deleted', { portfolioId })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to delete chat state', err)
        return { ok: false }
    }
}

async function getChatState(portfolioId, userId) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne({ portfolioId, userId })
        if (!doc) return null
        const { _id, ...rest } = doc
        return rest
    } catch (err) {
        logger.error(LOG, 'Failed to get chat state', err)
        return null
    }
}
