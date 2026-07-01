/**
 * Phase 2 smoke test for the CTraderSocket transport provider.
 *
 * Proves the wrapper (not the raw message layer — the spike already did that):
 *   1. getCTraderSocket().ready resolves  → connect + app-auth happen inside the provider
 *   2. send() round-trips a real request   → GetAccountListByAccessToken (2149→2150)
 *   3. the 'execution'/'push' event seam is wired
 *
 * Run from project root:  node providers/test.ctrader.ws.provider.js
 * Requires a connected cTrader DEMO account (token in brokerConnections).
 */

import 'dotenv/config'
import { getDb }             from '../providers/mongodb.provider.js'
import { getCTraderSocket }  from '../providers/ctrader.ws.provider.js'

const GET_ACCOUNTS_REQ = 2149

async function main() {
    const db   = await getDb()
    const conn = await db.collection('brokerConnections').findOne({ brokerType: 'ctrader' })
    if (!conn?.accessToken) throw new Error('No cTrader connection with an accessToken found.')

    const sock = getCTraderSocket(false)   // demo
    sock.on('execution', p => console.log('▷ execution push:', JSON.stringify(p).slice(0, 120)))
    sock.on('push',      m => console.log('▷ other push:', m.payloadType))

    console.log('Awaiting socket.ready (connect + app-auth inside provider) ...')
    await sock.ready
    console.log('✅ ready resolved')

    const res = await sock.send(GET_ACCOUNTS_REQ, { accessToken: conn.accessToken })
    const accounts = res?.ctidTraderAccount ?? []
    console.log(`✅ round-trip ok — ${accounts.length} account(s): ` +
        accounts.map(a => `${a.ctidTraderAccountId}${a.isLive ? '(live)' : '(demo)'}`).join(', '))

    sock.stop()
    console.log('\n🎉 Phase 2 transport provider verified.')
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error('\n❌ Failed:', err.message); process.exit(1) })
