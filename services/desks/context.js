// What ONE agent reads on a session turn (unified-chat.md §3.2, plan phase 4 §6.1 step 3).
//
// The user sees the whole chat; each model sees only what it needs:
//   1. its sealed context, when it is editing the entity that context belongs to (agent_contexts);
//   2. its rolling summary, as one leading user turn;
//   3. its own segment of the session after the summary's `throughSeq` — its turns and the hand-offs
//      addressed to it (session.util.segmentOf). A hand-off TO the agent reads as a `user` turn
//      (someone asking it); everything it said itself stays `assistant`.
//
// Pure: the caller loads the rows. The desk's agent then runs `normalizeMessages` on the result, which
// coalesces neighbouring same-role turns and trims to its maxMessages exactly as on the HTTP path.

import { segmentOf, contextRole } from '../session.util.js'

const SEALED_LEAD  = 'Earlier, on this item (summary): '
const SUMMARY_LEAD = 'Earlier in this conversation (summary): '

/**
 * @param {{ messages: object[], agent: string, summary?: { text: string, throughSeq: number } | null,
 *           sealed?: { messages?: object[], summary?: string|null } | null }} p
 * @returns {{ role: 'user'|'assistant', content: string }[]}
 */
export function buildConversation({ messages, agent, summary = null, sealed = null }) {
    const out = []
    if (sealed) {
        if (sealed.summary) out.push({ role: 'user', content: SEALED_LEAD + sealed.summary })
        for (const m of sealed.messages ?? []) {
            if ((m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string') out.push({ role: m.role, content: m.content })
        }
    }
    if (summary?.text) out.push({ role: 'user', content: SUMMARY_LEAD + summary.text })

    const through = Number.isFinite(summary?.throughSeq) ? summary.throughSeq : 0
    // The tools behind the agent's last reply(ies), said on the turn that follows them (toolNote).
    let trace = []
    for (const m of segmentOf(messages, agent)) {
        if (Number.isFinite(m.seq) && m.seq <= through) continue
        const role = contextRole(m, agent)
        if (role === 'assistant') {
            for (const t of Array.isArray(m.tools) ? m.tools : []) if (!trace.includes(t)) trace.push(t)
            out.push({ role, content: m.content })
            continue
        }
        out.push({ role, content: trace.length ? `${toolNote(trace)}\n\n${m.content}` : m.content })
        trace = []
    }
    return out
}

/**
 * The history holds a reply's TEXT, never the tool calls behind it — so on the next turn the model saw its own exact
 * figures with no source and, asked "how did you do it so fast?", called a measured profile made up (Proteus, NVDA,
 * 2026-11-13). This note goes on the turn AFTER such a reply — in the user's slot, marked as the app's, so it is not a line
 * the model learns to write itself. Pure; exported for tests.
 */
export function toolNote(trace) {
    return `[App note, not the user's words: your previous reply was written from these tool calls — ${trace.join('; ')}. ` +
        `Their results are not repeated here, but the figures in that reply came from them. Asked where a figure came from, ` +
        `name the tool; never call it made up or unsupported unless you check it again and it is different.]`
}
