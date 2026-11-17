#!/usr/bin/env node
// THE NEWS AROUND THE MOVES — ONE COMPANY (Roy, 2026-11-17: "where the news appear around the move and what can we
// learn from it"). Declared in docs/design/proteus.md §10.9 before the run. A description of one name's moves.
//
//   node scripts/lab-proteus-moves-news.mjs [SYMBOL=LNG]   → data/lab/proteus-moves-news-<SYMBOL>.out.txt
//
// Fetched once and kept (data/lab/news-<SYMBOL>.json): the SEC filings list (EDGAR submissions, the User-Agent the
// other SEC labs use, from config), FMP headlines for the last year (weekly windows), the 5-minute bars of the last ~3
// months (the profile's own fetch). The daily bars, reports, analysts and insiders come from the lab's caches.
import dns from 'dns'
import fs from 'fs'
import 'dotenv/config'

dns.setServers(['8.8.8.8', '1.1.1.1'])
const { atrsOf, median } = await import('./lab-proteus.shared.mjs')
const { readName } = await import('./lab-proteus-moves.mjs')
const E = await import('../services/behaviourProfile.engine.js')

const DAY = 86_400_000
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const ms = (ts) => (ts < 1e12 ? ts * 1000 : ts)

/** An 8-K's items → words. */
export const ITEM_WORDS = Object.freeze({
    '1.01': 'agreement', '1.02': 'agreement ended', '2.01': 'acquisition', '2.02': 'results', '2.03': 'debt', '2.05': 'cost cuts',
    '3.02': 'shares sold', '5.02': 'people', '5.03': 'bylaws', '5.07': 'shareholder vote', '7.01': 'Reg FD news', '8.01': 'other news', '9.01': 'exhibits',
})
/** A headline that names the company (LNG: Cheniere; KO: Coca-Cola / Coke); the rest FMP tags with the ticker are the industry's news. */
export const COMPANY_NAMES = Object.freeze({ LNG: /cheniere/i, KO: /coca-cola|coca cola|\bcoke\b/i })
export const isCompany = (title, sym = 'LNG') => (COMPANY_NAMES[sym] ?? new RegExp(String.raw`\b${sym}\b`)).test(String(title ?? ''))
export const itemWords = (items) => [...new Set(String(items ?? '').split(',').map(s => s.trim()).filter(i => i && i !== '9.01').map(i => ITEM_WORDS[i] ?? i))]

/** Events within [from, to] sessions of start index `s` on `days` (YYYY-MM-DD list), each with its offset. Pure. */
export function around(days, s, events, from = -10, to = 5) {
    const idx = new Map(days.map((d, i) => [d, i]))
    const at = (d) => { if (idx.has(d)) return idx.get(d); const k = days.findIndex(x => x >= d); return k < 0 ? null : k }   // a weekend event → the next session
    return events.map(e => ({ ...e, off: (at(e.day) ?? Infinity) - s })).filter(e => e.off >= from && e.off <= to).sort((a, b) => a.off - b.off)
}

