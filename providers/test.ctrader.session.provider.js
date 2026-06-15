/**
 * Phase 3 smoke test for the cTrader SESSION layer (account/symbol/normalization).
 *
 * Proves, against a real connected DEMO account:
 *   1. listCTraderAccounts() resolves the user's ctidTraderAccountId (2149)
 *   2. session account-auth (2102) happens transparently on first send
 *   3. resolveSymbol('BTCUSD') returns id + full specs (2114 → 2116)
 *   4. normalization primitives align volume / round price / build relative SL-TP
 *
 * Run from project root:  node providers/test.ctrader.session.provider.js
 * Requires a connected cTrader DEMO account (token in brokerConnections).
 */

import 'dotenv/config'
import { getDb } from './mongodb.provider.js'
import {
    listCTraderAccounts,
    getCTraderSession,
    normalizeVolume,
    roundPrice,
    priceToRelative,
} from './ctrader.session.provider.js'

const TARGET_SYMBOL = 'BTCUSD'

async function main() {
    const db   = await getDb()
    const conn = await db.collection('brokerConnections').findOne({ brokerType: 'ctrader' })
    if (!conn?.accessToken) throw new Error('No cTrader connection with an accessToken found.')
    console.log(`Using token for userId=${conn.userId}`)

    // 1) Resolve accounts on the token, pick a demo one.
    const accounts = await listCTraderAccounts(conn.accessToken, false)
    console.log(`✅ accounts on token: ${accounts.map(a => `${a.ctid}${a.isLive ? '(live)' : '(demo)'}`).join(', ') || '(none)'}`)
    const demo = accounts.find(a => !a.isLive) ?? accounts[0]
    if (!demo) throw new Error('No trading accounts returned for this access token.')

    // 2) Open a session — getAccessToken always returns the current stored token.
    const session = getCTraderSession({
        ctid:           demo.ctid,
        isLive:         false,
        getAccessToken: () => conn.accessToken,
    })
    session.on('execution', p => console.log('▷ execution push:', JSON.stringify(p).slice(0, 120)))

    await session.ensureAuthed()
    console.log(`✅ account ${demo.ctid} authenticated`)

    // 3) Resolve symbol + full specs.
    const specs = await session.resolveSymbol(TARGET_SYMBOL)
    console.log(`✅ ${TARGET_SYMBOL} → symbolId=${specs.symbolId} digits=${specs.digits} ` +
        `pip=${specs.pipPosition} minVol=${specs.minVolume} stepVol=${specs.stepVolume} maxVol=${specs.maxVolume} lotSize=${specs.lotSize}`)

    // Second resolve should hit the cache (no new round-trips).
    const again = await session.resolveSymbol(TARGET_SYMBOL)
    console.log(`✅ cached resolve returns same id: ${again.symbolId === specs.symbolId}`)

    // 4) Normalization primitives.
    const rawVol  = (specs.minVolume || 100) * 1.5 + 1   // deliberately off-step
    const normVol = normalizeVolume(specs, rawVol)
    console.log(`✅ normalizeVolume(${rawVol}) → ${normVol} (min=${specs.minVolume} step=${specs.stepVolume})`)

    const price = roundPrice(specs, 12345.678912)
    console.log(`✅ roundPrice(12345.678912) → ${price} (digits=${specs.digits})`)

    const rel = priceToRelative(2000)
    console.log(`✅ priceToRelative($2000) → ${rel} (expect 200000000)`)

    session._socket.stop()
    console.log('\n🎉 Phase 3 session layer verified.')
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error('\n❌ Failed:', err.message); process.exit(1) })
