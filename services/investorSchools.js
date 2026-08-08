// The single source of truth for the INVESTOR SCHOOLS (docs/design/investor-schools.md) — how a book
// is picked, and how it is weighted.
//
// TWO AXES, not one enum, because they are not the same kind of thing: selection answers *which names
// qualify*, allocation answers *how risk is spread*. Risk parity has essentially no stock-picking
// view; folding it into a selection enum would make it fake one. Buffett = conviction-weighted +
// quality-value. All Weather = risk-balanced + passive.
//
// A school selects vocabulary and a rule. It NEVER touches the output schema — <portfolio_plan>,
// <portfolio_mandate> and the order layer are unchanged, so Themis and execution never learn schools
// exist. Same contract as Kairos's modes (kairos.modes.js).
//
// OWNERSHIP. Atlas sets both, on the mandate. Argus inherits the SELECTION half on the sleeve
// hand-off and nothing else — a screener has no business knowing how risk is spread. The allocation
// half never leaves Atlas: it is the Phase-5 weighting rule.
//
// THE TRAP, restated where it will be read: a school is fitted to the MANDATE, never to the current
// market state. It is a durable stance held ACROSS regimes. Switch it on a regime signal and the
// review breaks — holdings are judged against their frozen thesis, so a name bought on moat-and-
// margin-of-safety, re-read under a risk-parity lens, looks wrong for reasons that have nothing to do
// with the company. Regime moves the WEIGHTS (Phase 2's read → Phase 3's over/underweights), never
// the worldview.

export const ALLOCATION_SCHOOLS = ['conviction-weighted', 'risk-balanced', 'benchmark-relative']
export const SELECTION_SCHOOLS  = ['quality-value', 'growth-durability', 'income', 'passive']

// Unknown or absent → null, NOT a default. The caller decides what "no school" means, and for both
// callers it means "behave exactly as the desk did before schools existed": Phase 5's formula was
// conviction-weighted written as though it were the only way to size, and the screen's ranking was a
// quality/valuation blend. A mandate written before this feature must not silently acquire a stance.
export function normalizeAllocation(v) { return ALLOCATION_SCHOOLS.includes(v) ? v : null }
export function normalizeSelection(v)  { return SELECTION_SCHOOLS.includes(v)  ? v : null }

// ─── The rules (the prompt text each school contributes) ────────────────────────
// One entry per value: `summary` is the one-line menu form Atlas chooses from; `rule` is what governs
// once chosen; `review` is the question the book is re-read against — the thing a school buys us more
// than construction ever does.

export const ALLOCATION_RULES = {
    'conviction-weighted': {
        summary: 'size by conviction against volatility — best ideas are visibly bigger',
        rule: [
            'Weight by conviction per unit of risk: `raw_weight_i = conviction.score_i / σ_i`, then normalize.',
            'Concentration is the POINT, not a side effect — if your best idea does not end up visibly',
            'larger than your fifth, you have not expressed a view. A high-vol name needs meaningfully',
            'higher conviction to carry the same weight as a low-vol one.',
        ].join(' '),
        review: 'is the conviction that earned this weight still there?',
    },
    'risk-balanced': {
        summary: 'equalize risk contribution — no view on which name is best',
        rule: [
            'Equalize RISK contribution, not capital: `raw_weight_i = 1 / σ_i`, normalized, with NO',
            'conviction term. You are deliberately refusing to say which name is best, so do not smuggle',
            'the view back in as a tilt. Correlation matters more here than under any other rule — two',
            'names at equal σ that move together are one position wearing two tickers, and the book is',
            'only balanced if the risk is actually independent.',
        ].join(' '),
        review: 'has risk drifted out of balance?',
    },
    'benchmark-relative': {
        summary: 'start from the index and take deliberate over/underweights',
        rule: [
            "Start from the benchmark's weights; every position is an active bet measured in points",
            'against it. A name held at benchmark weight is a NEUTRAL, not a holding — say so rather than',
            'counting it as conviction. Each overweight must name what it is being paid for, and the sum',
            'of the active bets is the risk you are actually running.',
        ].join(' '),
        review: 'is each active weight still earning its tracking error?',
    },
}

export const SELECTION_RULES = {
    'quality-value': {
        summary: 'a durable advantage bought with a margin of safety',
        rule: [
            'The bar: returns on capital that PERSIST, margins that survive a cycle, a balance sheet that',
            'can wait — and then a price below what the business is worth. Both halves are required: a',
            'great business at an absurd price is a watch, not a buy, and a cheap bad business is a value',
            'trap. Growth is welcome but is not the case.',
        ].join(' '),
        review: 'has the moat eroded?',
    },
    'growth-durability': {
        summary: 'growth that lasts, not growth that is fast',
        rule: [
            'The bar: a structural driver with visible runway, evidence the growth is durable rather than',
            'a one-off, and unit economics that improve with scale. Pay up only where the durability is',
            'evidenced — a high multiple on growth you cannot underwrite past next year is a momentum bet',
            'wearing a thesis.',
        ].join(' '),
        review: 'has the runway shortened?',
    },
    income: {
        summary: 'cash returned, and safe',
        rule: [
            'The bar: a payout covered by free cash flow with room to spare, a balance sheet that can',
            'sustain it through a downturn, and a yield that is not a distress signal — an unusually high',
            'one is the market pricing a cut, so treat coverage as the screen and yield as the result.',
        ].join(' '),
        review: 'is the payout still covered?',
    },
    passive: {
        summary: 'no stock picking — take the exposure, spend the effort on allocation',
        rule: [
            'Take the exposure through broad, cheap instruments and put the work into the allocation',
            'instead. NEVER emit a <screen_request> under this school — there is nothing to screen, and',
            'handing a sleeve to Argus here is itself the error. If a mandate needs single names, it is',
            'not passive; say so and change the school with the user rather than quietly picking stocks.',
        ].join(' '),
        review: 'is the exposure still the one the mandate wants?',
    },
}

