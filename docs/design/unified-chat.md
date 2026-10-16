# Unified chat — every desk in one chat box

**Status: DESIGN — decisions §2 and §6 are Roy's (2026-10-15/16). Nothing built. §5 is a proposed build
order, not decided; §7 is what is still open.**

Relates to: [pipeline-service.md](./pipeline-service.md) (the conveyor and its typed artifacts);
[mentor-flow-intent.md](./mentor-flow-intent.md) (Mentor's ledger, which rides on the conversation);
`botmarket-frontend/docs/hand-offs.md` (how a hop moves between panels today);
`services/thread.service.js`, `services/thread.util.js` (the thread store this replaces);
`services/routing.util.js` (the route grammar every desk shares); `prompts/axl_system_prompt.md`.

## 1. Why

Building something today means moving between rooms. Every desk is its own panel; a hand-off switches the
tab and seeds the next desk with an opening sentence. The user does one piece of work, but the app shows it
as five separate chats. The user should just see one conversation and know who is talking.

## 2. Decisions (Roy, 2026-10-15/16)

| # | Topic | Decision |
|---|---|---|
| 1 | Chat box | ONE timeline. Every message carries its agent (brand, hue, icon from `agentMeta`). |
| 2 | Context | Each agent keeps ITS OWN context: it sees its own segment of the timeline plus the hand-off artifacts addressed to it — never another agent's transcript. |
| 3 | Hand-offs | The artifacts stay exactly as today — `mandate`, `scan_request`, `candidate_list`, `coverage_set`. They now appear in the timeline as one agent turning to another ("Atlas → Argus: scan for me…"), with the artifact as an openable card. The artifact IS the brief; there is no second summary. |
| 4 | Chains | Hops inside a chain run automatically. The chain stops only at a decision that is the user's (§3.4). |
| 5 | Sessions | ONE endless chat per user. "New session" saves the current one to history (like Claude chat) and starts fresh. A session links to every entity it produced — many, not one. |
| 6 | Desk screens | The working surfaces (Mentor's worksheet, Argus's results, Atlas's mandate, Prometheus's coverage, the order ticket) move to a SIDE PANE. |
| 7 | Drafts | Thread drafts are REMOVED. Mentor's setup draft stops being a concept: it is Mentor's in-progress state inside the session. |
| 8 | Desk buttons | REMOVED — the AxlHub desk cards, the chip strip, the order-ticket card and RouteOffer's Go button. |
| 9 | Entry | Axl ASKS what the user wants to do and routes on the answer. |
| 10 | Quick answers | Tap-to-answer options under a question. Any agent may offer them. |

## 3. The design

### 3.1 The timeline

- One message list. A message is `{ agent, role, kind, content, at }`, where `kind` is one of:
  - `msg` — an ordinary turn (user or agent);
  - `handoff` — one agent turning to another, carrying an artifact reference;
  - `decision` — an agent stopping the chain for the user, carrying its decision card (§3.4).
- A user message is addressed to the agent that has the floor (§3.3), and is stored in that agent's segment.
- Rendering: agent glyph + brand on the first message of each run of the same speaker; a hand-off renders as a
  one-line divider with the artifact card ("Argus → Mentor: NVDA").

### 3.2 Per-agent context

The user sees everything; each model sees only what it needs. On every turn the server builds the active
agent's messages from the session:

1. that agent's own messages (user turns addressed to it + its replies);
2. the hand-off artifacts addressed to it, in order;
3. a summary of its own older turns, once its segment grows past a cap (each agent summarises only itself).

Feeding the whole mixed transcript would raise the token bill and confuse the desk prompts (Mentor reading
Atlas's mandate talk). A remark meant to follow the user everywhere ("I hate low-float names") belongs in the
user record Axl will own, not in another agent's context.

This is ONE service (`sessionContext(session, agent)`) every desk calls — the shared pipe. What each desk does
with the context stays in that desk.

### 3.3 Who has the floor

- The agent that spoke last keeps the floor; the next user message goes to it, not back through Axl.
- The floor moves when:
  - an agent hands off (automatic inside a chain, §3.4);
  - the user asks for another agent in words ("let's scan for similar names") — the current agent hands off,
    no button, because the user's request already is the decision;
  - the user names one ("@Atlas, add this to the growth sleeve").
- One in-progress job per agent stays the rule (today's desk lock, `deskWork.js` `blockedDesks`). When the
  user asks for an agent that is busy, Axl says so in a sentence ("Argus is in the middle of Atlas's scan —
  finish that first or set it aside?").

### 3.4 Chains and the stop rule

Inside a chain the user started, hops run without a Go. The chain stops — the agent that needs the user asks
in the timeline, with its decision card, and the full detail opens in the side pane — when:

- a mandate or thesis needs approving (Atlas proposes, the user accepts or edits);
- the user must choose among options (Argus returns 12 names), unless they already said how ("take the top 5");
- anything commits money: generating or confirming a setup, sizing, an order, closing or adjusting a position;
- a workspace must be picked (live / paper / manual) for a new setup or portfolio;
- information is missing that the agent must not assume ("max size per name?").

Everything else hops on its own: scan requests, coverage requests, passing names along, reports coming back.
The user can interrupt at any message. The chain resumes from the user's answer.

### 3.5 Sessions

- One ACTIVE session per user, always saved — no draft tier, no `isSubstantive` gate, no TTL, no per-user cap.
- "New session" archives the active one (title + summary) into history and opens an empty one. History opens
  any archived session read-only, or resumes it.
- A session links to every entity it produced (`links: [{ kind, id }]`). Entities never depend on the chat:
  setups, portfolios, scans and coverage keep their own state, as today. The agent conversation that
  produced an entity is sealed onto that entity, not kept in the session (§6.2).
- **Workspaces.** A session spans workspaces — research is shared. An agent's in-progress state that binds to an
  account (Mentor's setup, Atlas's portfolio) fixes its workspace the moment that agent takes it on, and keeps
  it. The workspace stays a UI/authoring scope, never an engine filter.

### 3.6 Per-agent working state (what replaces drafts)

- The session holds `agentState: { mentor: {...}, portfolio: {...}, scanner: {...}, analyst: {...} }`.
- Mentor's half-built setup and flow ledger (`mentorBuild.util.js`) live in `agentState.mentor` — the same
  shape that rides in `chatState` today, now stored with the session instead of round-tripped by the client.
- It cannot be a real setup before Generate: the monitors run every setup in every workspace, so a half-built
  one written to `setups` could fire. Generate turns the state into the entity and clears it.
- Same for Atlas's half-agreed mandate and Argus's scan settings.

### 3.7 The side pane

- Shows the working surface of the agent with the floor, and follows the conversation (Atlas hands to Argus →
  the pane shows Argus's results).
- Pinnable: keep Atlas's mandate open while the chat moves on. Small tabs at the top switch between the
  surfaces this session has opened.
- A decision card sits in the timeline; its full detail is in the pane.
- The order ticket ("place it myself") opens here.

### 3.8 Entry — Axl asks

- Axl's opening is a question: what do you want to do? With tap-to-answer options.

| User says | Goes to |
|---|---|
| Trade / "I want to trade NVDA" | Mentor |
| Invest / build or manage a portfolio | Atlas |
| Find ideas / "what's moving in semis" | Argus |
| Research a company | Prometheus |
| Industry view (admin) | Pythia — opens its own panel; it stays outside the timeline (§6, decision 16) |
| "Buy 10 AAPL myself" | Order ticket, in the side pane |

- If the first message already says it ("trade NVDA"), Axl skips the question and hands off.
- What the desk cards' badges and locks said becomes Axl talking: leftover work ("Mentor still has your AMD
  setup half-built — continue, or something new?"), a busy agent (§3.3).

### 3.9 Tap-to-answer

- Options under a question send that word as the user's reply. They are answers, never desk links — the agent
  still decides.
- Built on AxlHub's existing `suggestions` (follow-ups on the latest turn only, cleared on send), lifted into
  the shared timeline so any agent can use it (Mentor "long or short?", Atlas "growth or income?").

### 3.10 Storage guard

Atlas M0 is 512 MB across all databases and was hit on 2026-10-08. Endless sessions with no TTL must not eat it:

- From day one: a session stores chat text and REFERENCES. Tool payloads, scan rows and coverage stay on
  their entities; the timeline points at them.
- Only if needed: compact archived sessions older than N months to title + summary + links.

## 4. What changes (read 2026-10-16)

| Today | After |
|---|---|
| `threads` — one thread per conversation, tiered draft → pinned/linked, TTL + LRU cap, one `subjectId` | Session doc: one active per user, archived on "new session", many links, `agentState`, per-agent summaries |
| `scanner_chats`, `portfolio_chats`, old `threads` | Migrated into archived sessions (§6, decision 12) |
| Client round-trips `messages` + `chatState` every turn | Server holds the session; client sends `sessionId` + the new message; server builds per-agent context |
| Per-desk SSE endpoints (`/api/mentor/stream`, …) | ONE way in, ONE way out (Roy, 2026-10-16): the user posts a turn to the session and the server hands it to the floor-holder; everything that appears in the chat — turns the user started, turns a chain started, hand-offs, cards — streams down one session channel. Each desk's turn stays as an internal server function. The session (what the user sees) and each agent's context (what its model reads) are unchanged by this — it is only the wire. Pythia and Aether keep their own endpoints (separate panels). |
| Seven mounted panels switched by `activeTab` (`MainPage.jsx`) | One timeline component + the side pane hosting each desk's working surface |
| `_applyHop` / `handleAxlPick` switch tabs and seed an inbox (`useDeskHandoff.js`, `services/pipeline/`) | A hop appends a `handoff` message and moves the floor; artifacts and contracts unchanged |
| AxlHub desk cards + chips, `RouteOffer` Go, the "Summoning…" animation, pipeline crumb, "Back to axl" | Removed; Axl asks; dividers mark hops; "@Axl" or asking returns to Axl |
| `ThreadHistory` per agent | Session history (one list) |

## 5. Proposed build order (not decided)

1. **Session store** — evolve `thread.service.js` into the session doc (§3.5, §3.6); drop tier/TTL/cap.
   Tests for one-active-per-user, archive, links.
2. **`sessionContext(session, agent)`** — per-agent context + per-agent summary (§3.2). Tests: an agent never
   receives another agent's messages; artifacts addressed to it arrive in order.
3. **Desk endpoints take `sessionId`** — the server appends turns and stores `agentState`; Mentor's ledger moves
   from the client's `chatState` to `agentState.mentor` with no change to `mentorBuild.util.js` logic.
4. **Hand-off as a message + the chain runner + the stop rule** (§3.4).
5. **Frontend timeline** — one message list with agent glyphs, hand-off dividers, tap-to-answer; split each desk
   panel into its chat (gone) and its working surface (to the pane).
6. **Side pane** — follow / pin / tabs (§3.7).
7. **Axl** — opening question, intent routing, leftover-work and busy-agent sentences; remove the desk cards and
   chips, RouteOffer's Go, the crumb.
8. **History + "New session"**; migration of the legacy stores into archived sessions (§6, decision 12).
9. **Background cards into the live session** through `postCard` (§6, decision 15).

Each step is QA-cycled and browser-driven before the next.

## 6. Second round of decisions (Roy, 2026-10-16)

| # | Topic | Decision |
|---|---|---|
| 11 | Who runs a chain | The SERVER. A chain survives the app closing mid-chain; the client only renders what the server appends. `hop.js` contracts and the artifact kinds are reused server-side. |
| 12 | Legacy chats | MIGRATE. An old chat already linked to an entity (a `linked` thread, Mentor's `chat_state` on a setup, a `portfolio_chats` row with its portfolio) becomes THAT ENTITY's saved agent context (decision 17). Every unlinked chat (`threads` drafts, unlinked `scanner_chats` / `portfolio_chats`) becomes one ARCHIVED, read-only session in history. |
| 13 | Phone | The side pane becomes a bottom sheet / drawer on narrow screens. |
| 14 | Summaries | §6.1 — approved. |
| 15 | Background alerts | Desk cards (a setup filled, a Street move, a review) land IN THE LIVE SESSION's timeline, from the desk that sent them, through the one `postCard` transport. SocialChat keeps them too. |
| 16 | Admin desks | Pythia and Aether stay SEPARATE (their own panels) for now. The timeline covers Axl, Mentor, Atlas, Argus, Prometheus and the order ticket. |
| 17 | Sealing | Work that ends in an entity is SEALED onto it — §6.2. |

### 6.1 Summaries

Built on the trim the desks already do — `agentUtils.trimHistory`, which cuts a history back to `keep`
turns only once it passes `keep × 3`, so the cached prefix stays byte-stable between cuts.

- **When:** at the same high-water mark, per agent, with each desk's existing `MAX_MESSAGES` (Axl 20,
  Argus 10, Atlas 10; Mentor and Prometheus keep theirs). The turns the trim drops are folded into that
  agent's ONE rolling summary instead of being discarded.
- **Where:** the summary sits ahead of the kept turns. It changes only at a trim, so caching still reads
  between trims.
- **Keeps:** the user's constraints and preferences, decisions made, entities linked (by id), open
  questions. Drops small talk and tool output. Capped at ~300 words.
- **Never holds** Mentor's setup or ledger — those live in `agentState.mentor` (§3.6), so a summary cannot
  lose a leg or a size.
- **Model:** Haiku 4.5, fixed — a utility call, outside the admin's house-model selector.
- **Timing / failure:** runs in the background after the turn that crossed the mark (no added latency). On
  failure the history is trimmed exactly as today — never worse than now.

### 6.2 Sealing — an agent's context lives on what it produced

Today `linkToArtifact` ties a thread to the entity it produced and everything else stays a draft that
expires. The rule keeps the first half and drops the second.

1. **At Generate** (a setup, portfolio, scan or coverage is created), that agent's context for the work —
   its turns, its summary, the artifacts handed to it — is saved ONTO THE ENTITY. That is what any future
   edit loads.
2. **The session stops carrying it.** The turns are stored once, on the entity. The timeline keeps one
   line — "Mentor built AMD setup" — that opens the entity and, expanded, its saved conversation. An
   archived session in history shows the same line and loads the turns from the entity.
3. **Editing reopens it** — in the live chat, never a separate box. "Edit my AMD setup": Mentor takes the
   floor, loads its context for that setup, and shows it as a collapsed card ("Mentor · AMD setup — built
   Oct 3: long, 2 legs, stop 142; you asked to keep size under 2%") holding the summary and the last few
   turns, expandable to the full history. The edit continues in the timeline; on save, the new turns are
   appended to the entity's saved context.
4. **Work that ends without an entity** stays in the session as ordinary chat; archived with the session,
   no draft, no expiry.

Consequences:

- **A chain seals per agent** — Argus's segment onto the scan, Prometheus's onto the coverage, Mentor's
  onto the setup, Atlas's onto the portfolio.
- **One agent, several entities** — Mentor builds AMD then NVDA in one session: each Generate seals the
  turns since the previous seal onto its own setup.
- **Nothing stored twice** — which is also the §3.10 storage guard.
- Mentor's `chat_state` on a setup stops being a special case: it is the setup's saved Mentor context, in
  the same shape as every other agent's.

## 7. Still open

- When Pythia and Aether join the timeline, if ever.
