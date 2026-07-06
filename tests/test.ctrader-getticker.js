/**
 * THROWAWAY — Phase 2 getTicker check: CTraderAdapter.resolveSymbol (DEMO).
 *
 * Replicates saveIdea's two-step resolution for each canonical asset:
 *   asset → (static alias map) → broker base → (broker getTicker) → broker's real name
 *   e.g.  NQ → US100 → US100.cash (found:true)
 * Read-only. Run from project root:
 *
 *   node tests/test.ctrader-getticker.js
 *   node tests/test.ctrader-getticker.js NQ ES EURUSD ZZZZ
 *
 * Expect: NQ/ES resolve to US100.cash/US500.cash (found:true); EURUSD/BTCUSD to their
 * own names (found:true); a bogus symbol → found:false (NOT a thrown transport error).
 * Safe to delete anytime.
 */

import 'dotenv/config'
import { getDb }          from '../providers/mongodb.provider.js'
import { CTraderAdapter } from '../api/broker/adapters/ctrader.adapter.js'
import { toBrokerSymbol } from '../services/brokerSymbol.service.js'

const ASSETS  = process.argv.slice(2).length ? process.argv.slice(2) : ['NQ', 'ES', 'EURUSD', 'BTCUSD', 'ZZZZ']
const adapter = new CTraderAdapter()

async function main() {
    const db   = await getDb()
    const conn = await db.collection('brokerConnections').findOne({ brokerType: 'ctrader' })
    if (!conn?.userId) throw new Error('No cTrader connection found in brokerConnections.')
    const userId = conn.userId

    const accts = await adapter.getTradingAccounts(userId)
    const demo  = accts.find(a => !a.isLive) ?? accts[0]
    if (!demo) throw new Error('No trading accounts on this connection.')
    console.log(`userId=${userId}  account=${demo.id} (${demo.isLive ? 'live' : 'demo'})\n`)

    for (const asset of ASSETS) {
        const mapped = toBrokerSymbol('ctrader', asset)   // static map: NQ→US100, identity otherwise
        try {
            const res = await adapter.resolveSymbol(userId, demo.id, mapped)
            const mark = res.found ? '✅' : '⚠️ '
            console.log(`${mark} ${asset.padEnd(7)} → ${mapped.padEnd(7)} → ${String(res.symbol).padEnd(12)} found=${res.found}`)
        } catch (err) {
            console.log(`❌ ${asset.padEnd(7)} → ${mapped.padEnd(7)} threw: ${err.message}`)
        }
    }

    console.log('\n🎉 getTicker check complete.')
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error('\n❌ failed:', err.message); process.exit(1) })
