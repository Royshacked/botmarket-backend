export const COLLECTION = 'users'

/**
 * Strip sensitive and internal fields before sending to client.
 * Removes MongoDB's _id and the passwordHash.
 */
export function stripUser(doc) {
    if (!doc) return doc
    const { _id, passwordHash, ...rest } = doc
    return rest
}
