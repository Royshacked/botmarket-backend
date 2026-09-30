/**
 * Rebuild the ACTIVE tilt's per-row clocks and baselines from the publication chain (2026-09-30).
 *
 * WHY. `openWindow` preserves a row's `set_at` only when the row it is handed already carries one,
 * and a row off the wire never does: Pythia emits a table, the `<tilt>` block has no `set_at` field,
 * and publish stored what the model emitted. So every publish re-stamped every deadline and
 * `stampBaselines` re-priced every baseline — a stance the desk had merely RESTATED came back as a
 * brand-new call. Four of the five republishes on the book restarted all six rows. The consequences
 * were that nothing could ever mature (the one trigger the whole clock exists to pull) and that the
 * score re-based at each review's own prices, so Energy read +0.99bp against −3.36bp measured from
 * the baseline it was actually set at.
 *
 * `carryReaffirmed` fixes it going forward. This repairs the view standing right now.
 *
 * HOW. By REPLAYING the chain oldest→newest through that same `carryReaffirmed`, each publish
 * re-run as of its own `created_at` — the fix applied retroactively, rather than a second opinion
 * about what counts as a reaffirm. Each stored row is stripped back to what the wire carried
 * (sector, stance, weight, horizon, words) and handed the rebuilt view before it; a row that is NOT
 * carried keeps the document's own stored clock and baseline, which for a genuinely new call is
 * already right — it is that publish's timestamp and that day's prices.
 *
 * Contributions are then re-graded from the restored baselines with the monitor's own pure
 * `gradeRow` against live prices, so the board does not read against one baseline while the rows
 * carry another for up to a day.
 *
 * WHAT IS NOT TOUCHED:
 *   • The SUPERSEDED documents. They are the record of what we believed and when; their clocks are
 *     wrong in the same way, but rewriting an archived publication is a different decision from
 *     correcting the view in force, and nothing but `listTilts` reads them.
 *   • `created_at`, `id`, the regime, the stances themselves. No stance, weight or horizon moves
 *     here — only the window each one is judged over and the price it is judged from.
 *   • The review anchor. The repair writes a `clock_repair` revision, which is deliberately not in
 *     `REVIEW_KINDS`, so it does not read as the desk having re-examined the view and does not push
 *     the monthly floor out.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node scripts/repair-tilt-clocks.mjs                       # local DB_NAME
 *   node scripts/repair-tilt-clocks.mjs --apply
 *   DB_NAME=test node scripts/repair-tilt-clocks.mjs --apply  # prod
 */

import dns from 'node:dns'
import { config } from '../services/config.js'

// Mongo's SRV lookup fails on this laptop's default resolver (docs: the DNS pin every script here
// carries). Harmless where it already worked.
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const { tiltService, normalizeTilt, carryReaffirmed } = await import('../api/strategy/tilt.service.js')
const { gradeRow, totalContributionBp } = await import('../monitoring/tilt.assess.js')
const { proxyFor, BENCHMARK_PROXY }  = await import('../services/entity/vocabulary.js')
const { fetchLastPrice } = await import('../services/lastPrice.service.js')

const apply     = process.argv.includes('--apply')
const benchmark = process.env.BENCHMARK || 'SPX'

const line = (s = '') => console.log(s)
const rule = () => line('─'.repeat(104))
const day  = v => (typeof v === 'string' ? v.slice(0, 10) : String(v))
const px   = v => (v === null || v === undefined ? '—' : String(v))

line(`\nTILT CLOCK REPAIR — ${benchmark}${apply ? '' : '   (dry run)'}\n`)

// ─── the chain ────────────────────────────────────────────────────────────────

const history = await tiltService.listTilts({ benchmark, limit: 100 })
if (!history.length) { line('No published views for this benchmark. Nothing to repair.\n'); process.exit(0) }

