/**
 * Pythia live verification — no UI, no server, no auth.
 *
 * The agent is a plain service, so this drives it directly: one real turn against the real model
 * with the real macro/priced-in/coverage tools, then runs whatever it emitted through the `tilt`
 * normalizer and the coherence gate that guards publishing.
 *
 *   node scripts/verify-pythia.mjs             # dry run — nothing is written
 *   node scripts/verify-pythia.mjs --persist   # also publish to Mongo (supersedes the current view)
 *
 * Needs ANTHROPIC_API_KEY, FMP_API_KEY and FRED_API_KEY in .env. --persist additionally needs Mongo.
 */

import dns from 'node:dns'
import { config } from '../services/config.js'

// THE DNS PIN every other script in here carries, and this one did not. Without it the Mongo SRV
// lookup fails intermittently on this laptop — and the failure is silent where it matters most:
// `listActiveBySector` catches its own error and returns [], so `get_coverage_by_sector` hands
// Pythia "the coverage book is empty" and the desk correctly falls back to top-down reasoning.
// Four runs were read as the model refusing a finer grain when it simply had no book.
if (config.dnsServers?.length) dns.setServers(config.dnsServers)
else dns.setServers(['8.8.8.8', '1.1.1.1'])

const persist = process.argv.includes('--persist')

const { strategyAgentService } = await import('../services/agents/strategy.agent.service.js')
const { normalizeTilt, incoherentRows, overlappingRows, unpriceableRows, tiltService } = await import('../api/strategy/tilt.service.js')
const { diffStances } = await import('../monitoring/tilt.assess.js')

const line = (s = '') => console.log(s)
const rule = () => line('─'.repeat(78))

line('\nPYTHIA — live verification\n')
rule()

// The view in force rides along, exactly as StrategyPanel sends it — a run without it is a desk
// with no memory of its own calls, which is not how a review happens and made every run look new.
const currentTilt = await tiltService.getCurrentTilt('SPX').catch(() => null)
line(currentTilt ? `  reviewing the view in force: ${currentTilt.id} (${currentTilt.channel_views?.length ?? 0} standing call(s))` : '  no view in force — a first publication')

const tools = []
const t0 = Date.now()
const res = await strategyAgentService.chatStream({
    userPrompt: 'Publish the house view. Work the phases, then emit the tilt table.',
    chatState: currentTilt ? { current_tilt: currentTilt } : {},
    userId: 'verify-script',
    onToolStart: (tool) => { tools.push(tool); process.stdout.write(`  · ${tool}\n`) },
    onPhase:     (p) => process.stdout.write(`  phase ${p}\n`),
})
const secs = ((Date.now() - t0) / 1000).toFixed(1)

rule()
line(`\nREPLY (${res.reply.length} chars, ${secs}s, ${tools.length} tool calls)\n`)
line(res.reply.slice(0, 1200) + (res.reply.length > 1200 ? '\n…' : ''))

// The WHOLE reply, on disk. The preview above cuts at 1200 characters, which lands inside
// Phase 1 — so every question about how the desk REASONED (why this grain, why this basis)
// was being answered by inference rather than by reading what it actually said.
if (process.env.REPLY_OUT) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.REPLY_OUT, res.reply, 'utf8')
    line(`  full reply written to ${process.env.REPLY_OUT}`)
}

// The emitted <tilt> block, on disk. A dry run that shows a table and keeps it only in memory
// cannot be acted on: deciding to publish after SEEING it would otherwise mean a second model
// call, producing a different table from the one that was judged.
if (process.env.TILT_OUT && res.tilt) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.TILT_OUT, JSON.stringify(res.tilt, null, 2), 'utf8')
    line(`  emitted tilt written to ${process.env.TILT_OUT}`)
}

rule()
if (!res.tilt) {
    line('\n✗ NO <tilt> BLOCK EMITTED — the desk discussed but did not publish.')
    process.exit(1)
}

