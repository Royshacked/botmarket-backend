// Proteus build step 2 (docs/design/proteus.md): the measured profile on a sample of real names, BEFORE the desk is
// built around it — does anything hold out of sample, on which timeframes, how often is the answer "nothing".
// READ-ONLY: candles from the provider, no database. Usage: node scripts/proteus-sample.mjs [SYM ...] [--out file.json]
//
// Bars: behaviourProfile.service fetchProfileBars — the same fetch the live profile uses. Computes fresh, stores nothing.

import { writeFileSync } from 'node:fs'
import { behaviourProfile } from '../services/behaviourProfile.engine.js'
import { fetchProfileBars } from '../services/behaviourProfile.service.js'

const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const outFile = outAt >= 0 ? args[outAt + 1] : null
const symbols = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1))
const SYMBOLS = symbols.length ? symbols : ['TSLA', 'NVDA', 'AAPL', 'AMD', 'PLTR', 'SMCI', 'JPM', 'XOM', 'KO', 'IONQ', 'SPY']
const bars = (sym) => fetchProfileBars(sym)

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