// Oldest first — the order they were actually published in, which is the order a replay needs.
const chain  = [...history].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
const active = chain.at(-1)
if (active?.status !== 'active') {
    // The replay has to END at the view in force; if the newest document is not it, something about
    // this collection is not what this script assumes and guessing would corrupt a graded record.
    line(`✗ REFUSED — the newest document (${active?.id}) is ${active?.status}, not the active view.`)
    line('  Repairing a superseded publication is a different decision. Nothing written.\n')
    process.exit(1)
}
line(`chain: ${chain.length} published view${chain.length === 1 ? '' : 's'}, ${day(chain[0].created_at)} → ${day(active.created_at)}`)
line(`active: ${active.id}  (${active.tilts?.length ?? 0} stances)\n`)

// ─── replay ───────────────────────────────────────────────────────────────────

/** A stored row as the WIRE carried it — the server stamps everything this strips. */
const toWire = ({ set_at, review_date, base_px, base_bench_px, contribution_bp, state, ...rest }) => rest

/**
 * Sectors whose history the replay CANNOT reconstruct, and why — see the loop below. Keyed by
 * sector so the finding travels with the stance across every later publish that reaffirmed it.
 */
const unreconstructable = new Map()

let prev = null
for (const doc of chain) {
    const stored  = Array.isArray(doc.tilts) ? doc.tilts : []
    const carried = carryReaffirmed(stored.map(toWire), prev, doc.created_at)

    const rows = carried.map((r, i) => {
        // `carryReaffirmed` sets `set_at` only when it carried the row, and `toWire` stripped the
        // stored one — so its presence IS the answer to "did this publish restate the call?".
        const wasCarried = r.set_at !== undefined
        const was = stored[i] ?? {}

        // A row the replay did not carry is a call this publish genuinely MADE, so the clock and
        // baseline the document holds should be that day's — and normally are.
        //
        // Unless they are not. One document on the book (the Aug 18 publish) was sent rows that
        // already carried a `set_at`, and it kept them across a weight change: its Energy row reads
        // -25bp against a clock and a price belonging to the -50bp call before it. There is no
        // honest repair for that stance. Its real baseline is the sector proxy on the day the new
        // weight was set, which was never recorded, and deep history is exactly what this app cannot
        // fetch — that is why baselines are frozen in the first place. Guessing it, or nulling it so
        // the monitor backfills TODAY's price against a six-week-old call, would both be worse than
        // the wrong-but-visible figure already stored. So it is reported, not rewritten.
        if (!wasCarried && was.set_at && was.set_at !== doc.created_at) {
            unreconstructable.set(r.sector, `its ${day(doc.created_at)} publish inherited a clock from the call before it`)
        } else if (!wasCarried) {
            unreconstructable.delete(r.sector)   // freshly and correctly stamped — the history restarts clean here
        }

        return {
            ...r,
            set_at:        r.set_at        ?? was.set_at        ?? null,
            base_px:       r.base_px       ?? was.base_px       ?? null,
            base_bench_px: r.base_bench_px ?? was.base_bench_px ?? null,
        }
    })
    // Through the normalizer so `review_date` is DERIVED from the restored `set_at`, exactly as a
    // publish would have derived it.
    prev = normalizeTilt({ ...doc, tilts: rows }, doc.created_at)
}

const rebuilt = prev.tilts
const stored  = active.tilts ?? []

// The replay must not have invented, dropped or re-sectored a stance — it only moves clocks.
const sameSet = rebuilt.length === stored.length
    && rebuilt.every(r => stored.some(s => s.sector === r.sector))
if (!sameSet) {
    line('✗ REFUSED — the replay did not reproduce the active view\'s sectors. Nothing written.')
    line(`  stored:  ${stored.map(r => r.sector).join(', ')}`)
    line(`  rebuilt: ${rebuilt.map(r => r.sector).join(', ')}\n`)
    process.exit(1)
}

// ─── re-grade from the restored baselines ─────────────────────────────────────

const nowMs    = Date.now()
const benchSym = BENCHMARK_PROXY[benchmark] ?? null
const benchNow = benchSym ? await fetchLastPrice(benchSym).catch(() => null) : null
if (benchNow === null) line(`! ${benchSym ?? benchmark} could not be priced — contributions keep their current figures.\n`)

