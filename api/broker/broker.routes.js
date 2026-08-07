/**
 * Broker Routes — the route table only; handlers live in broker.controller.js.
 *
 * All data routes require authentication (requireAuth). The OAuth callback is the ONE
 * unauthenticated route: the browser arrives from the broker's domain, so there is no session to
 * read and user identity is recovered from the JWT-signed `state` param instead.
 *
 * ORDERING MATTERS. `/:type/...` is a wildcard, so the literal `/connections` and `/callback` paths
 * are declared before it — otherwise `connections` would bind as a broker type.
 *
 * Route map:
 *   GET    /api/broker/connect/:type            start OAuth for broker
 *   GET    /api/broker/callback                 OAuth callback (all brokers, UNAUTHENTICATED)
 *   GET    /api/broker/connections              list the user's connected brokers
 *   DEL    /api/broker/connections/:type        disconnect a broker
 *   PATCH  /api/broker/connections/:type/account  set the selected trading account
 *   GET    /api/broker/:type/trading-accounts   the broker's trading accounts + which is selected
 *   GET    /api/broker/:type/capabilities       what the broker can do (trading, native SL/TP, …)
 *   GET    /api/broker/:type/account            account summary
 *   GET    /api/broker/:type/positions          open positions (asset-class + callId enriched)
 *   DEL    /api/broker/:type/positions/:id      close an open position (full close)
 *   GET    /api/broker/:type/orders             working (pending) orders
 *   POST   /api/broker/:type/orders             place a working order
 *   PATCH  /api/broker/:type/orders/:orderId    re-price a working order
 *   DEL    /api/broker/:type/orders/:orderId    cancel a working order
 */

import { Router }      from 'express'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    connect, callback, listConnections, disconnect,
    listTradingAccounts, setSelectedAccount, capabilities,
    getAccount, getPositions, closePosition,
    listOrders, placeOrder, amendOrder, cancelOrder,
} from './broker.controller.js'

export const brokerRoutes = Router()

// OAuth. `connect` needs the session (it signs the user into `state`); `callback` cannot have one.
brokerRoutes.get('/connect/:type', requireAuth, connect)
brokerRoutes.get('/callback', callback)

// Everything below is the authenticated data surface.
brokerRoutes.use(requireAuth)

brokerRoutes.get   ('/connections', listConnections)
brokerRoutes.delete('/connections/:type', disconnect)
brokerRoutes.patch ('/connections/:type/account', setSelectedAccount)

brokerRoutes.get   ('/:type/trading-accounts', listTradingAccounts)
brokerRoutes.get   ('/:type/capabilities', capabilities)
brokerRoutes.get   ('/:type/account', getAccount)

brokerRoutes.get   ('/:type/positions', getPositions)
brokerRoutes.delete('/:type/positions/:positionId', closePosition)

brokerRoutes.get   ('/:type/orders', listOrders)
brokerRoutes.post  ('/:type/orders', placeOrder)
brokerRoutes.patch ('/:type/orders/:orderId', amendOrder)
brokerRoutes.delete('/:type/orders/:orderId', cancelOrder)