/** Each source fetched once and saved as it completes (a dropped connection keeps what was done); a rerun resumes. */
async function fetchAll(sym, cik) {
    const file = `data/lab/news-${sym}.json`
    const got = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
    const save = () => fs.writeFileSync(file, JSON.stringify(got))
    const sleep = (t) => new Promise(r => setTimeout(r, t))
    if (!got.sec) {
        const { config } = await import('../services/config.js')
        const H = { 'User-Agent': config.secUserAgent, 'Accept-Encoding': 'gzip, deflate' }
        const sec = []
        const take = (f) => f.form.forEach((form, i) => { if (form === '8-K' || form === '8-K/A') sec.push({ day: f.filingDate[i], at: f.acceptanceDateTime[i], form, items: f.items[i] }) })
        const main = await (await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: H })).json()
        take(main.filings.recent)
        for (const p of main.filings.files ?? []) {
            if (p.filingTo < '2016-01-01') continue
            await sleep(250)
            take(await (await fetch(`https://data.sec.gov/submissions/${p.name}`, { headers: H })).json())
        }
        got.sec = sec
        save()
        console.log(`SEC: ${sec.length} 8-K filings`)
    }
    if (!got.newsDone) {
        const { fetchStockNews } = await import('../providers/fmp.provider.js')
        got.news ??= []
        got.weeks ??= []
        const now = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + DAY
        let failed = 0
        for (let to = now; to > now - 365 * DAY; to -= 7 * DAY) {
            if (got.weeks.includes(to)) continue
            try {
                for (const r of await fetchStockNews({ symbols: [sym], from: to - 7 * DAY, to, limit: 250 })) got.news.push({ at: r.publishedDate, title: r.title, site: r.publisher ?? r.site })
                got.weeks.push(to)
                save()
            } catch (err) {
                if (err?.status === 402 || /402/.test(err?.message ?? '')) { got.weeks.push(to); save(); continue }   // past FMP's year — never served
                failed++; console.warn(`news to ${dayOf(to)}: ${err.message}`)
            }
            await sleep(1100)
        }
        got.news = [...new Map(got.news.map(n => [`${n.at}|${n.title}`, n])).values()]
        if (!failed) got.newsDone = true
        save()
        console.log(`headlines: ${got.news.length}${failed ? ` — ${failed} weeks failed, rerun to fill them` : ''}`)
        if (failed) process.exit(2)
    }
    if (!got.five?.length) {
        const { fetchProfileBars } = await import('../services/behaviourProfile.service.js')
        got.five = (await fetchProfileBars(sym, { getDaily: async () => [] }))['5min']   // the 5-minute only
        save()
        console.log(`5-minute bars: ${got.five.length}`)
    }
    return got
}

