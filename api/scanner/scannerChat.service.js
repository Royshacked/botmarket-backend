// Persistence for the scanner conversation. Unlike portfolio chats (keyed per
// portfolio), the scanner is a single running conversation per user, so chat
// state is keyed by userId alone.

import { getDb, stripId }   from '../../providers/mongodb.provider.js'
import { logger }  from '../../services/logger.service.js'

const LOG        = '[scannerChat]'
const COLLECTION = 'scanner_chats'

export const scannerChatService = { saveChatState, getChatState, deleteChatState }

async function saveChatState(userId, messages) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).findOneAndUpdate(
            { userId },
            { $set: { userId, messages, savedAt: Date.now() } },
            { upsert: true }
        )
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to save chat state', err)
        return { ok: false }
    }
}

async function getChatState(userId) {
    try {
        const db  = await getDb()
        const doc = await db.collection(COLLECTION).findOne({ userId })
        if (!doc) return null
        return stripId(doc)
    } catch (err) {
        logger.error(LOG, 'Failed to get chat state', err)
        return null
    }
}

async function deleteChatState(userId) {
    try {
        const db = await getDb()
        await db.collection(COLLECTION).deleteOne({ userId })
        return { ok: true }
    } catch (err) {
        logger.error(LOG, 'Failed to delete chat state', err)
        return { ok: false }
    }
}
