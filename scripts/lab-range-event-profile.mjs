// WHO ARE THE 30%+ RANGES — the traits of each range-width group (data/lab/range-event.rows.csv, lab-range-event.mjs).
// Descriptive. Every trait is known on the scan day except `beatThis` (the report itself).
//   node scripts/lab-range-event-profile.mjs → data/lab/range-event-profile.out.txt
import fs from 'fs'

const [head, ...lines] = fs.readFileSync('data/lab/range-event.rows.csv', 'utf8').trim().split('\n')
const cols = head.split(',')
const rows = lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v === '' ? null : isNaN(+v) ? v : +v])))
const med = (xs) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const share = (xs, p) => { const v = xs.filter(x => x != null); return v.length ? (v.filter(p).length / v.length) * 100 : null }
const f = (x, d = 1, suf = '') => (x == null ? '—' : x.toFixed(d) + suf)
const out = [], say = (s = '') => { out.push(s); console.log(s) }

const G = [['< 15%', r => r.width < 15], ['15–30%', r => r.width >= 15 && r.width < 30], ['30%+', r => r.width >= 30],
    ['30–50%', r => r.width >= 30 && r.width < 50], ['50%+', r => r.width >= 50], ['every report', () => true]]
const groups = G.map(([n, p]) => [n, rows.filter(p)])
const TRAITS = [
    ['reports', g => String(g.length)],
    ['names', g => String(new Set(g.map(r => r.symbol)).size)],
    ['in the S&P 500', g => f(share(g.map(r => r.sp500), x => x === 1), 0, '%')],
    ['revenue, last 4 qtrs (median $B)', g => f(med(g.map(r => r.revTtmB)), 2)],
    ['revenue under $500M', g => f(share(g.map(r => r.revTtmB), x => x < 0.5), 0, '%')],
    ['price (median $)', g => f(med(g.map(r => r.price)), 0)],
    ['price under $20', g => f(share(g.map(r => r.price), x => x < 20), 0, '%')],
    ['$ volume a day (median $M)', g => f(med(g.map(r => r.advM)), 0)],
    ['daily ATR (median % of price)', g => f(med(g.map(r => r.atrPct)), 1, '%')],
    ['profitable (last qtr EPS > 0)', g => f(share(g.map(r => r.profitable), x => x === 1), 0, '%')],
    ['revenue growth y/y (median)', g => f(med(g.map(r => r.revYoy)), 0, '%')],
    ['revenue growth y/y > 25%', g => f(share(g.map(r => r.revYoy), x => x > 25), 0, '%')],
    ['beat EPS last report', g => f(share(g.map(r => r.lastSurprise), x => x > 0), 0, '%')],
    ['last report move, |%| (median)', g => f(med(g.map(r => r.prevReact)), 1, '%')],
    ['— the shape of the 2 months —', () => ''],
    ['net change over the range (median)', g => f(med(g.map(r => r.netChange)), 0, '%')],
    ['  up 15%+ over it (trend up)', g => f(share(g.map(r => r.netChange), x => x >= 15), 0, '%')],
    ['  down 15%+ over it (trend down)', g => f(share(g.map(r => r.netChange), x => x <= -15), 0, '%')],
    ['  within ±5% (start ≈ end)', g => f(share(g.map(r => r.netChange), x => Math.abs(x) <= 5), 0, '%')],
    ['from the range high (median)', g => f(med(g.map(r => r.fromHigh)), 0, '%')],
    ['— the outcome —', () => ''],
    ['beat EPS THIS report', g => f(share(g.map(r => r.beatThis), x => x === 1), 0, '%')],
    ['report move > 10% either way', g => f(share(g.map(r => r.react), x => Math.abs(x) > 10), 0, '%')],
]
say(`THE RANGE-WIDTH GROUPS, CHARACTERISED — ${rows.length} reports (medians unless a share)`)
say('trait'.padEnd(38) + groups.map(([n]) => n.padStart(13)).join(''))
for (const [n, fn] of TRAITS) say(n.padEnd(38) + groups.map(([, g]) => fn(g).padStart(13)).join(''))

const wide = rows.filter(r => r.width >= 30), tight = rows.filter(r => r.width < 15)
const secOf = (r) => r.sector || '(none)'
say(`\n── SECTORS: share of the 30%+ and < 15% groups, and the share of a sector's reports that are 30%+`)
say('sector'.padEnd(26) + 'reports'.padStart(9) + 'of 30%+'.padStart(10) + 'of <15%'.padStart(10) + 'sector→30%+'.padStart(13))
const sec = [...new Set(rows.map(secOf))].map(s => {
    const all = rows.filter(r => secOf(r) === s)
    return { s, n: all.length, wide: share(all.map(r => r.width), x => x >= 30),
        inWide: (wide.filter(r => secOf(r) === s).length / wide.length) * 100, inTight: (tight.filter(r => secOf(r) === s).length / tight.length) * 100 }
}).sort((a, b) => b.wide - a.wide)
for (const x of sec) say(x.s.padEnd(26) + String(x.n).padStart(9) + f(x.inWide, 0, '%').padStart(10) + f(x.inTight, 0, '%').padStart(10) + f(x.wide, 0, '%').padStart(13))

say(`\n── IS IT THE SAME NAMES? Names with 3+ reports in the year, by how many were 30%+`)
const byName = new Map()
for (const r of rows) { if (!byName.has(r.symbol)) byName.set(r.symbol, []); byName.get(r.symbol).push(r.width >= 30) }
const multi = [...byName.values()].filter(v => v.length >= 3)
for (const [lab, p] of [['never', v => !v.some(Boolean)], ['some quarters', v => v.some(Boolean) && !v.every(Boolean)], ['every quarter', v => v.every(Boolean)]])
    say(lab.padEnd(26) + `${multi.filter(p).length} names`.padStart(12) + f((multi.filter(p).length / multi.length) * 100, 0, '%').padStart(8))
const always = (s) => byName.get(s).length >= 3 && byName.get(s).every(Boolean)
say(`  share of the 30%+ reports that come from names 30%+ every quarter: ${f((wide.filter(r => always(r.symbol)).length / wide.length) * 100, 0, '%')}`)

say(`\n── THE LARGEST NAMES IN 30%+ (by revenue)`)
const big = [...new Map(wide.filter(r => r.revTtmB != null).sort((a, b) => b.revTtmB - a.revTtmB).map(r => [r.symbol, r])).values()]
    .sort((a, b) => b.revTtmB - a.revTtmB).slice(0, 25)
say(big.map(r => `${r.symbol} (${r.sector}, $${r.revTtmB.toFixed(0)}B, ${r.width.toFixed(0)}%, ${r.report})`).join('; '))
fs.writeFileSync('data/lab/range-event-profile.out.txt', out.join('\n') + '\n')
