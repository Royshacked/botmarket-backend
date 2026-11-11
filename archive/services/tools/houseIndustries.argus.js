// ARGUS'S WORDS for the house's industries — archived 2026-11-11 with his scan (docs/design/argus-rework.md): he picks
// from the house's lists now, and the live tool (services/tools/houseIndustries.tools.js) is Atlas's alone. Kept so the
// archived list-building Argus loads and reads the list as it did. Nothing live imports this.

const BOOK_WORDS = { swing: 'SWING', long_term: 'LONG-TERM' }

export const HOUSE_INDUSTRIES_TOOL_SPEC = {
    get_house_industries: `The HOUSE'S INDUSTRIES for a book — the GICS sub-industries Pythia (the house's industry desk) currently rates FOR SWING or FOR LONG TERM, plus the industries inside the themes it rates so, each with its thesis, its top risk and how far it has moved. Pass \`book\` ("swing" or "long_term", and optionally \`sector\`) on a swing or long-term scan, BEFORE you screen: these are the first place to look. Then pass \`industry\` (a code or name from that list) for its largest companies, our coverage marked. A PREFERENCE, never a filter: screen the rest of the market as you always do, rank by the tape as you always do — being on the house's list adds nothing to a score — and keep a stronger name from outside these industries. Label every name you take from here as on the house's swing / long-term list. Intraday and day scans have no house list: Pythia's verdicts run weeks to years.`,
}

export const SCAN_WORDS = Object.freeze({
    empty:  (book, where) => `The house has no industries rated for ${BOOK_WORDS[book].toLowerCase()}${where} right now (none rated, or every verdict is due for reassessment). Scan the market as you normally would, and say in one line that there was no house list to start from.`,
    footer: (book) => `Look here FIRST — \`get_house_industries\` with \`industry\` lists one's largest companies; these are GICS names, which the screener does not know, so never pass them to \`screen_candidates\` — then screen the rest of the market as usual, in the screener's own names. A preference, not a filter: the tape still ranks, the list adds nothing to a score, and a stronger name from outside these industries stays. Label each name you take from here "on the house's ${book === 'swing' ? 'swing' : 'long-term'} list". "Who else it reaches" is the house's second-order read — the suppliers, customers or neighbours its view spills into: a place to look as good as the industry itself, neither preferred. The house judges industries, not stocks: whether a name is priced in is yours to check.`,
    noBook: (v) => `The house has no list for "${v}". Pythia's verdicts are for swing (weeks to months) and long term (years); an intraday or day scan has no house list — scan the market as you normally would.`,
    failed: (err) => `Could not read the house's industries: ${err.message} — scan the market as you normally would.`,
})
