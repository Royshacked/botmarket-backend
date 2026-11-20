// QUESTIONS UP FRONT (docs/design/modes-and-builders.md M5/M6, step 4 — Roy, 2026-11-20): a builder starting a NEW build
// asks everything it needs on ONE card — Claude-CLI style: several questions, options + "Other", submit — instead of in
// prose, one turn at a time. The card is built HERE, by code (a model writing JSON on Luna is not a contract); the
// answers become the builder's opening, with the account the user picked.
//
//   a card:     { id, header, question, options: [{ label, description? }], multiSelect, other, kind? }
//               kind 'account' — the client fills the options from the workspace's accounts (the workspace is the
//               client's scope; the server never picks it)
//   an answer:  { [id]: { choice?: string | string[], other?: string, accountId?: string, accountLabel?: string } }
//
// Pure, but for nothing: the session writes are the caller's (sessionTurn, modes, answers).

import { sizeWords } from '../userProfile.service.js'

/** The builders that ask up front. The analyst asks nothing (M5). */
export const ASKS = Object.freeze(['mentor', 'portfolio'])

const SURPRISES = {
    id: 'surprises', header: 'Surprises', question: 'When something comes up mid-build that these answers do not cover?', multiSelect: false, other: false,
    options: [
        { label: 'Decide for me', description: 'Take it all the way and tell me what you chose' },
        { label: 'Ask me', description: 'Stop and ask before any choice these answers do not settle' },
    ],
}
const ACCOUNT = (multi) => ({
    id: 'account', header: 'Account', kind: 'account', multiSelect: multi, other: false, options: [],
    question: multi ? 'Which account or accounts does it go to?' : 'Which account does it go to?',
})

/**
 * The trader's card. `symbol`: the name the build already has (a route's, a hand-off's) — offered first. `size`: the
 * user's last size (user_profile) — offered as an option.
 */
export function traderQuestions({ symbol = null, size = null } = {}) {
    const sym = String(symbol ?? '').toUpperCase().trim()
    const last = sizeWords(size)
    return [
        {
            id: 'name', header: 'Name', question: 'Which stock?', multiSelect: false, other: true,
            options: [
                ...(sym ? [{ label: sym, description: 'The name you came with' }] : []),
                { label: 'Find one for me', description: 'The stock picker finds two or three names; you pick one' },
            ],
        },
        ACCOUNT(false),
        // The trader needs THREE numbers (his opening's one question): a "last time" that carried only one of them sent the
        // build back to the user for the other two (the drive, 2026-11-20) — so each is its own question.
        {
            id: 'size', header: 'Size', question: 'How big is the position?', multiSelect: false, other: true,
            options: size && /^size_/.test(size.unit) ? [{ label: `As last time: ${last}` }] : [],
        },
        {
            id: 'risk', header: 'Risk', question: 'How much do you lose if the stop is hit?', multiSelect: false, other: true,
            options: [
                ...(size && /^risk_/.test(size.unit) ? [{ label: `As last time: ${last}` }] : []),
                { label: '0.5% of the account' }, { label: '1% of the account' }, { label: '2% of the account' },
            ],
        },
        {
            id: 'rr', header: 'Min R:R', question: 'The least reward-to-risk worth taking?', multiSelect: false, other: true,
            options: [{ label: '1.5' }, { label: '2' }, { label: '3' }],
        },
        {
            id: 'scenarios', header: 'Scenarios', question: 'Which scenarios should the trade carry?', multiSelect: false, other: false,
            options: [
                { label: 'Both (recommended)', description: 'The regular entry, and the break scenario if it fails' },
                { label: 'A only', description: 'The regular entry' },
                { label: 'B only', description: 'The break scenario' },
            ],
        },
        {
            id: 'invalidation', header: 'If it breaks', question: 'If the stop breaks the thesis, or the trade runs away before it fills?', multiSelect: false, other: false,
            options: [
                { label: 'Redraw it', description: 'Re-check the whole trade and draw it again' },
                { label: 'Close it', description: 'Stand down — no redraw' },
                { label: 'Ask me', description: 'Tell me, and I decide then' },
            ],
        },
        SURPRISES,
    ]
}

/** The portfolio manager's card — the mandate (portfolio prompt §1), the account(s), the policy. */
export function portfolioQuestions() {
    return [
        {
            id: 'objective', header: 'Objective', question: 'What is the portfolio for?', multiSelect: false, other: true,
            options: [{ label: 'Growth' }, { label: 'Income' }, { label: 'Balanced' }, { label: 'Capital preservation' }],
        },
        {
            id: 'horizon', header: 'Horizon', question: 'Over what horizon?', multiSelect: false, other: false,
            options: [{ label: 'Tactical', description: 'Weeks' }, { label: 'Swing', description: 'Months' }, { label: 'Strategic', description: 'Years' }],
        },
        {
            id: 'drawdown', header: 'Drawdown', question: 'The most it may fall from a peak before you would act?', multiSelect: false, other: true,
            options: [{ label: '10%' }, { label: '20%' }, { label: '30%' }],
        },
        { id: 'capital', header: 'Capital', question: 'How much capital goes in?', multiSelect: false, other: true, options: [] },
        {
            id: 'constraints', header: 'Constraints', question: 'Anything it must or must not hold?', multiSelect: false, other: true,
            options: [{ label: 'No constraints' }],
        },
        ACCOUNT(true),
        SURPRISES,
    ]
}