// ─── Combinations that fight themselves ─────────────────────────────────────────
// The cost of two axes is that incoherent pairs are expressible. Atlas must SAY so rather than
// silently build something confused — the pair is the user's to resolve, not ours to quietly drop.
const INCOHERENT = [
    {
        allocation: 'risk-balanced', selection: 'quality-value',
        why: 'risk parity refuses to say which name is best, while quality-value is built on exactly that judgment. A concentrated moat book cannot also be risk-balanced — name which one governs before constructing.',
    },
    {
        allocation: 'conviction-weighted', selection: 'passive',
        why: 'conviction-weighted sizing needs a per-name conviction, and a passive selection has none by construction. Either the book picks names, or the weights stop expressing a view.',
    },
]

/** The warning for an incoherent pair, or null. Pure. */
export function incoherentCombo(allocation, selection) {
    const a = normalizeAllocation(allocation)
    const s = normalizeSelection(selection)
    if (!a || !s) return null
    return INCOHERENT.find(c => c.allocation === a && c.selection === s)?.why ?? null
}

// ─── The injected block ─────────────────────────────────────────────────────────
// Atlas CHOOSES its school mid-conversation (unlike a Kairos mode, which arrives with the request),
// so the block has to serve both moments: the menu while nothing is chosen, the governing rule once
// it is. Keeping both here — rather than a menu in the prompt and rules in a module — is what stops
// the two copies from drifting.

function _menu(title, rules, order) {
    return [`${title} — pick ONE:`, ...order.map(k => `  - \`${k}\` — ${rules[k].summary}`)].join('\n')
}

/**
 * The INVESTMENT SCHOOL context block for a mandate, or null when there is nothing useful to say.
 * Renders the chosen rule per axis and the menu for whichever axis is still open.
 *
 * `menu: false` suppresses the offer entirely — pass it when the user is NOT establishing a mandate
 * (a review of an existing book). A school is chosen at intake; a book built before schools existed
 * should be reviewed against the thesis it actually has, not have a stance retro-fitted onto it
 * halfway through its life, which is the same frozen-thesis break as switching one on a regime signal.
 */
export function buildSchoolSection(mandate, { menu = true } = {}) {
    const allocation = normalizeAllocation(mandate?.allocation)
    const selection  = normalizeSelection(mandate?.selection)
    if (!menu && !allocation && !selection) return null
    const lines = ['INVESTMENT SCHOOL (two axes — the durable stance this book is built and reviewed against):']

    if (selection) {
        lines.push(`\nSELECTION = \`${selection}\` — ${SELECTION_RULES[selection].summary}.`)
        lines.push(SELECTION_RULES[selection].rule)
        lines.push(`At review this book is re-read against: ${SELECTION_RULES[selection].review}`)
    } else if (menu) {
        lines.push('\n' + _menu('SELECTION (which names qualify) is not set yet', SELECTION_RULES, SELECTION_SCHOOLS))
    }

    if (allocation) {
        lines.push(`\nALLOCATION = \`${allocation}\` — ${ALLOCATION_RULES[allocation].summary}.`)
        lines.push(ALLOCATION_RULES[allocation].rule)
        lines.push(`At review this book is re-read against: ${ALLOCATION_RULES[allocation].review}`)
    } else if (menu) {
        lines.push('\n' + _menu('ALLOCATION (how risk is spread) is not set yet', ALLOCATION_RULES, ALLOCATION_SCHOOLS))
    }

    const clash = incoherentCombo(allocation, selection)
    if (clash) lines.push(`\n⚠ THESE TWO FIGHT EACH OTHER: ${clash}`)

    if (menu && (!allocation || !selection)) {
        lines.push('\nInfer the missing axis from the mandate, state which you chose and WHY in one line, and let the user override it in plain language. Never re-derive a school that is already set — changing it carries the same weight as changing risk tolerance.')
    }
    lines.push('Fit the school to the MANDATE, never to the current market state: the regime moves the weights inside the school, never the school itself.')
    return lines.join('\n')
}

// ─── The selection axis, as Argus's ranking ─────────────────────────────────────
// The mechanical half of the selection school. Argus scores four investing axes; which of them leads
// IS the school. Without this the lens changes only the prose while the ranking stays identical — a
// costume, not a stance.
//
// `default` is the pre-schools blend, kept byte-identical so a screen with no lens ranks exactly as
// it always did. `passive` deliberately has no entry: it never screens, so if one ever arrives here
// something upstream is wrong and the neutral blend is the safe landing.
export const SELECTION_WEIGHTS = {
    default:             { quality: 0.30, valuation: 0.30, growth: 0.25, balance_sheet: 0.15 },
    'quality-value':     { quality: 0.35, valuation: 0.35, growth: 0.10, balance_sheet: 0.20 },
    'growth-durability': { quality: 0.30, valuation: 0.15, growth: 0.40, balance_sheet: 0.15 },
    income:              { quality: 0.25, valuation: 0.25, growth: 0.15, balance_sheet: 0.35 },
}

/** Ranking weights for a selection lens; unknown/absent/passive → the neutral blend. Pure. */
export function selectionWeights(lens) {
    return SELECTION_WEIGHTS[normalizeSelection(lens)] ?? SELECTION_WEIGHTS.default
}
