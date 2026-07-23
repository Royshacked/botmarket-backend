# Project Context
AI-powered trading assistant backend (ar2trade / TRADVICE) — Express + MongoDB +
multi-provider LLM agents (Anthropic / OpenAI). Three conversational agents
(Trade, Portfolio, Scanner) turn natural-language chat into monitored trade ideas,
which a background monitor evaluates against condition trees and routes to a broker
(cTrader live, a paper/simulation venue, or IBKR in progress) through one unified
capability-flag adapter layer. Real-time via SSE (agent streams) and WebSocket
(social chat). See README.md for the full architecture and app-flow diagrams.

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
  single "unifier"/router. Example: all agents post notifications through the one
  `sendBotMessage` transport, but each still builds its own card copy/payload.

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
