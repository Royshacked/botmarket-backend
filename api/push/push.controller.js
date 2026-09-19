import { makeHandle } from '../_shared/handle.util.js'
import { isEnabled, publicKey, addSubscription, removeSubscription, listSubscriptions } from '../../services/push.service.js'

// The device side of web push: a browser hands over the subscription its push service minted,
// and takes it back when the user turns alerts off. Everything is the signed-in user's own —
// there is no admin view of someone else's devices.

const LOG    = '[push:controller]'
const handle = makeHandle(LOG)

/** Whether push is on at all, and the public VAPID key the browser subscribes with. */
export const getConfig = handle('getConfig', async (req, res) => {
    res.json({ enabled: isEnabled(), publicKey: isEnabled() ? publicKey() : null })
})

export const list = handle('list', async (req, res) => {
    res.json(await listSubscriptions(req.user._id))
})

export const subscribe = handle('subscribe', async (req, res) => {
    const count = await addSubscription(req.user._id, req.body?.subscription, { ua: req.get('user-agent') })
    res.status(201).json({ count })
})

export const unsubscribe = handle('unsubscribe', async (req, res) => {
    const removed = await removeSubscription(req.user._id, req.body?.endpoint)
    res.json({ removed })
})