const graded = []
for (const row of rebuilt) {
    // A stance the replay could not reconstruct keeps the clock and baseline it already has. It is
    // still re-graded, because refreshing a contribution against an UNCHANGED baseline is only what
    // the monitor does hourly anyway.
    const keep = unreconstructable.has(row.sector)
    const base = keep ? (stored.find(s => s.sector === row.sector) ?? row) : row

    const proxy     = proxyFor(row.sector)
    const sectorNow = proxy ? await fetchLastPrice(proxy).catch(() => null) : null
    graded.push(gradeRow(base, { sectorNow, benchNow }, nowMs))
}

// ─── what would change ────────────────────────────────────────────────────────

rule()
line('sector                    set_at                  baseline                contribution (bp)')
rule()
let moved = 0
for (const row of graded) {
    const was = stored.find(s => s.sector === row.sector) ?? {}
    const clockMoved = was.set_at !== row.set_at
    const baseMoved  = was.base_px !== row.base_px
    if (clockMoved || baseMoved) moved++
    const arrow = (a, b, changed) => `${String(a).padStart(10)} ${changed ? '→' : ' '} ${changed ? String(b).padEnd(10) : ' '.repeat(10)}`
    line([
        String(row.sector).padEnd(24),
        arrow(day(was.set_at), day(row.set_at), clockMoved),
        ' ',
        arrow(px(was.base_px), px(row.base_px), baseMoved),
        ' ',
        arrow(px(was.contribution_bp), px(row.contribution_bp), was.contribution_bp !== row.contribution_bp),
        unreconstructable.has(row.sector) ? '  LEFT ALONE — see below'
            : clockMoved ? `  held since ${day(row.set_at)}, due ${day(row.review_date)}` : '  unchanged',
    ].join(''))
}
rule()
line(`total contribution: ${px(active.monitor?.total_bp)} → ${px(totalContributionBp(graded))} bp`)

if (unreconstructable.size) {
    line('')
    line('NOT REPAIRED — the chain cannot say when these calls were made:')
    for (const [sector, why] of unreconstructable) line(`  ${String(sector).padEnd(24)} ${why}`)
    line('  Their real baseline is the proxy price on the day the stance was set, which was never')
    line('  recorded and cannot be fetched. They keep the figures they have until the desk')
    line('  re-authors them, which stamps an honest clock and baseline on the spot.')
}

const matured = graded.filter(r => r.state === 'matured')
if (matured.length) {
    line('')
    line(`! ${matured.map(r => r.sector).join(', ')} land ALREADY MATURED on the restored clock.`)
    line('  That is the repair working — the call came due and nobody was asked. The monitor will')
    line('  offer the review on its next tick.')
}

if (!moved) { line('\nEvery clock and baseline already matches the replay. Nothing to repair.\n'); process.exit(0) }
if (!apply) { line(`\nDry run — ${moved} row${moved === 1 ? '' : 's'} would be repaired. Re-run with --apply to write.\n`); process.exit(0) }

// ─── write ────────────────────────────────────────────────────────────────────

const note = `Clocks + baselines rebuilt from the publication chain (${moved} row${moved === 1 ? '' : 's'}); reaffirmed stances had been re-stamped at every publish`
const res  = await tiltService.updateTilt(active.id, {
    tilts: graded,
    revision_kind: 'clock_repair',
    revision_note: note,
})
if (!res.ok) {
    line(`\n✗ WRITE FAILED — ${res.reason ?? res.error?.message}. Nothing changed.\n`)
    process.exit(1)
}

// The running total is the monitor's bookkeeping, so it goes through the monitor's own path — no
// second revision for a number that is derived from the rows just written.
await tiltService.recordMonitorState(active.id, { set: { 'monitor.total_bp': totalContributionBp(graded) } })

line(`\n✓ REPAIRED ${active.id} — ${moved} row${moved === 1 ? '' : 's'}, one \`clock_repair\` revision on the trail.\n`)
process.exit(0)
