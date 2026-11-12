// Proteus build step 2 (docs/design/proteus.md): the measured profile on a sample of real names, BEFORE the desk is
// built around it — does anything hold out of sample, on which timeframes, how often is the answer "nothing".
// READ-ONLY: candles from the provider, no database. Usage: node scripts/proteus-sample.mjs [SYM ...] [--out file.json]
//
// Bars: 5-minute ~3 months (FMP serves ~9 sessions a call → paged by week), 1-hour ~1 year (paged by ~2 months),
// daily ~10 years (one call), weekly built from the daily (swingStructure.toWeekly; FMP serves no weekly bars).

import { writeFileSync } from 'node:fs'
import { getTickerAggregates } from '../providers/candles.provider.js'
import { behaviourProfile } from '../services/behaviourProfile.engine.js'
import { toWeekly } from '../services/swingStructure.service.js'

const DAY = 86_400_000
const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const outFile = outAt >= 0 ? args[outAt + 1] : null
const symbols = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1))
const SYMBOLS = symbols.length ? symbols : ['TSLA', 'NVDA', 'AAPL', 'AMD', 'PLTR', 'SMCI', 'JPM', 'XOM', 'KO', 'IONQ', 'SPY']

const _ms = (ts) => (ts < 1e12 ? ts * 1000 : ts)
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

/** Paged intraday bars, oldest → newest, de-duplicated by timestamp. */
async function paged(sym, timeSpan, multiplier, spanDays, pageDays) {
    const now = Date.now()
    const byTs = new Map()
    for (let to = now; to > now - spanDays * DAY; to -= pageDays * DAY) {
        const rows = await getTickerAggregates(sym, { timeSpan, multiplier, from: to - pageDays * DAY, to })
        for (const b of rows ?? []) byTs.set(b.timestamp, b)
    }
    return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp)
}

async function bars(sym) {
    const now = Date.now()
    const day = await getTickerAggregates(sym, { timeSpan: 'day', multiplier: 1, from: now - 10 * 365 * DAY, to: now })
    const week = toWeekly(day.map(b => ({ ...b, date: etDate.format(new Date(_ms(b.timestamp))) })))
        .map(b => ({ ...b, timestamp: Date.parse(`${b.date}T14:30:00Z`) / 1000 }))
    return {
        '5min': await paged(sym, 'minute', 5, 92, 7),
        '1hour': await paged(sym, 'hour', 1, 365, 60),
        day: day.slice(-1260),       // ~5 years: the daily view
        week,                        // ~10 years: 260 bars needs 5 at least
    }
}

const SHORT = { respects: 'RESPECTS', faded: 'faded', unconfirmed: 'unconf', no: '·', thin: 'thin' }
const cell = (s) => `${SHORT[s.verdict]}${s.n ? ` ${Math.round(s.rate * 100)}/${Math.round(s.base * 100)} n${s.n}` : ''}`

const results = []
for (const sym of SYMBOLS) {
    try {
        const b = await bars(sym)
        const p = behaviourProfile(sym, b)
        results.push(p)
        console.log(`\n${sym}  (bars: ${Object.entries(b).map(([k, v]) => `${k} ${v.length}`).join(', ')})`)
        for (const [tf, t] of Object.entries(p.timeframes)) {
            if (!t) { console.log(`  ${tf.padEnd(5)} too few bars`); continue }
            const tests = { ...t.indicators, sweep: t.false_breaks.after_sweep, ob: t.order_blocks }
            console.log(`  ${tf.padEnd(5)} ATR ${t.atr_pct}%  drift ${Math.round(t.drift.rate * 100)}%  false-break rate ${t.false_breaks.false_rate}  ` +
                Object.entries(tests).map(([k, s]) => `${k}: ${cell(s)}`).join(' | '))
        }
        console.log(`  F: day trade ${p.suitability.day_trade.fits ? 'yes' : 'no'} (${p.suitability.day_trade.why}${p.suitability.day_trade.edges.length ? `: ${p.suitability.day_trade.edges.join(', ')}` : ''}); ` +
            `swing ${p.suitability.swing.fits ? 'yes' : 'no'} (${p.suitability.swing.why}${p.suitability.swing.edges.length ? `: ${p.suitability.swing.edges.join(', ')}` : ''})`)
    } catch (err) {
        console.log(`\n${sym}: failed — ${err.message}`)
    }
}

// The tally: how often each verdict, per timeframe.
const tally = {}
for (const p of results) {
    for (const [tf, t] of Object.entries(p.timeframes)) {
        if (!t) continue
        for (const s of [...Object.values(t.indicators), t.false_breaks.after_sweep, t.order_blocks]) {
            tally[tf] ??= {}
            tally[tf][s.verdict] = (tally[tf][s.verdict] ?? 0) + 1
        }
    }
}
console.log('\nVerdicts per timeframe:', JSON.stringify(tally))
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2))
process.exit(0)