const doc = normalizeTilt(res.tilt)
line(`\nTILT — benchmark ${doc.benchmark}, regime "${doc.regime?.name ?? '(unnamed)'}"`)
line(`  kill-criteria: ${doc.regime?.kill_criteria?.length ?? 0}`)
// The CALLS the sized rows came from — the part of a run to audit, since every channel row follows
// from these arithmetically.
for (const v of doc.channel_views) {
    line(`  call: ${v.channel_id.padEnd(26)} dz ${v.dz >= 0 ? '+' : ''}${v.dz}  base ${v.base_dz ?? 'n/a'}  sized ${v.deviation ?? v.dz}`
        + `${v.previous_dz !== null ? `  (was ${v.previous_dz})` : ''}${v.flags.length ? `  ⚑ ${v.flags.join(', ')}` : ''}  — ${v.rationale ?? 'no reason given'}`)
}
for (const r of doc.reactions) line(`  reaction: ${r.bucket} / ${r.channel_id} ${r.reaction} — ${r.reason ?? 'no reason given'}`)
for (const x of doc.exclusions) line(`  excluded: ${x.bucket} — ${x.reason ?? 'NO REASON GIVEN'}`)
line('')
for (const r of doc.tilts) {
    const bp = r.active_bp === null ? '   ?' : `${r.active_bp >= 0 ? '+' : ''}${r.active_bp}`.padStart(5)
    line(`  ${String(r.bucket).padEnd(34)} ${String(r.grain).padEnd(9)} ${String(r.proxy?.symbol ?? '—').padEnd(5)} ${String(r.stance ?? '?').padEnd(8)} ${bp}bp  ${String(r.horizon).padEnd(4)} ${r.basis ?? '—'}`)
}

rule()
const bad = incoherentRows(doc)
const overlapping = overlappingRows(doc)
const unpriceable = unpriceableRows(doc)
const emitted = Array.isArray(res.tilt.tilts) ? res.tilt.tilts.length : 0
line('\nGATES')
line(`  rows emitted / kept      ${emitted} / ${doc.tilts.length}${emitted !== doc.tilts.length ? '   ← dropped: unrecognised bucket' : ''}`)
line(`  nets to zero             ${doc.balanced ? 'yes' : `NO (${doc.net_bp}bp)`}`)
line(`  stance vs weight         ${bad.length ? `${bad.length} CONTRADICTION(S)` : 'coherent'}`)
for (const b of bad) line(`      ${b.bucket}: ${b.detail}`)
line(`  sector vs its own parts  ${overlapping.length ? `${overlapping.length} OVERLAP(S)` : 'no double-counting'}`)
for (const o of overlapping) line(`      ${o.detail}`)
line(`  every bucket priceable   ${unpriceable.length ? `${unpriceable.length} WITH NO FUND` : 'yes'}`)
for (const u of unpriceable) line(`      ${u.detail}`)
line(`  grains                   ${doc.tilts.filter(r => r.grain === 'industry').length} industry / ${doc.tilts.filter(r => r.grain === 'sector').length} sector`)
line(`  baselines                stamped at publish (not in a dry run)`)

if (!persist) {
    line('\nDry run — nothing written. Re-run with --persist to publish.\n')
    process.exit(bad.length ? 1 : 0)
}

rule()
const previous = await tiltService.getCurrentTilt(doc.benchmark)
const result   = await tiltService.publishTilt(res.tilt)
if (!result.ok) {
    line(`\n✗ PUBLISH REFUSED — ${result.reason}${result.detail ? `: ${result.detail}` : ''}\n`)
    process.exit(1)
}
const changes = diffStances(previous, result.doc)
line(`\n✓ PUBLISHED ${result.doc.id}`)
line(`  superseded: ${previous?.id ?? '(none — first view)'}`)
line(`  changed:    ${changes.length ? changes.map(c => `${c.bucket} ${c.from ?? '—'}→${c.to ?? '—'}`).join(', ') : 'nothing'}`)
line(`  baselines:  ${result.doc.tilts.filter(r => r.base_px !== null).length}/${result.doc.tilts.length} priced\n`)
process.exit(0)