/** A name's sources (fetched once, kept) and the lab's extras. → { got, ex } — the news-chain lab reads the same. */
export async function sourcesOf(SYM) {
    const facts = fs.readFileSync('data/lab/sec-facts.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(r => r.symbol === SYM)
    const CIK = facts?.cik ?? { LNG: '0000003570' }[SYM]
    if (!CIK) throw new Error(`${SYM}: no CIK`)
    return { got: await fetchAll(SYM, CIK), ex: JSON.parse(fs.readFileSync('data/lab/screener.extras.json', 'utf8')) }
}

/** Every dated event of a name, one list: { day, kind, what } (an 8-K twice: whole, and by its main item with no `what`). Pure. */
export function eventsOf(SYM, got, ex) {
    return [
        ...got.sec.map(f => ({ day: f.day, kind: '8-K', what: `8-K ${itemWords(f.items).join(' + ') || f.items}` })),
        ...(ex.history?.[SYM] ?? []).filter(r => r.epsActual != null).map(r => ({ day: r.date, kind: 'report', what: `report ${r.epsActual >= r.epsEstimated ? 'beat' : 'miss'} (${r.epsActual} vs ${r.epsEstimated})` })),
        ...(ex.grades?.[SYM] ?? []).filter(g => g[1] !== 'maintain').map(g => ({ day: g[0], kind: 'analyst', what: `analyst ${g[1]}` })),
        ...(ex.targets?.[SYM] ?? []).map(t => ({ day: t[0], kind: 'target', what: `target ${t[1]} (${t[3] > 0 ? 'raised' : t[3] < 0 ? 'cut' : 'set'}, price ${Math.round(t[2])})` })),
        ...(ex.insiders?.[SYM] ?? []).filter(r => /^[PS]-/.test(r.transactionType ?? '')).map(r => ({ day: r.transactionDate, kind: r.transactionType.startsWith('P') ? 'insider buy' : 'insider sell', what: `${r.transactionType.startsWith('P') ? 'insider BUY' : 'insider sell'} ${r.typeOfOwner ?? ''}` })),
        ...got.news.map(n => ({ day: String(n.at).slice(0, 10), kind: isCompany(n.title, SYM) ? 'company news' : 'industry news', what: `“${n.title}” (${n.site})` })),
        // The 8-K again by its main item (no `what`: counted, not listed twice) — results and agreements told apart.
        ...got.sec.map(f => ({ day: f.day, kind: `8-K ${itemWords(f.items)[0] ?? 'other'}`, what: null })),
    ]
}

if (process.argv[1]?.endsWith('lab-proteus-moves-news.mjs')) {   // run, not imported (the unit test imports it)
    const SYM = (process.argv[2] ?? 'LNG').toUpperCase()
    const { got, ex } = await sourcesOf(SYM)
    const events = eventsOf(SYM, got, ex)
    const newsFrom = got.news.length ? got.news.map(n => String(n.at).slice(0, 10)).sort()[0] : null

    const lines = []
    const say = (l = '') => { console.log(l); lines.push(l) }
    const pc = (a, b) => (b ? `${Math.round(a / b * 100)}%` : '—')
    say(`# The news around the moves — ${SYM} (${new Date().toISOString().slice(0, 10)}) — proteus.md §10.9`)
    say(`sources: ${got.sec.length} 8-K filings · ${events.filter(e => e.kind === 'report').length} reports · ${events.filter(e => e.kind === 'analyst').length} analyst changes + ${events.filter(e => e.kind === 'target').length} targets (from 2023-06) · ${events.filter(e => e.kind.startsWith('insider')).length} insider trades · ${got.news.length} headlines (from ${newsFrom})`)

    // ── Daily ──
    const bars = await readName(SYM)
    const days = bars.map(b => dayOf(ms(b.timestamp)))
    const atrs = atrsOf(bars), flags = E.moveFlags(bars, atrs), starts = E.moveStartsOf(bars, flags)
    const isNews = (k) => k === 'company news' || k === 'industry news'
    const kinds = ['8-K', ...[...new Set(events.filter(e => e.kind.startsWith('8-K ')).map(e => e.kind))].sort(), 'report', 'analyst', 'target', 'insider buy', 'insider sell', 'company news', 'industry news']
    const tally = { before: {}, on: {}, after: {} }
    say(`\n## Daily — ${starts.length} moves; events from 10 sessions before the start to 5 after (−n = before)`)
    for (const s of starts) {
        let hi = -Infinity
        for (let j = s + 1; j <= Math.min(bars.length - 1, s + 20); j++) hi = Math.max(hi, bars[j].high)
        const ev = around(days, s, events)
        for (const k of kinds) for (const [w, test] of [['before', (o) => o < 0], ['on', (o) => o === 0], ['after', (o) => o > 0]])
            if (ev.some(e => e.kind === k && test(e.off))) tally[w][k] = (tally[w][k] ?? 0) + 1
        const shown = ev.filter(e => e.what && !isNews(e.kind))
        const heads = ev.filter(e => isNews(e.kind))
        say(`  ${days[s]} ${bars[s].close.toFixed(2)} → +${((hi / bars[s].close - 1) * 100).toFixed(0)}%`)
        for (const e of shown) say(`      ${String(e.off).padStart(3)}  ${e.day}  ${e.what}`)
        for (const k of ['company news', 'industry news']) {
            const h = heads.filter(e => e.kind === k)
            if (h.length) say(`      ${k}: ${h.length} (${h.filter(e => e.off < 0).length} before, ${h.filter(e => e.off === 0).length} on the day, ${h.filter(e => e.off > 0).length} after)`)
        }
        for (const e of heads.filter(e => e.off <= 0 && e.kind === 'company news').slice(-6)) say(`      ${String(e.off).padStart(3)}  ${e.day}  ${e.what.slice(0, 140)}`)
        if (!ev.length) say('      — nothing dated in the window')
    }
    const inNewsYear = starts.filter(s => newsFrom && days[s] >= newsFrom).length
    say('\n  share of the moves with each, before (−10…−1) · on the start day · after (+1…+5):')
    for (const k of kinds) {
        const n = isNews(k) ? inNewsYear : k === 'analyst' || k === 'target' ? starts.filter(s => days[s] >= '2023-06-22').length : starts.length
        say(`    ${k.padEnd(20)} ${pc(tally.before[k] ?? 0, n).padStart(4)} · ${pc(tally.on[k] ?? 0, n).padStart(4)} · ${pc(tally.after[k] ?? 0, n).padStart(4)}   (of ${n} moves${isNews(k) ? ' in the news year' : k === 'analyst' || k === 'target' ? ' from 2023-06' : ''})`)
    }
    // How dense: the share of ANY 16-session window holding each kind (calibration — §10.9).
    say('  how often a 16-session window holds each at all (every session as a start, the same span):')
    const dense = {}
    let nWin = 0
    for (let s = 260; s < days.length - 5; s += 5) {
        nWin++
        const ev = around(days, s, events)
        for (const k of kinds) if (ev.some(e => e.kind === k)) dense[k] = (dense[k] ?? 0) + 1
    }
    say(`    ${kinds.filter(k => !isNews(k) && !['analyst', 'target'].includes(k)).map(k => `${k} ${pc(dense[k] ?? 0, nWin)}`).join(' · ')}`)

    // ── 5-minute ──
    const five = got.five
    const fAtr = atrsOf(five), fFlags = E.moveFlags(five, fAtr, { session: true }), fStarts = E.moveStartsOf(five, fFlags)
    const heads0 = got.news.map(n => ({ t: Date.parse(String(n.at).replace(' ', 'T') + (String(n.at).includes('Z') || String(n.at).includes('+') ? '' : 'Z')), ...n })).filter(n => Number.isFinite(n.t))
    for (const cls of ['company', 'industry']) {
    const heads = heads0.filter(h => (cls === 'company') === isCompany(h.title, SYM))
    // Calibration: any 5-minute bar (every 6th) — how often a headline of this class sat in the 24 hours before it.
    let anyN = 0, anyB = 0
    for (let j = 0; j < five.length; j += 6) { const t = ms(five[j].timestamp); anyN++; if (heads.some(h => h.t > t - DAY && h.t <= t)) anyB++ }
    const perDay = new Map()
    for (const h of heads) { const d = etDay.format(new Date(h.t)); perDay.set(d, (perDay.get(d) ?? 0) + 1) }
    const sessions = [...new Set(five.map(b => etDay.format(new Date(ms(b.timestamp)))))]
    const withNews = sessions.filter(d => perDay.has(d)).length
    say(`\n## 5-minute, ${cls.toUpperCase()} headlines (${heads.length}) — ${five.length} bars (${sessions[0]} → ${sessions.at(-1)}), ${fStarts.length} moves inside one session`)
    say(`  how dense: on ${withNews} of ${sessions.length} sessions (${pc(withNews, sessions.length)}), median ${median(sessions.map(d => perDay.get(d) ?? 0))} a session; any 5-minute bar had one in the 24h before ${pc(anyB, anyN)}`)
    let b24 = 0, during = 0, a24 = 0, sameDayEv = 0
    const lagH = []
    for (const s of fStarts) {
        const t = ms(five[s].timestamp), a = fAtr[s]
        let hitT = null
        for (let j = s + 1; j < five.length && j <= s + 20; j++) if (five[j].high >= five[s].close + 4 * a) { hitT = ms(five[j].timestamp); break }
        const before = heads.filter(h => h.t > t - DAY && h.t <= t), dur = heads.filter(h => hitT && h.t > t && h.t <= hitT), after = heads.filter(h => h.t > (hitT ?? t) && h.t <= t + DAY)
        if (before.length) { b24++; lagH.push((t - Math.max(...before.map(h => h.t))) / 3_600_000) }
        if (dur.length) during++
        if (after.length) a24++
        const d = etDay.format(new Date(t))
        const ev = events.filter(e => e.what && !isNews(e.kind) && e.day === d)
        if (ev.length) sameDayEv++
        const tm = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t))
        say(`  ${d} ${tm} ET  ${five[s].close.toFixed(2)} · headlines 24h before ${before.length}, during ${dur.length}, 24h after ${after.length}${ev.length ? ` · ${ev.map(e => e.what).join('; ')}` : ''}`)
        const last = before.sort((x, y) => y.t - x.t)[0]
        if (last) say(`        last before (${((t - last.t) / 3_600_000).toFixed(1)}h): “${String(last.title).slice(0, 120)}” (${last.site})`)
        if (dur[0]) say(`        during: “${String(dur[0].title).slice(0, 120)}” (${dur[0].site})`)
    }
    say(`\n  ${cls}: of ${fStarts.length} moves — a headline in the 24h before ${b24} (${pc(b24, fStarts.length)}, vs ${pc(anyB, anyN)} of any bar; median ${median(lagH)?.toFixed(1) ?? '—'}h before the start) · during the move ${during} (${pc(during, fStarts.length)}) · in the 24h after ${a24} (${pc(a24, fStarts.length)}) · an 8-K / report / analyst event that session ${sameDayEv} (${pc(sameDayEv, fStarts.length)})`)
    }
    fs.writeFileSync(`data/lab/proteus-moves-news-${SYM}.out.txt`, lines.join('\n') + '\n')
    console.log(`→ data/lab/proteus-moves-news-${SYM}.out.txt`)
    process.exit(0)
}
