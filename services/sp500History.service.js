// THE S&P 500 AS IT WAS — a survivorship-free universe for the lab (Roy, 2026-10-27: "rebuild with the delisted names").
// FMP's plan serves only the latest 100 delistings and no index history (402), so the membership comes from Wikipedia's
// two tables: "List of S&P 500 companies" (today's members) and "Historical components of the S&P 500" (every change,
// "AAA replaced BBB", by effective date) — walked BACK from today, each name gets the spans it was in the index.
// Declared in screener-lab.md §30.
//
// Pure: wikitext in, no IO.

const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 }

/** A wikitext cell → its plain text: templates' last argument ({{NyseSymbol|BRK.B}} → BRK.B), links' label, refs and comments dropped. Pure. */
export function cellText(s) {
    return String(s ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '')
        .replace(/\{\{[^{}|]*\|([^{}]*)\}\}/g, (_, a) => a.split('|').at(-1))
        .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
        .replace(/'{2,}/g, '').trim()
}

/** Wikipedia's ticker → FMP's (BRK.B → BRK-B). Pure. */
export const fmpTicker = (t) => String(t ?? '').trim().toUpperCase().replace(/\./g, '-')

/** "October 6, 2026" → '2026-10-06', or null. Pure. */
export function isoDate(s) {
    const m = /^([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(s ?? '').trim())
    if (!m || !MONTHS[m[1]]) return null
    return `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

/** A wikitable (the text between `{|` … `|}` with `id`) → its rows, each its cells' raw text. Header rows (`!`) are skipped. Pure. */
export function tableRows(wikitext, id) {
    const start = wikitext.indexOf(`id="${id}"`)
    if (start < 0) return []
    const end = wikitext.indexOf('\n|}', start)
    const body = wikitext.slice(start, end < 0 ? undefined : end)
    const rows = []
    for (const block of body.split(/\n\|-[^\n]*/).slice(1)) {
        const cells = []
        for (const line of block.split('\n')) {
            if (!line.startsWith('|') || line.startsWith('|}')) continue
            // A line holds one cell (`|x` / `||x`) or several (`|a || b`).
            cells.push(...line.replace(/^\|\|?/, '').split(/\s*\|\|\s*/))
        }
        if (cells.length) rows.push(cells)
    }
    return rows
}

/** Today's members → `[{ symbol, name, sector }]` (the GICS sector, as Wikipedia has it). Pure. */
export function parseCurrent(wikitext) {
    return tableRows(wikitext, 'constituents').filter(c => c.length >= 3)
        .map(c => ({ symbol: fmpTicker(cellText(c[0])), name: cellText(c[1]), sector: cellText(c[2]) }))
        .filter(r => r.symbol)
}

/** Every change → `[{ date, added, addedName, removed, removedName }]` (either side may be null), newest first as the table has it. Pure. */
export function parseChanges(wikitext) {
    const out = []
    for (const c of tableRows(wikitext, 'changes')) {
        if (c.length < 5) continue
        const date = isoDate(cellText(c[0]))
        if (!date) continue
        out.push({ date, added: fmpTicker(cellText(c[1])) || null, addedName: cellText(c[2]) || null,
            removed: fmpTicker(cellText(c[3])) || null, removedName: cellText(c[4]) || null })
    }
    return out
}

/**
 * Today's members and the changes → each name's spans in the index from `from`: `{ spans: { SYM: [[start, end|null]] },
 * names: { SYM: name }, unmatched: [change] }` — `start` the effective date it joined (or `from`), `end` the effective
 * date it left (a member up to the session BEFORE it), null for still in. Walked back from today: a change ADDS a name
 * from its date (so before it the name was out) and REMOVES one from its date (so before it, it was in). An "added" with
 * no open span (a ticker that changed since, a double entry) is listed in `unmatched`. Pure.
 */
export function membership(current, changes, { from }) {
    const open = new Map(current.map(r => [r.symbol, null])) // SYM → the end of its open span
    const spans = {}, names = Object.fromEntries(current.map(r => [r.symbol, r.name])), unmatched = []
    const close = (sym, start) => { (spans[sym] ??= []).unshift([start, open.get(sym)]); open.delete(sym) }
    for (const ch of [...changes].sort((a, b) => b.date.localeCompare(a.date))) {
        if (ch.date < from) break
        // On one date a name can be both (a share class swap): the add is undone first, then the removal re-opens it.
        if (ch.added) { if (open.has(ch.added)) close(ch.added, ch.date); else unmatched.push(ch) }
        if (ch.removed) {
            if (open.has(ch.removed)) unmatched.push(ch)
            else { open.set(ch.removed, ch.date); names[ch.removed] ??= ch.removedName }
        }
    }
    for (const sym of [...open.keys()]) close(sym, from)
    return { spans, names, unmatched }
}

/** Was `sym` in the index on `day`? `spans` from membership. Pure. */
export const memberOn = (spans, sym, day) => (spans[sym] ?? []).some(([a, b]) => day >= a && (b == null || day < b))