/** The card for a builder, or null when it asks nothing. */
export function questionsFor(agent, ctx = {}) {
    if (agent === 'mentor') return traderQuestions(ctx)
    if (agent === 'portfolio') return portfolioQuestions(ctx)
    return null
}

/**
 * Is a card due? Only for a NEW build: a builder that asks, on a user's turn, a route's opening or the picker, with
 * nothing on its table, not editing a saved item, not working for a chain, and not already asked in this build.
 */
export function needsQuestions(agent, state, origin, input = null) {
    if (!ASKS.includes(agent)) return false
    if (origin !== 'user' && origin !== 'opening' && origin !== 'mode') return false
    // The answers' own turn, or a press on the builder's work, is never a new build.
    if (input?.answered || input?.ops) return false
    const s = state ?? {}
    if (s.asking || s.editing || s.chainId) return false
    // A build already on this builder's table (in the background, ready, waiting for the user) — not a new one.
    if (s.build && s.build.status !== 'failed') return false
    // Already asked in THIS build: the user talking on with the builder. A new route or the picker, with nothing on the
    // table, starts a new build (a build that ended in "no setup" left `asked` behind).
    if (s.asked && origin === 'user') return false
    if (agent === 'mentor') return !s.draft
    if (agent === 'portfolio') return !s.mandate && !s.portfolioId && !s.reviewMode && !s.adoptDraftId && !s.pendingPlan && !s.reviewUpdate
    return false
}

const MAX_OTHER = 400

/**
 * Check the answers against the card. → `{ ok: true, answers }` (cleaned) or `{ ok: false, reason }`. Every question
 * must be answered: a choice among its options, or "Other" text where it allows it; an account question by an id.
 */
export function checkAnswers(questions, raw) {
    if (!Array.isArray(questions) || !raw || typeof raw !== 'object') return { ok: false, reason: 'invalid_answers' }
    const out = {}
    for (const q of questions) {
        const a = raw[q.id] ?? {}
        if (q.kind === 'account') {
            const ids = (Array.isArray(a.accountIds) ? a.accountIds : a.accountId ? [a.accountId] : []).map(String).filter(Boolean).slice(0, 10)
            if (!ids.length) return { ok: false, reason: `unanswered:${q.id}` }
            if (!q.multiSelect && ids.length > 1) return { ok: false, reason: `one_account:${q.id}` }
            out[q.id] = { accountIds: ids, accountLabel: String(a.accountLabel ?? '').slice(0, 120) || null }
            continue
        }
        const labels = q.options.map(o => o.label)
        const picked = (Array.isArray(a.choice) ? a.choice : a.choice != null ? [a.choice] : []).map(String).filter(c => labels.includes(c))
        const other = q.other ? String(a.other ?? '').trim().slice(0, MAX_OTHER) : ''
        if (!picked.length && !other) return { ok: false, reason: `unanswered:${q.id}` }
        out[q.id] = { choice: q.multiSelect ? picked : (picked[0] ?? null), other: other || null }
    }
    return { ok: true, answers: out }
}

/** One answer in words. */
function words(q, a) {
    if (q.kind === 'account') return a.accountLabel ?? 'the account I picked'
    const chosen = Array.isArray(a.choice) ? a.choice.join(', ') : a.choice
    return [chosen, a.other].filter(Boolean).join(' — ')
}

/**
 * The answers as the builder's opening — what it reads as the user's message. `opening`: what the user said before the
 * card (a route's opening, the first message), kept above the answers.
 */
export function answersText(agent, questions, answers, opening = null) {
    const lines = questions.map(q => `- ${q.question} ${words(q, answers[q.id] ?? {})}`)
    const decide = answers.surprises?.choice === 'Decide for me'
    const tail = agent === 'mentor'
        ? `${decide ? 'Take it all the way: build it and generate it, telling me what you chose.' : 'Build it, and ask me before any choice these answers do not settle.'} If there is no trade to build, say so in one line that starts with "No trade:" and why.`
        : (decide ? 'Build it all the way and tell me what you chose.' : 'Build it, and ask me before any choice these answers do not settle.')
    return [
        opening ? `${opening}\n` : '',
        'My answers to the build questions (asked up front — do not ask them again):',
        ...lines,
        tail,
    ].filter(Boolean).join('\n')
}
