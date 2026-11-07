// WHAT THE EARNINGS RELEASE SAYS ABOUT GUIDANCE — test O (Roy, 2026-11-07, screener-lab.md §33). Historical guidance is on
// no feed we pay for (FMP transcripts 402, Massive's guidance 403, Finnhub 403), but companies file the release with the
// SEC. It states a DIRECTION in about 2 in 5 releases ("raises full-year guidance"). The rest give numbers only, or nothing,
// and judging numbers needs the estimate of the day, which we do not have: those stay unclassified.
//
// Pure: no IO.

const _days = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000)

/** The 8-K with item 2.02 filed from the day before the report to 3 days after, nearest first. `list` `[{ filed, ... }]`. Pure. */
export function nearestEarnings8k(list, report) {
    return list
        .map(f => ({ f, gap: _days(f.filed, report) }))
        .filter(x => x.gap >= -1 && x.gap <= 3)
        .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap))[0]?.f ?? null
}

/**
 * The press release among a filing's files: named exhibit 99.1 first, then any other exhibit 99 that is not a presentation,
 * then a page named like a release, then the largest other page. Not the 8-K's own cover (`primary`). Pure.
 */
export function pickExhibit(items, primary) {
    const pages = items.filter(x => /\.html?$/i.test(x.name) && !/index/i.test(x.name) && x.name !== primary)
    if (!pages.length) return null
    const talk = /present|slide|deck|supplement/i
    return (pages.find(x => /99[-_.]?0?1(\D|$)/.test(x.name) && !talk.test(x.name))
        ?? pages.find(x => /99/.test(x.name) && !talk.test(x.name))
        ?? pages.find(x => /press|release|earn/i.test(x.name) && !talk.test(x.name))
        ?? [...pages].sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0]).name
}

