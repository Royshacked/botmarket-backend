// The whole-app drive's report: one self-contained HTML page next to the screenshots.
import { escapeHtml as h, groupWarnings, summarize } from './lib.mjs'

const KIND_LABEL = {
    overflow: 'Sideways scroll', font: 'Font outside the theme', color: 'Colour outside the palette', contrast: 'Low contrast',
    'tiny-text': 'Tiny text', clipped: 'Text cut off', truncated: 'Ellipsis, no tooltip', 'no-name': 'Control with no name',
    'tap-target': 'Small tap target', offscreen: 'Control off the screen', overlap: 'Controls overlap', 'broken-image': 'Broken image',
}

function shotList(shots) {
    return `<div class="shots">${shots.map(s => `<figure><a href="${h(s.file)}" target="_blank"><img loading="lazy" src="${h(s.file)}" alt="${h(s.label)}"></a><figcaption>${h(s.label)}${s.findings ? ` · ${s.findings} finding${s.findings === 1 ? '' : 's'}` : ''}</figcaption></figure>`).join('')}</div>`
}

function warningTable(groups) {
    if (!groups.length) return '<p class="muted">None.</p>'
    return `<table><thead><tr><th>Kind</th><th>Finding</th><th>×</th><th>Where (samples)</th></tr></thead><tbody>${groups.map(g => `
        <tr class="sev-${h(g.severity ?? 'warn')}"><td>${h(KIND_LABEL[g.kind] ?? g.kind)}</td><td>${h(g.message)}</td><td>${g.count}</td><td><code>${g.samples.map(h).join('</code><br><code>')}</code></td></tr>`).join('')}
    </tbody></table>`
}

export function renderReport({ steps, meta }) {
    const sum = summarize(steps)
    const all = steps.flatMap(s => s.warnings ?? [])
    const design = groupWarnings(all.filter(w => w.severity !== 'info'))
    const info = groupWarnings(all.filter(w => w.severity === 'info'))
    const fonts = new Map()
    for (const s of steps) for (const f of s.fonts ?? []) fonts.set(f, (fonts.get(f) ?? 0) + 1)
    const sizes = new Set(steps.flatMap(s => s.fontSizes ?? []))

    const stepHtml = steps.map(s => {
        const bad = (s.checks ?? []).filter(c => !c.ok).length + (s.errors ?? []).length + (s.crashed ? 1 : 0)
        return `<section class="step ${bad ? 'is-bad' : 'is-ok'}" id="${h(s.name)}">
            <h2>${bad ? '✗' : '✓'} ${h(s.name)} <small>${h(s.viewport)} · ${(s.ms / 1000).toFixed(1)}s</small></h2>
            ${s.crashed ? `<p class="err">Step stopped: ${h(s.crashed)}</p>` : ''}
            <ul class="checks">${(s.checks ?? []).map(c => `<li class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'} ${h(c.what)}</li>`).join('')}</ul>
            ${(s.notes ?? []).length ? `<ul class="notes">${s.notes.map(n => `<li>${h(n)}</li>`).join('')}</ul>` : ''}
            ${(s.errors ?? []).length ? `<h3>Errors</h3><ul class="errs">${s.errors.map(e => `<li>${h(e)}</li>`).join('')}</ul>` : ''}
            ${(s.blocked ?? []).length ? `<h3>Writes the guard stopped</h3><ul class="notes">${s.blocked.map(e => `<li><code>${h(e)}</code></li>`).join('')}</ul>` : ''}
            ${(s.warnings ?? []).length ? `<details><summary>${s.warnings.length} design findings</summary>${warningTable(groupWarnings(s.warnings))}</details>` : ''}
            ${shotList(s.shots ?? [])}
        </section>`
    }).join('\n')

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drive report</title>
<style>
:root{--bg:#0b1110;--panel:#121b19;--line:#24312e;--text:#d9e4e1;--muted:#8a9a96;--ok:#4fbf8a;--bad:#e5645a;--warn:#e0b450}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f6f7f7;--panel:#fff;--line:#dde3e1;--text:#18211f;--muted:#5d6b67;--ok:#1f8a58;--bad:#c0392b;--warn:#a2730a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif;padding:24px 16px;max-width:1200px;margin-inline:auto}
h1{margin:0 0 4px}h2{font-size:17px;margin:0 0 8px}h2 small{color:var(--muted);font-weight:400}h3{font-size:13px;margin:12px 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted)}.tiles{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px}.tile b{display:block;font-size:22px}
.step{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:8px;padding:14px 16px;margin:12px 0}.step.is-bad{border-left-color:var(--bad)}
ul{margin:4px 0;padding-left:18px}.checks{list-style:none;padding:0}.ok{color:var(--ok)}.bad,.err,.errs li{color:var(--bad)}.notes li{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13px;margin:6px 0}th,td{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top}td:nth-child(3){text-align:right}
code{font-size:12px;overflow-wrap:anywhere}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:10px}
figure{margin:0}figure img{width:100%;border:1px solid var(--line);border-radius:6px;display:block}figcaption{font-size:12px;color:var(--muted);margin-top:3px}
details summary{cursor:pointer;color:var(--warn);margin-top:8px}.overflow-x{overflow-x:auto}
</style></head><body>
<h1>Whole-app drive</h1>
<p class="muted">${h(meta.base)} · ${h(meta.when)} · user ${h(meta.user)} · backend ${h(meta.backend)} · screens only, no agent turns</p>
<div class="tiles">
  <div class="tile"><b class="${sum.failed ? 'bad' : 'ok'}">${sum.passed}/${sum.steps}</b>steps passed</div>
  <div class="tile"><b class="${sum.checksFailed ? 'bad' : 'ok'}">${sum.checksFailed}</b>failed checks + errors</div>
  <div class="tile"><b>${design.length}</b>distinct design findings</div>
  <div class="tile"><b>${[...fonts.keys()].length}</b>font families seen</div>
  <div class="tile"><b>${sizes.size}</b>font sizes seen</div>
</div>
<h2>Design coherence, across every screen</h2>
<div class="overflow-x">${warningTable(design)}</div>
<p class="muted">Fonts seen: ${[...fonts.entries()].map(([f, n]) => `<code>${h(f)}</code> (${n} screens)`).join(' · ')} — theme fonts: ${(meta.themeFonts ?? []).map(f => `<code>${h(f)}</code>`).join(' · ')}</p>
<p class="muted">Font sizes seen (px): ${[...sizes].sort((a, b) => a - b).join(' · ')}</p>
${info.length ? `<details><summary>${info.length} minor notes (ellipsis without tooltip, borderline contrast)</summary><div class="overflow-x">${warningTable(info)}</div></details>` : ''}
${stepHtml}
</body></html>`
}
