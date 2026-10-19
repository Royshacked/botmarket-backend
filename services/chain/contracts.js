// Who receives a hand-off, and the sentence it opens on (unified-chat plan phase 5c, G3).
//
// The brief lives with the RECEIVER, not the sender — the inversion the client's contracts made, kept.
// The openers used to live in two panels (MentorPanel's "I want to work on a X trade…", AnalystPanel's
// queue prompt) and in Atlas's contract (briefCoverage); they are here now, the one place a chain turn's
// prompt is written. The hand-off message carries the text (what the receiver reads as the user turn) and
// the input (a seed the desk reads as data).

import { KIND } from './artifact.js'

const trimDot = (s) => (typeof s === 'string' ? s.trim().replace(/\.+$/, '') : '')

/** Argus's single pick → Mentor builds the trade on it. */
function briefMentor(artifact) {
    const pick = artifact.items[0] ?? {}
    const read = trimDot(pick.thesis || pick.analysis)
    return {
        text:  read
            ? `I want to work on a ${pick.ticker} trade — the read on it is: ${read}. Let's build the setup together.`
            : `I want to work on a ${pick.ticker} trade. Let's build the setup together.`,
        input: { seed: { ticker: pick.ticker, direction: pick.direction ?? null, thesis: pick.thesis ?? null, analysis: pick.analysis ?? null, recommended_mode: pick.recommended_mode ?? null } },
    }
}

/** A research queue → Prometheus researches ONE name per turn, told what follows and what else is on the list. */
function briefAnalyst(artifact, index = 0) {
    const names  = artifact.items.map(c => c.ticker).filter(Boolean)
    const ticker = names[index]
    const rest   = names.slice(index + 1)
    const { bySector = [], sector = null, pool = [] } = artifact.context ?? {}
    const sleeve = bySector.find(s => s.names?.includes(ticker))?.sector ?? sector
    const cand   = artifact.items.find(c => c?.ticker === ticker) ?? {}
    const others = pool.filter(t => t !== ticker && !names.includes(t))
    const lines  = [`Research ${ticker} for coverage${sleeve ? ` — it is a candidate for the ${sleeve} sleeve` : ''}.`]
    if (rest.length)   lines.push(`This is one of ${names.length - index} from the same sleeve — ${rest.join(', ')} follow after it. Do ${ticker} only for now.`)
    if (others.length) lines.push(`Also on the list but not queued: ${others.join(', ')}. Only research one of those if the user asks.`)
    return { text: lines.join(' '), input: { seed: { ticker, sector: sleeve, thesis: cand.thesis ?? null, analysis: cand.analysis ?? null } } }
}

/**
 * A finished research run → the words Atlas opens the allocation on. What it must carry is what did NOT
 * come back — Atlas reads the coverage itself, but cannot see an empty sleeve or a declined name.
 */
function briefPortfolio(artifact) {
    const { unfilled = [], declined = [] } = artifact.context ?? {}
    const group = (rows) => {
        const by = new Map()
        for (const r of rows) { const k = r.sector ?? ''; if (!by.has(k)) by.set(k, []); by.get(k).push(r.ticker) }
        return [...by].map(([sector, ts]) => `${ts.join(', ')}${sector ? ` (${sector})` : ''}`).join('; ')
    }
    const lines = [artifact.items.length ? `Coverage is in for ${group(artifact.items)}. Build from it.` : 'No coverage was initiated on this run.']
    if (unfilled.length) lines.push(`These sleeves came back with NOTHING screened: ${unfilled.join(', ')}.`)
    if (declined.length) lines.push(`Screened but NOT researched (no coverage initiated): ${group(declined)}.`)
    if (unfilled.length || declined.length) {
        lines.push('Do not fill those buckets from another sleeve\'s names — say what is unfilled and give me the choice: widen the sleeve and re-screen, drop it, or reallocate its weight across the rest.')
    }
    return { text: lines.join(' '), input: {} }
}

/** The agent that receives an artifact: a kind has exactly one, a candidate list's depends on its use. */
export function receiverOf(artifact) {
    if (artifact?.kind === KIND.COVERAGE_SET) return 'portfolio'
    if (artifact?.kind === KIND.CANDIDATE_LIST) return artifact.context?.queued ? 'analyst' : 'mentor'
    return null
}

/** The receiver's opening for this artifact (and, for a queue, this position in it). */
export function briefFor(artifact, { index = 0 } = {}) {
    const to = receiverOf(artifact)
    if (to === 'mentor')    return briefMentor(artifact)
    if (to === 'analyst')   return briefAnalyst(artifact, index)
    if (to === 'portfolio') return briefPortfolio(artifact)
    return null
}
