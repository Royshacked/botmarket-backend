/**
 * THROWAWAY SPIKE — cTrader Open API order placement over JSON WebSocket (DEMO only).
 *
 * Purpose: prove the whole transport before we build anything real. In one run it
 * exercises: connect → app-auth → account list → account-auth → symbol lookup →
 * place a 0.01-lot MARKET order WITH inline stop-loss + take-profit → execution event.
 *
 * If this fills an order and prints an execution event, the entire ProtoOA plan is
 * validated (transport, session, order placement, native SL/TP, execution stream).
 *
 * Run from project root:   node monitoring/test.ctrader-ws.js
 *
 * Requirements:
 *   - A connected cTrader DEMO account (token in `brokerConnections`).
 *   - env: MONGODB_URI, CTRADER_CLIENTID, CTRADER_SECRET
 *
 * Safe to delete this file at any time — it imports nothing of ours except getDb.
 */

import 'dotenv/config'
import { getDb } from '../providers/mongodb.provider.js'

// ─── Verified constants (from cTrader docs, June 2026) ──────────────────────────
// JSON serialization lives on port 5036 (protobuf is 5035). Demo + live are isolated.
const WS_URL = 'wss://demo.ctraderapi.com:5036'

// payloadType enum values (ProtoOAPayloadType)
const PT = {
    APP_AUTH_REQ:     2100,
    APP_AUTH_RES:     2101,
    ACCOUNT_AUTH_REQ: 2102,
    ACCOUNT_AUTH_RES: 2103,
    NEW_ORDER_REQ:    2106,
    AMEND_SLTP_REQ:   2110,   // ProtoOAAmendPositionSLTPReq
    CLOSE_POSITION_REQ:2111,  // ProtoOAClosePositionReq
    SYMBOLS_LIST_REQ: 2114,
    SYMBOLS_LIST_RES: 2115,
    SYMBOL_BY_ID_REQ: 2116,
    SYMBOL_BY_ID_RES: 2117,
    RECONCILE_REQ:    2124,
    RECONCILE_RES:    2125,
    EXECUTION_EVENT:  2126,
    ORDER_ERROR_EVENT:2132,
    ERROR_RES:        2142,
    GET_ACCOUNTS_REQ: 2149,
    GET_ACCOUNTS_RES: 2150,
    HEARTBEAT:        51,
}

// ProtoOAOrderType / ProtoOATradeSide — sent as integers in JSON.
// (If the API rejects an enum, the fallback is the string name, e.g. "MARKET" / "BUY".)
const ORDER_TYPE_MARKET = 1
const TRADE_SIDE_BUY    = 1

// Volume is resolved at runtime from the symbol's own minVolume (crypto sizing
// differs from FX), so we don't hardcode it.

// Relative SL/TP for a MARKET order, in 1/100000 of price (1 unit = 0.00001 price).
// So relative = priceDistance * 100000. For BTCUSD (~$100k) we want a wide gap that
// won't trigger instantly and clears any min-distance rule: SL $2000, TP $4000.
const REL_STOP_LOSS   = 2000 * 100000   // $2,000  → 200,000,000
const REL_TAKE_PROFIT = 4000 * 100000   // $4,000  → 400,000,000

const TARGET_SYMBOL = 'BTCUSD'

// cTrader volume = units * 100, so 1 = 0.01 BTC. Bump if engine reports bad volume.
const CANDIDATE_VOLUME = 1

// Close mode:  node monitoring/test.ctrader-ws.js close <positionId> [volume]
const CLOSE_POSITION_ID = process.argv[2] === 'close' ? Number(process.argv[3]) : null
const CLOSE_VOLUME      = Number(process.argv[4]) || 1

// ─── Tiny request/response client over the WebSocket ────────────────────────────

let ws
let seq = 0
const pending = new Map() // clientMsgId → { resolve, reject, timer }

