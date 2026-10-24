// Replay the Hotlist's THIS WEEK grades over past sessions (services/hotlistBacktest.service.js; Roy, 2026-10-24:
// "can't we score retrospectively?") and store the summary the Hotlist shows as the week's backtest.
//
//   node scripts/replay-hotlist-week.mjs [sessions]     (default 125 — about six months)
//
// ~1,200 daily-bars reads, paced at DAILY_SCREENER_RPM — run it off-session. Reads the screener's universe from
// daily_screener_stats in the database DB_NAME names.
import dns from 'dns'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const sessions = Number(process.argv[2]) || undefined
const { replayWeek } = await import('../services/hotlistBacktest.service.js')
const { closeDb } = await import('../providers/mongodb.provider.js')
const t0 = Date.now()
const r = await replayWeek({ sessions, onProgress: (k, n) => console.log(`  ${k} / ${n} names (${((Date.now() - t0) / 60000).toFixed(1)} min)`) })
console.log(JSON.stringify({ outcome: r.outcome, from: r.from, to: r.to, sessions: r.sessions, universe: r.universe, read: r.read, failed: r.failed, stopped: r.stopped }, null, 1))
if (r.summary) console.log(JSON.stringify(r.summary, null, 1))
await closeDb()
process.exit(r.ok === false && r.outcome !== 'partial' ? 1 : 0)
