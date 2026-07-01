/**
 * THROWAWAY — Task 4 spot-quote snapshot check, via CTraderAdapter.getSpot (DEMO).
 *
 * Subscribes (2127), captures the first ProtoOASpotEvent (2131), unsubscribes (2129)
 * and prints the live bid/ask/mid. Read-only — no orders. Run from project root:
 *
 *   node monitoring/test.ctrader-spot.js                 # BTCUSD + US100
 *   node monitoring/test.ctrader-spot.js US100 BTCUSD EURUSD
 *
 * US100 is the point of the exercise: compare its mid here against the canonical
 * Massive/Yahoo NQ price — that difference is the basis offset Task 5 will apply.
 * Safe to delete anytime.
 */

import 'dotenv/config'
import { getDb }          from '../providers/mongodb.provider.js'
import { CTraderAdapter } from '../api/broker/adapters/ctrader.adapter.js'

const SYMBOLS = process.argv.slice(2).length ? process.argv.slice(2) : ['BTCUSD', 'US100']
const adapter = new CTraderAdapter()

async function main() {
    const db   = await getDb()
    const conn = await db.collection('brokerConnections').findOne({ brokerType: 'ctrader' })
    if (!conn?.userId) throw new Error('No cTrader connection found in brokerConnections.')
    const userId = conn.userId

    const accts = await adapter.getTradingAccounts(userId)
    const demo  = accts.find(a => !a.isLive) ?? accts[0]
    if (!demo) throw new Error('No trading accounts on this connection.')
    console.log(`userId=${userId}  REST accountId=${demo.id} (login=${demo.login}, ${demo.isLive ? 'live' : 'demo'})`)

    for (const symbol of SYMBOLS) {
        try {
            const t0    = Date.now()
            const quote = await adapter.getSpot(userId, demo.id, symbol)
            console.log(`✅ ${symbol.padEnd(8)} bid=${quote.bid} ask=${quote.ask} mid=${quote.mid} (digits=${quote.digits}, ${Date.now() - t0}ms)`)
        } catch (err) {
            console.log(`❌ ${symbol.padEnd(8)} ${err.message}`)
        }
    }

    // Prove the in-flight dedup: two concurrent snapshots of one symbol share a sub.
    const [a, b] = await Promise.all([
        adapter.getSpot(userId, demo.id, SYMBOLS[0]),
        adapter.getSpot(userId, demo.id, SYMBOLS[0]),
    ])
    console.log(`dedup: concurrent ${SYMBOLS[0]} mids ${a.mid} / ${b.mid}`)

    console.log('\n🎉 spot snapshot check complete.')
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error('\n❌ failed:', err.message); process.exit(1) })
