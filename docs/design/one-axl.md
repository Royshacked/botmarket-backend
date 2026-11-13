# One Axl — one assistant, many roles (design, 2026-11-13)

Roy's talk of 2026-11-13. Moving from agent to agent in the chat is confusing: after Axl hands the user to a desk,
a new name answers, and a hand-back puts three speakers on screen in a row ("passing it to Axl", "Prometheus will
look at it", the answer). The user meets ONE assistant. The specialists stay — as roles under it.

Nothing structural changes: the desks, their prompts' craft, routing (`routing.util`), the chain runner, the monitors
and every collection stay as they are. This is how the product PRESENTS and how the agents SPEAK. Internal names
(`mentor`, `analyst`, Talos…) stay in code, logs, docs and memory.

## 1. Decisions (Roy, 2026-11-13)

| | Decision |
|---|---|
| D1 | In the chat only **Axl** exists. Under his name, the role that is working: *Trader*, *Analyst*… |
| D2 | The work pane shows **what is being built**, never who builds it |
| D3 | **Info is a diagram** of the flow the user is in, the current step lit — not paragraphs |
| D4 | **Admin sees what a user sees.** No internal-name tag; the logs are the debugging view |
| D5 | **Pythia and Aether fold in too** — roles under Axl like every desk |
| D6 | The five flows in §6, as written; refined after use |
| D7 | Shared **"about you"** block every role reads (§4) — in scope from the start, because one voice raises the expectation of one memory |
| D8 | **Social chat: every message from the app comes from Axl** — cards, alerts, monitor messages; one bot identity, the role as its subtitle |
| D9 | §9's open points go as proposed: Pythia = *Industry strategist*, Aether = *Event analyst*; the hand-off divider is settled on the drive |

## 2. The roles

| Internal | Role (subtitle) | Work pane says |
|---|---|---|
| Axl | — (no subtitle) | — |
| Mentor | **Trader** | NVDA · long swing trade |
| Prometheus | **Analyst** | NVDA · coverage |
| Atlas | **Portfolio manager** | Growth book |
| Proteus | **Technical analyst** | NVDA · technical profile |
| Argus | **Stock picker** | Finding a name |
| Pythia | **Industry strategist** | Semiconductors · house view |
| Aether | **Event analyst** | Fed cut · exposure |
| Talos (monitor) | **Trade monitor** | — (cards only) |
| Themis (monitor) | **Portfolio monitor** | — (cards only) |
| Coverage re-check | **Analyst** | — (cards only) |

One source: the frontend's `agentMeta.jsx` already carries a `role` per agent ("Trade agent", "Analyst agent"…) —
those strings become the subtitles above; `brand` stops being shown.

## 3. The chat — only Axl

```
 ◉ Axl
   Technical analyst
 Measured over ten years, NVDA doesn't respect any moving average…
 ───────────── Analyst ─────────────
 ◉ Axl
   Analyst
 On the business: …
```

- **Every row** carries Axl's name and avatar; the subtitle is the role of the agent that wrote it. Axl's own rows
  have none.
- **A hand-off** (today "Proteus → Prometheus") becomes a thin divider naming the role that takes over — or nothing,
  when the next row's subtitle already says it.
- **Hand-backs are silent.** A desk that hands a question back (`<route>reception</route>`, 2026-11-13) writes no
  line — a reply that is only tags is not kept (sessionTurn). Axl, routing it on, writes no line either: the divider
  is the hand-off. Axl's prompt drops "X will take it from here".
- **`@` mentions** take role words (`@trader`, `@analyst`) as well as the old names, so nothing typed breaks.
- **Social chat (D8):** EVERY message the app sends there comes from Axl — cards, alerts, the monitors' messages,
  replies — the role as its subtitle. One bot identity in the conversation list, not one per agent; the cards keep
  their content and buttons. One sender at the shared transport (`postCard` → `postBotCard`), the role carried on the
  card, so no notifier picks its own bot again.

## 4. One voice — the shared rule and the shared memory

**The voice rule** — ONE shared block in `agentUtils` (like `LANGUAGE_RULE`), appended to every desk's prompt and to
Axl's:

- You are Axl. Speak as one assistant: "I", never your internal name, never another agent's name.
- Another role, when it must be mentioned, by its job: "the business side", "for the levels". Better: just do it
  ("let me look at the business").
- When your view differs from another role's on the record ("the house rates it Buy"), own yours out loud: "on the
  business it's a buy; on the chart there's no entry yet." One voice must not look like it contradicts itself.

Every prompt also loses the names it says today: Axl's routing section (heavy), Mentor's ("Argus finds…",
"Prometheus's read"), Proteus's "Who does what", Prometheus's, Atlas's. The craft in each prompt is untouched —
only how it refers to itself and the others. `npm run check:docs`-style scan for brand words in prompts, so a name
creeping back fails a test.

**The shared "about you" block** — today each desk sees only its own segment of the chat (unified-chat.md §3.2: on
purpose, cost and focus). Under one Axl the user will expect "I told you I risk 1%" to hold everywhere. So:

- A small per-user record (`user_profile`): risk per trade, the accounts in use, preferred horizon, level, what is
  being worked on right now (the open build / book / coverage), remarks meant to follow the user ("no low-float
  names").
- **Written by the desks, as a side effect of their own work** (Mentor on a confirmed size, Atlas on a mandate, the
  experience level as today) — never by interrogating the user (the removed `save_objective` lesson).
- **Read by every role**, as one dynamic block in its turn — the same pipe for all (sessionTurn → deskCommon), what
  each does with it stays its own.
- The existing `experience` level (sessionTurn's `audience`) folds into it.

## 5. The work pane — what is built

The pane's title is the item, not the desk: **NVDA · long swing trade**, **Growth book**, **NVDA · coverage**,
**NVDA · technical profile**. Nothing open → the last thing built, or the pane's empty state. No agent name or desk
name anywhere on it ("Trading Desk", "Research Desk" labels go too; the Floor's desk list becomes a list of things
to do: *Build a trade*, *Build a portfolio*, *Research a company*…).

## 6. Info — a diagram of where you are

Info (the desktop Floor column and the phone's `ChatInfo` sheet) shows the flow the user is in as steps, the current
one lit. Few words per step; the long copy (desk blurbs, the risk-based explainer) sits behind a "more" link.

```
 Hotlist:     Pick horizon → Pick a name → (Build trade) → Arm
 Trade build: Direction → Horizon → Levels → (Size) → Confirm & arm
 Portfolio:   Mandate → Find names → Research → Allocate → Review
 Coverage:    Name → Research → Verdict & target
 Technicals:  Name → Measured profile → Example chart
```

**Where you are comes from state, never a guess:**

| Flow | Current step from |
|---|---|
| Hotlist | the Floor tab + whether a horizon / a name is picked |
| Trade build | Mentor's ledger `stage` (opening · spans · entries · size · summary — already logged every turn) |
| Portfolio | Atlas's state (mandate set? sourcing? review mode?) |
| Coverage | Prometheus's state (researching / verdict published) |
| Technicals | Proteus: profile read → chart shown (the turn's tools, 2026-11-13 trace) |

The server sends `{ flow, step }` with each turn's payload (one field per desk's `done`); the client draws it. A
flow it cannot place → Axl's plain Info.

## 7. What does not change

- Routing, hand-offs, the chain runner, the busy rule — the floor still moves between agents; only its label changes.
- Each agent's context stays its own segment (+ the new shared block).
- Monitors, cards' content, workspaces, brokers.
- Internal names everywhere a user does not look.

## 8. Build order

Steps 1 and 2 ship together — the chat must never say "Prometheus" under an "Axl" header.

1. **The voice** — the shared rule; names out of every prompt; Axl's routing lines and the hand-back line silent;
   the brand-word test. Live-checked on each desk (the replay harness), incl. the NVDA hand-back.
   **BUILT 2026-11-13** (backend only — not to be pushed before step 2): `VOICE_RULE` on all eight chat agents; ~240
   names out of the 12 prompt files and ~130 out of tool descriptions, per-turn notes, chain contracts, card copy and
   the house's background prompts (bookTiming, hotlist.argus, houseScan.argus); the registry's `role` drives the route
   rule; the hand-back writes no words; Axl's hand-off line names no one; `oneVoice.test.js` guards it. Kept on
   purpose: names in code, logs, comments, the push titles and the hand-off artifact's `label` (step 2, FE-bound).
   Live: 8 desk turns ("who are you?", "who builds the trade?", an off-desk question) — 0 names; each answers as Axl
   in its role; the Proteus hand-back is silent.
2. **The chat** — rows as Axl + role subtitle, hand-off divider, `@role` mentions, social chat as one Axl.
   **BUILT 2026-11-13.** FE: `agentMeta` roles + `work` labels + `speakerOf`; every speaker tag, intro, turn tag, card
   tag, toast and push title is "Axl · Role"; hand-offs AND a route's opening (`ref.opening`, server-marked) are not
   drawn (`timelineRows.isOffScreen`) — decided on the drive: no divider, the subtitle carries it, and the user's
   question shows once; the pane says "Trade work"/"Portfolio work"; ~200 board/surface strings reworded (Hotlist
   "Picks", "Confirmed"). BE: `postBotCard` → the one Axl thread (sender = role), `getMessages` hides admin-only
   roles' cards from non-admins, `@trader`/`@portfolio manager` mentions, seal/busy lines name no agent, and a chart an
   agent SHOWS is now LIVE with its labelled lines (the unified chat never drew the PNG — Proteus's example chart was
   lost). Driven (`scripts/drive-one-axl.mjs`): NVDA behaviour → Axl · Technical analyst + the example chart; the news
   hand-back silent, answered by Axl, the question once; no internal name anywhere, desktop + 390px.
   PENDING: `scripts/merge-bot-threads.mjs --apply` (dry run on axl_dev: 23 role threads, 1529 messages) — Roy's call.
3. **The shared "about you"** — `user_profile`, written by the desks' own work, read by every role.
4. **The work pane** — item titles; the Floor's desk list as things to do.
5. **Info diagrams** — `{ flow, step }` from each desk, the five diagrams.
6. **Drive it** — desktop + 390px, a Hotlist → trade build, a Proteus → hand-back → Analyst, a portfolio review.

## 9. Open

- Whether the hand-off divider shows at all, or the subtitle alone carries it — decided on the drive (D9).
- `user_profile` fields beyond the first five — add as a desk needs one, never speculatively.
- The brand: the names leave the product. Kept for the docs, the logs and a possible "meet the team" page later.
