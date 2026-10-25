// Replay the Hotlist's DAY columns (open · mid · eod · tomorrow) over past sessions (services/hotlistBacktest.day.js;
// Roy, 2026-10-24: "replay the day columns") and store one summary per column — what each column's list shows as its
// backtest.
//
//   node scripts/replay-hotlist-day.mjs [sessions] [limit]     (default 60 — about three months; `limit`: a smoke run
//                                                              over the first names, printed and not stored)
//
// A daily read per name, plus 5-minute reads for the sessions it passed a day column's gates and pre-market reads on its
// gap days — a few thousand reads, paced at DAILY_SCREENER_RPM. Run it off-session.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const sessions = Number(process.argv[2]) || undefined
const limit = Number(process.argv[3]) || null
const { replayDays } = await import('../services/hotlistBacktest.day.js')
const { closeDb } = await import('../../providers/mongodb.provider.js')
const t0 = Date.now()
const r = await replayDays({ sessions, limit, onProgress: (k, n, reads) => console.log(`  ${k} / ${n} names, ${reads} reads (${((Date.now() - t0) / 60000).toFixed(1)} min)`) })
console.log(JSON.stringify({ outcome: r.outcome, from: r.from, to: r.to, sessions: r.sessions, universe: r.universe, read: r.read, failed: r.failed, stopped: r.stopped, reads: r.reads }, null, 1))
if (r.summary) console.log(JSON.stringify(r.summary, null, 1))
await closeDb()
process.exit(r.ok === false && r.outcome !== 'partial' ? 1 : 0)
