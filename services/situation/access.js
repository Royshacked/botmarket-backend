// WHO MAY SEE THE SITUATION NETWORK (docs/design/situation-network.md §11.6; plan step 0).
//
// During the forward test only Roy and Marce see it: Axl's tool, the board, the diagrams. Everyone else gets nothing,
// not even a mention. Marce is a trader, so this is an allow-list of user ids (SITUATION_USERS), never the admin role.
// The ONE gate: the route, the Axl tool and the board all ask here.

import { config } from '../config.js'

/** May this user (an id, or a user object with `id` / `_id`) see the situation network? Unset list → nobody. */
export function canSeeSituation(user, _users = () => config.situationUsers) {
    const id = typeof user === 'object' && user !== null ? (user.id ?? user._id) : user
    if (id === undefined || id === null || id === '') return false
    return _users().includes(String(id))
}
