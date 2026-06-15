/**
 * THROWAWAY — Phase 6 end-to-end check, driven through CTraderAdapter (DEMO only).
 *
 * Exercises the three Phase 6 paths the raw spike (test.ctrader-ws.js) doesn't:
 *   • REST trading-account id → ctid mapping (_session / _matchAccount)
 *   • lot → cTrader volume conversion (lotsToVolume in placeOrder)
 *   • absolute SL/TP prices → relative native SL/TP (priceToRelative in placeOrder)
 *
 * Modes (run from project root):
 *   node monitoring/test.ctrader-phase6.js probe                 # read-only: accounts, ctid, ref price, open positions
 *   node monitoring/test.ctrader-phase6.js place [lots] [ref]    # place tiny market BUY w/ native SL/TP, verify, then CLOSE
 *
 * Safe to delete anytime. `place` cleans up after itself (closes what it opened).
 */

import 'dotenv/config'
import { getDb }                 from '../providers/mongodb.provider.js'
import { CTraderAdapter }        from '../api/broker/adapters/ctrader.adapter.js'
import { currentReferencePrice } from '../services/protectionPlan.service.js'

const MODE    = process.argv[2] ?? 'probe'
const LOTS    = Number(process.argv[3]) || 0.01
const REF_ARG = Number(process.argv[4]) || null
const SYMBOL  = 'BTCUSD'
const RECONCILE = 2124

// Native SL/TP on a market order is sent as a DISTANCE applied to the actual fill,
// so the reference only needs to be in the right ballpark for the gap to be valid.
const FALLBACK_REF = 100000   // BTCUSD ~level; used only if no live/arg price

const adapter = new CTraderAdapter()
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function refPrice() {
    if (REF_ARG) return REF_ARG
    const p = await currentReferencePrice(SYMBOL, 'day')
    return Number.isFinite(p) ? p : null
}

async function openPositionsViaReconcile(userId, accountId) {
    const session = await adapter._session(userId, accountId)
    const rec = await session.send(RECONCILE, {})
    return { session, positions: rec?.position ?? [] }
}

async function main() {
    const db   = await getDb()
    const conn = await db.collection('brokerConnections').findOne({ brokerType: 'ctrader' })
    if (!conn?.userId) throw new Error('No cTrader connection found in brokerConnections.')
    const userId = conn.userId
    console.log(`userId=${userId}`)

    // REST trading accounts — the id ideas persist (NOT the ctid). Pick a demo one.
    const accts = await adapter.getTradingAccounts(userId)
    console.log('REST accounts:')
    for (const a of accts) console.log(`  • id=${a.id} login=${a.login} live=${a.isLive} bal=${a.balance}`)
    const demo  = accts.find(a => !a.isLive) ?? accts[0]
    if (!demo) throw new Error('No trading accounts on this connection.')
    const restId = demo.id
    console.log(`Using REST accountId=${restId} (login=${demo.login})`)

    // Resolve the session via the REST id — exercises _matchAccount's REST→ctid map.
    const session = await adapter._session(userId, restId)
    console.log(`✅ _session resolved REST id ${restId} → ctid=${session.ctid} env=${session.env}`)

    const specs = await session.resolveSymbol(SYMBOL)
    console.log(`✅ ${SYMBOL} specs: symbolId=${specs.symbolId} digits=${specs.digits} lotSize=${specs.lotSize} min/step/max=${specs.minVolume}/${specs.stepVolume}/${specs.maxVolume}`)

    const ref = await refPrice()
    console.log(`reference price (${SYMBOL}) = ${ref ?? '(unavailable)'}`)

    const { positions } = await openPositionsViaReconcile(userId, restId)
    console.log(`Open positions: ${positions.length}`)
    for (const p of positions) console.log(`  • positionId=${p.positionId} symbolId=${p.tradeData?.symbolId} vol=${p.tradeData?.volume} SL=${p.stopLoss ?? '·'} TP=${p.takeProfit ?? '·'}`)

    if (MODE === 'probe') {
        console.log('\n🔎 probe complete (read-only).')
        return
    }

    if (MODE !== 'place') throw new Error(`unknown mode '${MODE}' (use probe | place)`)
    const useRef = ref ?? FALLBACK_REF
    if (ref == null) console.log(`(no live ref price — using fallback ${FALLBACK_REF}; SL/TP are distances applied to the real fill)`)

    // Wide SL/TP so they will not trigger during the test; correct sides for a long.
    const stopLoss   = Math.round((useRef - 3000) * 100) / 100
    const takeProfit = Math.round((useRef + 5000) * 100) / 100
    console.log(`\nPlacing MARKET BUY ${LOTS} lot ${SYMBOL}  SL=${stopLoss} TP=${takeProfit} (ref=${useRef}) ...`)

    const res = await adapter.placeOrder(userId, restId, {
        symbol: SYMBOL, direction: 'long', quantity: LOTS, type: 'market',
        stopLoss, takeProfit, referencePrice: useRef,
    })
    console.log('✅ placeOrder →', JSON.stringify(res))

    // Let the fill settle, then reconcile and confirm SL/TP landed near our absolute prices.
    await sleep(4000)
    const { positions: after } = await openPositionsViaReconcile(userId, restId)
    const pos = after.find(p => String(p.positionId) === String(res.positionId))
    if (pos) {
        const expectedLots = `${LOTS} lot → expected vol≈${LOTS * (specs.lotSize ?? 1)}`
        console.log(`✅ position ${pos.positionId}: vol=${pos.tradeData?.volume} (${expectedLots}) SL=${pos.stopLoss} TP=${pos.takeProfit}`)
    } else {
        console.log(`⚠️  position ${res.positionId} not found in reconcile (may be a pure order id without fill yet)`)
    }

    // Cleanup — close whatever we opened so the demo account is left flat.
    if (res.positionId) {
        console.log(`\nCleaning up — closing position ${res.positionId} ...`)
        await adapter.closePosition(userId, restId, res.positionId)
        await sleep(2500)
        const { positions: final } = await openPositionsViaReconcile(userId, restId)
        const still = final.some(p => String(p.positionId) === String(res.positionId))
        console.log(still ? `⚠️  position ${res.positionId} still open — close manually` : `✅ position ${res.positionId} closed — account flat`)
    }

    console.log('\n🎉 Phase 6 place/verify/close complete.')
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error('\n❌ failed:', err.message); process.exit(1) })
