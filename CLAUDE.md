# Project Context
AI-powered trading assistant backend (ar2trade / TRADVICE) — Express + MongoDB +
LLM agents on Anthropic Claude (OpenAI for transcription only). SEVEN conversational desks — Axl
(reception) · Mentor (`setup`, the trader) · Atlas (portfolio) · Argus (finds ONE name for Mentor; his scan lists were archived 2026-11-09) ·
Prometheus (`coverage`) · Pythia (`industry_view`) · Proteus (how a stock trades, measured — 2026-11-12) — turn natural-language chat into monitored
work, which each kind's own background monitor evaluates against condition trees before
routing to a broker (cTrader live, a paper/simulation venue, manual, or IBKR in progress)
through one unified capability-flag adapter layer. Nothing reaches a broker while its
venue is shut — a confirmed decision is queued, never fired and never lost. Real-time via
SSE (agent streams) and WebSocket (social chat). Their work lands on one execution tier: the
`idea` kind (`/api/trade-ideas`, which portfolio holdings ride) plus the per-desk kind
`setup`. See README.md for the full architecture and app-flow diagrams.

**Kairos (the `call` kind) and its monitor Hermes were DELETED on 2026-11-10**, code and data
(`scripts/delete-kairos.mjs`); `git log` before that date has them. A new trade is always Mentor's.

**Minos (the legacy `idea` monitor) was DELETED**, not archived. The `idea` KIND stays and must:
it is the execution tier every order goes through, and a portfolio holding IS an idea document
carrying a `portfolioId` (`kindForDoc`). Deleting the kind deletes Atlas and all order placement.

**THREE WORKSPACES — `live` · `paper` · `manual`** — are the book the user is standing in,
and every one is real to them. Live is real money at a connected broker; paper is
simulated; manual is real money at an institution the app cannot reach (built and monitored
exactly like paper, but the user places the order at their bank and confirms the fill).
Entities that bind to an ACCOUNT — `setup`, `portfolio` — belong to exactly one
workspace and must be scoped to it everywhere they are shown or reported. Research binds to
no account: scans, coverage and the house forecast are SHARED across all three. The
workspace is a UI/authoring scope and NEVER an engine filter — the monitors and the
reconciler must keep processing every mode, or a live stop stops firing while the user is
looking at paper.

# Rules
- Always write tests after implementing a feature
- Follow existing naming conventions (see CODE_MAP.md)
- After each feature, check for conflicts with shared state
- At milestones, prompt me to run the QA/CR/docs update cycle
- Shared mechanism → one service. When two or more callers need the same
  *mechanism* — a transport, a data fetch, a formatter, a parser — route them
  through ONE shared service instead of duplicating (or subtly diverging) the
  logic. Before adding a second copy, look for the existing one and extend it.
  Nuance: share the pipe, not the judgment. Per-domain *decisions* stay owned by
  their agent (see the data-vs-judgment principle) — do NOT merge them into a
  single "unifier"/router. Example: every notification goes out through the one
  `postCard` → `postBotCard` transport, but each desk still builds its own card
  copy/payload. (This example used to name `sendBotMessage`; that is a
  back-compat alias with no caller outside chat.service.)

# Inner QA Loop (run after every implementation)
After producing any code, before considering the task done, check:
1. Does this match existing patterns in the codebase?
2. Does this introduce an unnecessary dependency?
3. Is this more complex than it needs to be — can it be simpler?
4. What existing functionality could this break?
5. Is error handling consistent with the rest of the app?
6. Are there any shared state or side effects that weren't accounted for?

If any of these raise a concern, flag it to the user before moving on.
Do not silently proceed if something feels inconsistent.

# Bug Hunt (run after every new feature)
After implementing a feature, switch to bug-hunting mode:
1. Re-read the code you just wrote as if you didn't write it
2. Look for:
   - Logic errors — does the code actually do what it claims?
   - Edge cases — null/undefined, empty arrays, 0, negative numbers
   - Async issues — race conditions, unhandled promises, missing await
   - State mutations — anything modified that shouldn't be
   - Error paths — what happens when things fail, not just when they succeed
   - Security — unsanitized input, exposed sensitive data, broken auth checks
3. Write a short report: what you found, severity (high/medium/low), suggested fix
4. Ask me before applying any fix

# Conflict Check (run after every new feature)
After the bug hunt, check how the new feature interacts with the rest of the app:
1. Does it touch any shared state, context, or global variables?
2. Does it call or modify any functions used elsewhere?
3. Does it affect any existing routes, APIs, or data models?
4. Could it change behavior that existing tests rely on?

Flag any conflicts found before moving on. Do not silently proceed.

# Docs
- App spec: APP_SPEC.md
- Code map: CODE_MAP.md
