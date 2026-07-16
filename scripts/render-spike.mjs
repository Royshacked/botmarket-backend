/**
 * Phase 0/1 spike — prove renderChartImage(symbol, timeframe, studies) draws the translated
 * indicators via the headless klinecharts renderer. Writes PNGs to scripts/.render-<tag>.png.
 * Usage: node scripts/render-spike.mjs [SYMBOL] [interval]
 */
import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStudies } from '../monitoring/evaluators/chart.evaluator.js'
import { renderChartImage, closeRenderer } from '../services/chartRender/klineRender.provider.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const symbol   = (process.argv[2] || 'AAPL').toUpperCase()
const interval = process.argv[3] || 'day'

// condition string → studies via the real _buildStudies (plain, no fillDefaults)
const CASES = [
    ['plain',    ''],
    ['ema-sma',  'ema(20), sma(50)'],
    ['rsi',      'rsi(14)'],
    ['macd',     'macd'],
    ['bollinger','bollinger bands'],
    ['vwap',     'vwap'],
    ['atr',      'atr(14)'],
    ['combo',    'ema(20), rsi(14), volume'],
]

async function main() {
    for (const [tag, cond] of CASES) {
        const studies = buildStudies(cond, { fillDefaults: false })
        const t0 = Date.now()
        try {
            const b64 = await renderChartImage(symbol, interval, studies)
            const out = join(__dirname, `.render-${tag}.png`)
            writeFileSync(out, Buffer.from(b64, 'base64'))
            console.log(`✓ ${tag.padEnd(10)} studies=[${studies.map(s => s.name).join(', ')}]  ${Date.now() - t0}ms  ${out}`)
        } catch (e) {
            console.log(`✗ ${tag.padEnd(10)} FAILED: ${e.message}`)
        }
    }
    await closeRenderer()
}

main().catch(async (e) => { console.error('SPIKE FAILED:', e); await closeRenderer(); process.exit(1) })