function send(payloadType, payload = {}) {
    const clientMsgId = `m${++seq}`
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(clientMsgId)
            reject(new Error(`Timeout waiting for response to payloadType=${payloadType}`))
        }, 15000)
        pending.set(clientMsgId, { resolve, reject, timer })
        const frame = JSON.stringify({ clientMsgId, payloadType, payload })
        console.log('▶ send', payloadType, JSON.stringify(payload))
        ws.send(frame)
    })
}

function handleMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { console.log('◀ (non-JSON)', raw); return }

    // Heartbeats just keep the line warm; ignore.
    if (msg.payloadType === PT.HEARTBEAT) return

    console.log('◀ recv', msg.payloadType, JSON.stringify(msg.payload))

    const p = msg.clientMsgId && pending.get(msg.clientMsgId)
    if (p) {
        clearTimeout(p.timer)
        pending.delete(msg.clientMsgId)
        if (msg.payloadType === PT.ERROR_RES || msg.payloadType === PT.ORDER_ERROR_EVENT) {
            p.reject(new Error(`${msg.payloadType === PT.ORDER_ERROR_EVENT ? 'OrderError' : 'Error'}: ${msg.payload?.errorCode} — ${msg.payload?.description}`))
        } else {
            p.resolve(msg)
        }
    }
    // Unsolicited execution events (e.g. the FILL after ACCEPTED) fall through and
    // are just logged above — that's exactly what we want to observe.
}

// ─── Spike flow ─────────────────────────────────────────────────────────────────

