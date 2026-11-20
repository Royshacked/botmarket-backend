# Modes and builders — Axl in front, roles as subagents, builds in the background

Decided with Roy 2026-11-20, after the ANT chat (2026-11-19): Axl answered about the ANT IPO, the event analyst took the
"does it affect other companies?" question and kept the floor, so "show me the hotlist" was answered by the event analyst
with its own mapped names; the event analyst, seeing only its own segment, did not know ANT was Anthropic.

Root cause: **a role that answers holds the floor** (`sessionTurn.land` → `sessions.setFloor`) until the model decides a
question is not its own (`RECEPTION_RULE`: "a question you can answer, even in part, is yours"). Every move between roles is a
model judgment, and each role sees only its own segment.

Extends [one-axl.md](one-axl.md) (one voice, role subtitles) — that design changed what the user SEES; this one changes who
holds the conversation. Shaped on Claude Code: one main agent, subagents as tools, explicit modes the user can see.

## 1. Decisions (Roy, 2026-11-20)

| | Decision |
|---|---|
| M1 | **General mode is Axl.** He always reads the user's next message, outside a builder's question phase. |
| M2 | **Answering roles are subagents Axl calls**: the event analyst (Echo), the technical analyst (Proteus), the stock picker (Argus — reached only inside the trader's build, never by the user directly), and the analyst for a plain question. Their answer is shown **as written**, under "Axl · Event analyst", not paraphrased by Axl. |
| M3 | **Builders are modes**: the trader (Mentor), the portfolio manager (Atlas), the analyst when building coverage (Prometheus). Code signal: the desk's `hasWork(state)`. |
| M4 | **A mode picker on the prompt box** shows the mode ("General"); its menu: Trader / Portfolio manager / Analyst. Axl may switch the user himself when the prompt asks to build. |
| M5 | **Questions up front, Claude-CLI style** — several questions on one card, options + "Other", submit. The trader and the portfolio manager ask; the analyst asks none. |
| M6 | Asked up front: the **account** (a menu of the user's accounts), the scenarios (A / B / both), invalidation and redraw, and a **policy for the unexpected** — "decide for me" / "ask me". |
| M7 | **The build runs in the background.** The mode goes back to General; the build's progress shows in the work pane; Axl chats meanwhile. |
| M8 | **A question mid-build** (policy "ask me", or nothing covers it) pauses the build; the question pops above the chat box, with Edit. |
| M9 | **When it is done**: Generate is enabled and "Watch summary" opens a summary above the chat box (the live chart, the levels, the builder's reasoning) → **Confirm / Change / Dismiss**. Change rebuilds and shows a new summary. |
| M10 | **One build at a time.** A second builder asks its questions now; its build is QUEUED (seen in the pane, cancellable). The slot frees when a build FINISHES, not when it is confirmed. Queued answers are kept as rules, never prices. |
| M11 | Portfolio review and the mandate follow the same flow as the trader. |
| M12 | Axl knows each build's status, and a change said to Axl ("make it 2% risk") goes to the builder. |
| M13 | A failed build: Failed + Retry + a notification. A finished one: a toast in the app, a push when away. |
| M14 | Generate rechecks the quote and the levels before arming (a summary can be hours old). |
| M15 | The summary's chart is the live chart component, never an image. |
| M16 | The non-builders: same for the user, but no floor — every answer through Axl, the next message back to Axl. Echo's `map_event` (2–3 min) shows in the work pane as background work, nothing to confirm. The Hotlist Echo tab and the desk list become Axl calling the subagent. "Build a trade on FN" after an event answer → Trader mode with the event's findings. |

## 2. The roles

| Role | Today | New |
|---|---|---|
| Axl | reception, floor-holder by default | **General mode** — always in front |
| Event analyst (Echo) | desk, holds the floor after Axl routes | **subagent** `ask_event_analyst` |
| Technical analyst (Proteus) | desk, routed from Axl and Mentor | **subagent** `ask_technical_analyst`; Mentor keeps its code read (`_proteusRead`) |
| Stock picker (Argus) | desk, routed only from Mentor | **inside the trader's build** — the "Which name?" question's "Find one for me" |
| Analyst (Prometheus) | desk; coverage draft → Initiate | plain question → **subagent** `ask_analyst`; "research X" → **Analyst mode** |
| Trader (Mentor) | desk; asks in prose, `<go>` generates and arms itself | **Trader mode**: questions → background build → summary → Confirm |
| Portfolio manager (Atlas) | desk; mandate in prose, builds through | **Portfolio manager mode**: same flow |
| Industry strategist (Pythia) | admin, own panel and session | unchanged |

## 3. General mode — subagents

**There is no agent-as-tool today.** `consult` (deepThink.service) is one Opus call with no tools and no history. New, on
the existing turn machinery:

- **Axl's tools** `ask_event_analyst`, `ask_technical_analyst`, `ask_analyst` — input
  `{ question, companies: [{ ticker, name }], context }`. `companies` is REQUIRED and carries the name: the bare-ticker
  problem (ANT → "Ant Group") is fixed by the schema, not by a prompt rule (the rule failed on Luna, 2026-11-19).
- **The handler runs the role's own `chatStream`** with its own tools and prompt, headless: messages = the role's recent
  exchange in this session (its segment, last few rows — so follow-ups work) + the question. The role's tokens stream to
  the client as the role (`session_delta` with the role's agent); its reply is appended as the role's own row (shown as
  written). The tool result Axl receives: the reply, plus "shown to the user — add at most one line, or nothing".
- **No floor move.** The role never holds the floor; its `<route>` tags are dropped, except a build request, which comes
  back to Axl as data ("the user wants a trade on FN") — Axl switches the mode (§4).
- **A clarifying question** from the role is its reply; the user answers Axl; Axl calls again with the answer and the
  exchange.
- **Echo's `map_event` becomes background work**: it returns at once ("mapping — 2–3 minutes"), the pipeline runs as a job
  (`echoMapJobs.service.js`), and when it is done the event analyst gets ONE turn (a hidden app opening) to say what the
  map found, under its own role. **BUILT 2026-11-20 (step 2)** — one departure from M16: the "mapping…" line is the chat's
  STATUS LINE (`session.waiting`, the analyst-read line's pipe), not the work pane — a map is nothing to confirm, and the
  status line is where the chat already says what it is waiting on. Live (axl_dev): Axl's turn ended at 32 s instead of
  ~3 min, "is the market open?" was answered while it mapped, the map came back at 214 s.
- Direct entries (Hotlist Echo tab "Walk me through…", the desk list) send the text to Axl with a hint naming the role.
- **BUILT 2026-11-20 (step 1)** — `ask_specialist` (Axl), `desks/subagent.js`, `startTurn` sends a subagent's turn to Axl
  (`input.via`), a subagent never takes the floor (`sessionTurn.land`); its rows carry `ref.via: 'axl'` and are in Axl's
  segment, labelled as the role's (context + summary). The analyst stays a desk until Analyst mode (step 9).
- `RECEPTION_RULE` and the Echo/Proteus routes go from Axl's prompt; `routedFrom` loses `axl` for them.

- **QA/CR cycle 2026-11-20** (steps 1–2): an independent review found 2 medium + 3 low, all but one cosmetic FIXED —
  a background announcement ended any chain in progress (now `origin: 'background'`, which the chain runner skips); the
  trader's hand-off to the technical analyst left the answer out of the trader's context (`via` is now the floor holder;
  `axl` for background notes); a second ask of an event already mapping now joins the run (its own line and
  announcement); Axl in the social DM is told there is no `ask_specialist`. A server restart mid-map is picked up at boot
  (`echoMapJobs.sweep`); a map another run holds waits for it. Left: Axl's words before a call leave the live bubble
  until his row lands (cosmetic).

## 4. Builder modes

### 4.1 The session's mode and builds

On the session header (new fields, beside `floor`):

```
mode:   'general' | 'mentor' | 'portfolio' | 'analyst'      // what the picker shows
builds: [{ id, agent, title, status, answers, accounts, mainAccountId, questions?, error?, createdAt }]
        status: asking → queued → building → (awaiting) → ready | failed | confirmed | dismissed | cancelled
```

- **Entering a mode**: the picker (`POST /sessions/:id/mode`), or Axl's route to a builder (Axl's `<route>assist</route>` →
  mode, not floor). Entering creates a build in `asking`.
- **`floor`** becomes: Axl, except while a build of the current mode is `asking` (the builder takes the answers) — so the
  model never decides who holds the floor.
- **One build at a time** (M10): at most one `building`/`awaiting`; the next `queued` starts when it finishes.

**BUILT 2026-11-20 (step 3, with step 7's picker pulled forward):** the mode is DERIVED from the floor, not stored —
`services/desks/modes.js` `modeOf(floor)`: a builder on the floor is its mode, anyone else General (a stored copy would
drift). `POST /api/sessions/:id/mode { mode }` (202) moves the floor under the session lock, so it lands after a running
turn; a builder left with work keeps it parked in agentState. Axl's route to a builder switches the mode by itself (it
moves the floor). FE: `ModePicker` INSIDE the prompt box on its left (ChatInputRow's `leading` slot — a row under the box
sat differently on desktop, phone and the landing screen), short labels on the chip, the full ones in a menu that opens
upward; it replaced "Ask something else". The `builds` records move to steps 4–5, where they first do anything.
Driven (`scripts/drive-mode-picker.mjs`): General → Trader → General; "I'd like to build a swing trade on NVDA" switched
it to Trader by itself; the menu fits at 390px.

### 4.2 Questions (M5, M6)

A question card: `{ id, header, question, options: [{ label, description }], multiSelect, other: true, default? }` — the
AskUserQuestion shape. Stored as a session row `kind: 'questions'`, `ref: { buildId, questions }`; answered by
`POST /sessions/:id/answers { buildId, answers }`.

**Most questions are built by the SERVER, not the model** (reliable, no JSON from Luna):

| Trader | Portfolio manager |
|---|---|
| Which name? (if none) — options incl. "Find one for me" (stock picker) | Objective |
| Account — the workspace's accounts | Horizon (tactical / swing / strategic) |
| Position size · risk · minimum R:R — prefilled from `user_profile.size` | Max drawdown |
| Scenarios — A / B / both (default both) | Capital |
| If the stop breaks the thesis, or the trade runs away — redraw / close / ask me | Constraints (Other) |
| Anything unexpected — decide for me / ask me | Account(s) |
| | Anything unexpected — decide for me / ask me |

The builder may ADD questions it needs from data (a `<questions>` block, validated against the schema).
Analyst: no questions — the symbol comes from the request.

**Portfolio review**: no questions (it reads the book) — straight to the build.

**BUILT 2026-11-20 (step 4).** `desks/questions.js` (pure: the two forms, `needsQuestions`, `checkAnswers`,
`answersText`), `desks/asking.js` (post / setAside / answer), `POST /api/sessions/:id/answers` (202). A card is posted
instead of the builder's first turn for a NEW build — the picker, a route's opening (the route's ticker now rides to the
opening: `runner.followRoute` → `input.routeSymbol`, offered first), the user's first message — never on a chain step, an
edit, work on the table, a press, or the answers' own turn (`input.answered`). Markers `asking` / `asked` (markers.js). The
answers run the builder as an opening, bound to the account(s) picked on the card, which the venue picker marks too.
Typing instead sets the card aside. FE: `QuestionCard` above the prompt box (the box's width; 55vh, scrolls), an answered
card stays in the thread as "Your answers". The builders' prompts say the answers are settled. The model-written extra
questions (`<questions>`) are left for step 8, with the mid-build pause. Driven (`scripts/drive-question-card.mjs`): Axl's
route → Trader + the card with NVDA first → answered → the trader built on $10,000 / 1% / R:R 1.5 without asking again
(read in the session); the portfolio card from the picker; phone at 390px.

### 4.3 The background build (M7, M8, M12)

- After the answers, the mode returns to **General**, the build goes `queued` → `building`.
- A build is a run of the builder's turns with `origin: 'build'`, answers injected as a turn-context section (Mentor:
  the three numbers + `waiver` per the policy; scenarios; the account as the turn's `accounts`).
- **It must not block the chat.** Today every turn of a session runs under ONE lock (`turnLock.withSessionLock`), so a
  2–3 minute Mentor turn would block Axl. Build turns take a lock of their own (`session:build`); they touch only their
  agent's state field (`agentState.<agent>`) and append rows (atomic `seq`). Shared writes they must not race: `floor`,
  `mode`, summaries — the build writes none of them.
- **Its rows go to the pane, not the chat**: `ref.build = buildId`; the timeline hides them (`isOffScreen`), the pane
  shows them as the build's log (steps, tool lines).
- **`<go>` no longer commits.** Today `runner.deskGo` → `generateArmed` saves and arms on its own. In a build, `<go>`
  marks the build `ready`; the user's Confirm runs the commit.
- **A mid-build question**: the builder's `<questions>` → the build `awaiting`, the card pops above the chat box (in
  General); the answer resumes the build.
- **Axl's view**: a volatile block lists the builds ("NVDA trade — building", "Growth book — queued"); Axl's tool
  `change_build({ buildId, change })` queues the change as a build turn (status back to `building`).

### 4.4 The summary (M9, M13, M14, M15)

- `ready` → a toast ("NVDA trade is ready — Watch summary"), a push if no client is connected; the pane's Generate enabled.
- **Watch summary** opens above the chat box: the setup (SetupSummary), the live trade chart (MentorTradeChart), the
  builder's reasoning ("How I'll build it…" — today that is the chat reply). Buttons: **Confirm** (the existing
  `act generate`, with a recheck of quote and levels first), **Change** (a text box → `change_build`), **Dismiss**
  (`discard`).
- `failed` (error, timeout, a restart — `runner.sweep` today posts "I was interrupted"): the pane shows Failed + Retry; a
  toast.

### 4.5 The analyst

"Research MSFT" → Analyst mode → no questions → the build is the existing headless research run (`researchRun`,
~4 min/name) — BUT today a run auto-saves (`initiateCoverage`). For a mode build it returns a draft instead; Initiate is
the Confirm. Initiate is admin-only today (`analyst.actions.js:23`) — see §6.

## 5. Build order

Each step ships on its own, with tests and a drive.

1. **Subagents** — `ask_event_analyst` / `ask_technical_analyst` / `ask_analyst` on Axl (the handler, streaming as the
   role, rows as written, `companies` required); Echo/Proteus no longer routed from Axl; direct entries via Axl. Fixes the
   ANT chat on its own.
2. **Echo's `map_event` in the background** — job, pane line, settle row.
3. **Session mode + builds** — header fields, the picker endpoint, Axl's route → mode, the build lock, WS state.
4. **Question cards** — the schema, server-built trader + portfolio forms, the `<questions>` block, `answers` endpoint;
   FE QuestionCard above the chat box.
5. **The background build** — build turns, rows to the pane, `<go>` → ready, Axl's build block, `change_build`.
6. **The summary** — Watch summary, Confirm (recheck) / Change / Dismiss, toast + push, Failed + Retry.
7. **The mode picker** (FE) — General / Trader / Portfolio manager / Analyst.
8. **Mid-build questions** — pause, card, resume.
9. **Portfolio review + mandate, the analyst** on the flow.
10. **Phone (390px), the drives, the docs cycle.**

## 6. Settled (Roy, 2026-11-20)

- **M17 Analyst mode is for every user**, and a coverage any user saves is the house's — saved for everyone. Today
  Initiate is admin-only (`analyst.actions.js:23`, FE "House coverage is saved by an admin"); step 9 lifts it. Note: a
  user's coverage then feeds every user's reads (Mentor's analyst read, the Hotlist).
- **M18 "Find one for me"** pauses the build with a question card listing the stock picker's 2–3 candidates; the user
  picks one.
- **M19 Step by step is dropped.** Every build runs in the background; Change on the summary adjusts the levels.

## 7. Open

- Mentor's spoken offers (earnings in the horizon, the deeper stop, the usual pullback, a second target) go in the
  summary as notes — to confirm on the drive.
