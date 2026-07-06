/**
 * THROWAWAY — Phase 1 (Part A) cTrader trendbar feed check, via CTraderAdapter.getCandles (DEMO).
 *
 * Fetches OHLCV bars over the ProtoOA socket (ProtoOAGetTrendbarsReq 2137 → 2138) and
 * prints the last few bars so you can compare them to the platform chart. Read-only —
 * no orders. Run from project root:
 *
 *   node tests/test.ctrader-trendbars.js                    # US100 + BTCUSD, 5min/1hr/day
 *   node tests/test.ctrader-trendbars.js US100 EURUSD       # custom symbols
 *
 * What to check:
 *   • US100 returns bars at all (that's the whole point — the app feed can't serve it).
 *   • The last CLOSED bar's o/h/l/c ≈ the same bar on the cTrader chart for that TF.
 *   • Timestamps look like real recent bar times (ISO printed below).
 * If a request errors with an "unknown field"/param error, the API wants a from/to
 * window instead of count — tell me and I'll switch getTrendbars to that shape.
 * Safe to delete anytime.
 */

import 'dotenv/config'
import { getDb }          from '../providers/mongodb.provider.js'
import { CTraderAdapter } from '../api/broker/adapters/ctrader.adapter.js'

const SYMBOLS = process.argv.slice(2).length ? process.argv.slice(2) : ['US100', 'BTCUSD']
const TFS     = ['5min', '1hr', 'day']
const COUNT   = 5
const adapter = new CTraderAdapter()

const iso = t => new Date(t).toISOString().replace('.000Z', 'Z')

async function main() {
    const db   = await getDb()
    const conn = await db.collection('brokerConnections').findOne({ brokerType: 'ctrader' })
    if (!conn?.userId) throw new Error('No cTrader connection found in brokerConnections.')
    const userId = conn.userId

    const accts = await adapter.getTradingAccounts(userId)
    const demo  = accts.find(a => !a.isLive) ?? accts[0]
    if (!demo) throw new Error('No trading accounts on this connection.')
    console.log(`userId=${userId}  account=${demo.id} (login=${demo.login}, ${demo.isLive ? 'live' : 'demo'})\n`)

    for (const symbol of SYMBOLS) {
        for (const tf of TFS) {
            try {
                const t0   = Date.now()
                const bars = await adapter.getCandles(symbol, tf, COUNT, userId)
                if (!bars) { console.log(`⚠️  ${symbol.padEnd(8)} ${tf.padEnd(5)} → null (unsupported/failed)`); continue }
                console.log(`✅ ${symbol.padEnd(8)} ${tf.padEnd(5)} ${bars.length} bars (${Date.now() - t0}ms)`)
                for (const b of bars.slice(-3)) {
                    console.log(`     ${iso(b.t)}  O=${b.o}  H=${b.h}  L=${b.l}  C=${b.c}  V=${b.v}`)
                }
            } catch (err) {
                console.log(`❌ ${symbol.padEnd(8)} ${tf.padEnd(5)} ${err.message}`)
            }
        }
    }

    console.log('\n🎉 trendbar check complete.')
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error('\n❌ failed:', err.message); process.exit(1) })