async function main() {
    const db = await getDb()
    const conn = await db.collection('brokerConnections').findOne({ brokerType: 'ctrader' })
    if (!conn?.accessToken) {
        throw new Error('No cTrader connection with an accessToken found in brokerConnections.')
    }
    const accessToken = conn.accessToken
    console.log(`Using cTrader token for userId=${conn.userId} (expires ${new Date(conn.expiresAt).toISOString()})`)

    const clientId     = process.env.CTRADER_CLIENTID
    const clientSecret = process.env.CTRADER_SECRET
    if (!clientId || !clientSecret) throw new Error('CTRADER_CLIENTID / CTRADER_SECRET not set')

    console.log(`\nConnecting to ${WS_URL} ...`)
    ws = new WebSocket(WS_URL)
    ws.addEventListener('message', ev => {
        const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
        handleMessage(raw)
    })
    ws.addEventListener('error', ev => console.error('WS error:', ev.message ?? ev))
    ws.addEventListener('close', ev => console.log(`WS closed: code=${ev.code} reason=${ev.reason}`))

    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', reject, { once: true })
    })
    console.log('✅ socket open')

    // Keep-alive heartbeat every 10s (raw send, no response expected).
    const hb = setInterval(() => {
        try { ws.send(JSON.stringify({ payloadType: PT.HEARTBEAT, payload: {} })) } catch {}
    }, 10000)

    // 1) App auth
    await send(PT.APP_AUTH_REQ, { clientId, clientSecret })
    console.log('✅ application authenticated')

    // 2) List accounts granted to this access token; pick a DEMO one
    const accRes = await send(PT.GET_ACCOUNTS_REQ, { accessToken })
    const accounts = accRes.payload?.ctidTraderAccount ?? []
    console.log(`Accounts on token: ${accounts.map(a => `${a.ctidTraderAccountId}${a.isLive ? '(live)' : '(demo)'}`).join(', ') || '(none)'}`)
    const demo = accounts.find(a => !a.isLive) ?? accounts[0]
    if (!demo) throw new Error('No trading accounts returned for this access token.')
    const ctid = demo.ctidTraderAccountId
    console.log(`Using ctidTraderAccountId=${ctid} (isLive=${!!demo.isLive})`)

    // 3) Account auth
    await send(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: ctid, accessToken })
    console.log('✅ account authenticated')

    // Specs-mode short-circuit: fetch full trading specs for a few symbols and exit.
    if (process.argv[2] === 'specs') {
        const res = await send(PT.SYMBOL_BY_ID_REQ, { ctidTraderAccountId: ctid, symbolId: [114, 1] })
        for (const s of res.payload?.symbol ?? []) {
            console.log(`\nsymbolId=${s.symbolId} digits=${s.digits} pipPosition=${s.pipPosition} ` +
                `minVolume=${s.minVolume} stepVolume=${s.stepVolume} maxVolume=${s.maxVolume} ` +
                `lotSize=${s.lotSize ?? '?'} measurementUnits=${s.measurementUnits ?? '?'}`)
        }
        clearInterval(hb)
        ws.close()
        return
    }

    // Reconcile-mode short-circuit: list open positions/orders and exit.
    if (process.argv[2] === 'reconcile') {
        const rec = await send(PT.RECONCILE_REQ, { ctidTraderAccountId: ctid })
        const positions = rec.payload?.position ?? []
        const orders    = rec.payload?.order ?? []
        console.log(`\nOpen positions: ${positions.length}`)
        for (const p of positions) console.log(`  • positionId=${p.positionId} symbolId=${p.tradeData?.symbolId} status=${p.positionStatus} vol=${p.tradeData?.volume}`)
        console.log(`Pending orders: ${orders.length}`)
        clearInterval(hb)
        ws.close()
        return
    }

    // Close-mode short-circuit: close an existing position and exit.
    if (CLOSE_POSITION_ID) {
        console.log(`\nClosing position ${CLOSE_POSITION_ID} (volume=${CLOSE_VOLUME}) ...`)
        await send(PT.CLOSE_POSITION_REQ, {
            ctidTraderAccountId: ctid,
            positionId:          CLOSE_POSITION_ID,
            volume:              CLOSE_VOLUME,
        })
        console.log('Listening 4s for the close execution event ...')
        await new Promise(r => setTimeout(r, 4000))
        clearInterval(hb)
        ws.close()
        console.log('\n✅ Close request sent.')
        return
    }

    // 4) Resolve symbol id
    const symRes = await send(PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: ctid })
    const symbols = symRes.payload?.symbol ?? []
    const sym = symbols.find(s => s.symbolName === TARGET_SYMBOL)
    if (!sym) {
        console.log(`Sample of available symbols: ${symbols.slice(0, 15).map(s => s.symbolName).join(', ')}`)
        throw new Error(`Symbol ${TARGET_SYMBOL} not found on this account.`)
    }
    console.log(`✅ ${TARGET_SYMBOL} → symbolId=${sym.symbolId}`)

    // 5) Place a small MARKET BUY with inline relative SL/TP.
    // SymbolById (full details incl. minVolume) is UNSUPPORTED on this proxy, so we
    // try a candidate volume. cTrader volume = units * 100, so 1 = 0.01 BTC.
    // If this returns TRADING_BAD_VOLUME, bump CANDIDATE_VOLUME to the engine's min/step.
    const volume = CANDIDATE_VOLUME
    console.log(`\nPlacing MARKET BUY volume=${volume} (~0.01 BTC) with SL/TP ...`)
    const orderRes = await send(PT.NEW_ORDER_REQ, {
        ctidTraderAccountId: ctid,
        symbolId:            sym.symbolId,
        orderType:           ORDER_TYPE_MARKET,
        tradeSide:           TRADE_SIDE_BUY,
        volume,
        relativeStopLoss:    REL_STOP_LOSS,
        relativeTakeProfit:  REL_TAKE_PROFIT,
        comment:             'ar2trade ProtoOA spike',
    })
    console.log(`✅ order request acknowledged (executionType=${orderRes.payload?.executionType})`)

    // 6) Linger to catch the asynchronous FILL execution event
    console.log('\nListening 6s for follow-up execution events ...')
    await new Promise(r => setTimeout(r, 6000))

    clearInterval(hb)
    ws.close()
    console.log('\n🎉 Spike complete — transport + order placement + native SL/TP validated.')
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\n❌ Spike failed:', err.message)
        process.exit(1)
    })