const ENTITY = { nbsp: ' ', amp: '&', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', bull: '•', quot: '"', apos: "'" }
const _code = (c) => (c === 160 ? ' ' : String.fromCodePoint(c))

/** HTML → plain text on one line. Pure. */
export function plainText(html) {
    return String(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => _code(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => _code(Number(d)))
        .replace(/&([a-z]+);/gi, (m, e) => ENTITY[e.toLowerCase()] ?? m)
        .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
        .replace(/\s+/g, ' ').trim()
}

const BOILERPLATE = /forward[- ]looking|safe harbor|risks? and uncertaint|looking statements|actual results|undue reliance|no obligation to update|not undertake/i
const WORDS = /\b(guidance|outlook|forecasts?|full[- ]year|fiscal (year )?20\d\d)\b/i
const MAX_LINES = 25, MAX_LINE = 450

// ─── The direction ────────────────────────────────────────────────────────────────────────────────────────────
//
// A verb next to a guidance word, either order: "raises full-year guidance", "guidance was increased". The verb alone is
// not enough ("higher than initial guidance" grades a result against the old guidance, it moves nothing).

// "raised its revenue expectations", "increased its target for adjusted EPS" (hand check, 2026-11-07: both read as numbers).
const G = '(guidance|outlook|forecasts?|financial targets|targets? for|expectations?)'
// No comma inside the span: "guidance range, while maintaining a margin" is two clauses, not one statement.
const _near = (verbs) => new RegExp(`\\b(${verbs})\\b[^.;:,]{0,70}\\b${G}|\\b${G}\\b[^.;:,]{0,40}\\b(is |was |has been |have been |being )?(${verbs})\\b`, 'i')
// No "improving": 'Outlook "We anticipate that improving market conditions…"' is commentary under a heading (2nd hand check).
const UP = _near('rais(e|es|ed|ing)|increas(e|es|ed|ing)|lift(s|ed|ing)?|boost(s|ed|ing)?|upgrad(e|es|ed|ing)')
const DOWN = _near('lower(s|ed|ing)?|reduc(e|es|ed|ing)|cut(s|ting)?|downgrad(e|es|ed|ing)|withdr(aw|aws|awing|ew|awn)|suspend(s|ed|ing)?|trim(s|med|ming)?|lowers')
const HOLD = _near('reaffirm(s|ed|ing)?|reiterat(e|es|ed|ing)|maintain(s|ed|ing)?|confirm(s|ed|ing)?|unchanged|affirm(s|ed|ing)?')
// Inside the matched span, not the company's own earnings forecast: a dividend, a rate, a rating — and a COST, whose cut is
// good news ("reduced capital expenditures guidance", hand check 2026-11-07: read as a cut).
const NOT_IT = /\bdividend|tax rate|interest rate|rating agenc|credit rating|capital expenditure|capex|expenses?\b|costs?\b|spending/i
const _hit = (re, s) => { const m = s.match(re); return Boolean(m) && !NOT_IT.test(m[0]) }

// "updating its revenue guidance from a range of $23.5 billion to $25.0 billion to a new range of $21.8 billion to $22.6
// billion": the numbers say which way. Two ranges, or two single figures, after a guidance word.
const NUM = '\\$?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(?:%|billion|million|per share)?'
const RANGE = `${NUM}(?:\\s*(?:to|-)\\s*${NUM})?`
const FROM_TO = new RegExp(`\\b(guidance|outlook|expectations?|range)\\b[^.;]{0,80}?\\bfrom (?:a (?:prior )?range of |its prior )?${RANGE}\\s+to (?:a (?:new )?range of |a new )?${RANGE}`, 'i')
const _n = (x) => (x == null ? null : Number(String(x).replace(/,/g, '')))
const _mid = (a, b) => (b == null ? a : (a + b) / 2)

/** The way a stated old → new guidance figure moved: 'up' | 'down' | null. Pure. */
export function numbersDirection(s) {
    const m = String(s ?? '').match(FROM_TO)
    if (!m || NOT_IT.test(m[0])) return null
    const before = _mid(_n(m[2]), _n(m[3])), after = _mid(_n(m[4]), _n(m[5]))
    if (!(before > 0) || !(after > 0) || before === after) return null
    return after > before ? 'up' : 'down'
}

// A rating agency's outlook on the company's credit ("S&P upgraded our outlook to Positive"), not its own forecast.
const AGENCY = /S&P Global|Standard & Poor|Moody'?s|Fitch|credit rating|rating outlook|issuer rating/i

/** One sentence → 'up' | 'down' | 'mixed' | 'hold' | null. Pure. */
export function sentenceDirection(s) {
    if (!s || AGENCY.test(s)) return null
    const up = _hit(UP, s), down = _hit(DOWN, s)
    if (up && down) return 'mixed'
    if (up) return 'up'
    if (down) return 'down'
    return numbersDirection(s) ?? (_hit(HOLD, s) ? 'hold' : null)
}

/**
 * A release's text (guidanceText's) → its guidance: 'raise' | 'cut' | 'mixed' (both, on different lines) | 'maintain' |
 * 'numbers' (guidance words, no direction) | 'none'. The headline decides when it states a direction: a release that
 * leads with "raises guidance" is a raise, whatever line reaffirms one item of it. Pure.
 */
export function guidanceDirection({ lead = '', lines = [] } = {}) {
    const fold = (ds) => {
        const up = ds.includes('up') || ds.includes('mixed'), down = ds.includes('down') || ds.includes('mixed')
        if (up && down) return 'mixed'
        if (up) return 'raise'
        if (down) return 'cut'
        return ds.includes('hold') ? 'maintain' : null
    }
    // The headline: the lead up to its first sentence of body.
    const head = lead.split(/(?<=[.;!?])\s+/).slice(0, 2).join(' ')
    const fromHead = fold(head.split(/\s[•;]\s|;\s/).map(sentenceDirection).filter(Boolean))
    if (fromHead) return fromHead
    const fromLines = fold(lines.map(sentenceDirection).filter(Boolean))
    if (fromLines) return fromLines
    return lines.some(s => /\b(guidance|outlook)\b/i.test(s)) ? 'numbers' : 'none'
}

/** A release → `{ chars, lead, lines }`: its first 800 characters, and the sentences that could state guidance. Pure. */
export function guidanceText(html) {
    const text = plainText(html)
    const lines = text.split(/(?<=[.;:!?])\s+(?=[A-Z•"\d-])|\s•\s/)
        .filter(s => WORDS.test(s) && !BOILERPLATE.test(s))
        .map(s => s.trim().slice(0, MAX_LINE))
        .slice(0, MAX_LINES)
    return { chars: text.length, lead: text.slice(0, 800), lines }
}
