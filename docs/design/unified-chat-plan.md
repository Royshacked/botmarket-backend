# Unified chat — implementation plan

**Status: PLAN, 2026-10-16 — §1 answered by Roy. Nothing built. Branch `feat/unified-chat` in both repos.
Decisions it implements: [unified-chat.md](./unified-chat.md).**

Built from three read-only sweeps of both repos (backend chat stores and desk turns; frontend panels and
hand-offs; conveyor, cards and edit mode), read 2026-10-16. Line numbers drift — functions are named so
they can be found again.

## 0. Rules for this work (Roy, 2026-10-16)

- **Delete what is replaced, in the same phase.** No back-compat aliases, no parallel old path, no
  "kept for now" exports. If nothing calls it, it goes.
- **One shared mechanism per job** — one session service, one turn pipe, one context builder, one chain
  runner, one timeline component, one surface-action call. Per-desk JUDGMENT stays in its desk.
- **Clean over safe.** Where old code is in the way, rewrite it rather than wrap it.
- Every phase: tests written, QA loop + bug hunt + conflict check, browser-driven where the UI moved
  (`scripts/drive-mentor-ui.mjs` pattern), before the next phase starts.

## 1. Four questions for Roy — answered 2026-10-16

1. **Atlas → Argus is not a chat hop today.** When Atlas sources a sleeve, the server runs a headless job:
   `<screen_request>` → FMP screener in code (`sleeveSource.service.js`) → research queue → headless
   Prometheus → a `sleeve_sourced` card. Argus — the agent — is never involved, and the `mandate` artifact
   that was meant to carry it is dead (see §3). Options:
   - **(a) keep the code screen** and show it in the timeline as Argus's work ("Argus screened 40 → 8"),
     writing the result into Argus's context so a follow-up question to Argus works. Cheap, deterministic.
   - **(b) make it a real Argus turn** — Atlas hands a `mandate`, the Argus model screens. Matches the
     story literally; costs a model turn per sleeve and is slower.
   - **Roy, 2026-10-16: (a).**
2. **One turn endpoint + one session stream instead of per-desk streams.** The design said "keep the
   per-desk SSE endpoints". Once the server runs chains, it starts agent turns the client never posted,
   so the client must listen on ONE session channel anyway. Then the five `/api/<desk>/stream` POSTs are
   duplicates. Proposal: `POST /api/sessions/turn` (the server routes to the floor-holder) +
   `GET /api/sessions/events` (one SSE channel for every turn, hop and card). Each desk's turn becomes
   an internal function. **Roy, 2026-10-16: yes** — design doc §4 updated.
3. **`portfolio_chats` holds Atlas's BOOK, not just chat.** Its lifecycle, mandate, thesis, reviews,
   fingerprints and Themis checks are read by `adoptBook.service.js`, `portfolioRebalance.service.js`,
   `tradeIdeas.controller.js`, `themis.monitor.service.js`, `tradeCapture.service.js`. The chat half goes;
   the book half stays. Rename the collection to `portfolio_books` (one migration, five readers) so the
   name says what it holds? **Roy, 2026-10-16: yes.**
4. **Reaching Pythia and Aether** once desk buttons are gone. **Roy, 2026-10-16: their buttons move to
   the Floor lists (`FloorLists.jsx`), admin only — TEMPORARY until they join the timeline.** Axl's
   routing to them stays.

## 1b. Architecture gaps — layout decided, four PROPOSED (2026-10-16)

- **Side pane layout — Roy: a DRAWER over the chat.** The workspace is the Floor layout with three columns;
  there is no room for a fourth. The drawer opens over the chat column, follows the floor, can be pinned
  open; on a phone it is the bottom sheet (decision 13). Supersedes "side pane next to the chat" in the
  design §3.7 wherever they differ.

The four below are technical and PROPOSED — Roy reviews them with the phase-5 / phase-7 detailed plans.

1. **User types while a chain runs.** The running turn finishes; the user's message goes to the agent
   that has the floor; the chain PAUSES. The agent answers and, if the chain had more to do, offers
   "Continue" as a tap option. Stop (the existing `/api/turns/:turnId/stop`) still kills a turn at once.
   Interjecting is the user taking the wheel — the chain never talks over them.
2. **Server restarts mid-chain.** Chain state is in the session, so nothing is lost. On boot an
   interrupted chain is marked paused and the floor-holder posts "I was interrupted — continue?". Never an
   automatic re-run: a turn can have side effects (a queued research run, a saved scan) and paying for it
   twice is worse than one tap. The partial text of the cut turn is kept, as a stopped turn is today.
3. **Reconnect and several devices.** Every timeline message carries a sequence number used as the SSE
   event id. On reconnect the client sends `Last-Event-ID` and the server replays the missed messages
   from the timeline; a turn still streaming is sent once as a snapshot of its text so far, then live.
   Each open device subscribes to the same per-user channel, so phone and laptop stay in step. Fan-out is
   in-process (one Render instance); scaling past one instance would need a shared bus — noted, not built.
4. **What makes a turn a "decision".** Not the model's say-so: CODE decides from the done payload, per desk,
   in one declared table — Mentor's gate stages (`mentorBuild.util` STAGES), Atlas's plan / mandate / review,
   Argus's list when the user has not said how many to take, any order confirm, a workspace pick. The chain
   runner checks the table after every turn; a match appends a `decision` message and halts. New cards:
   **MandateCard** (Atlas — sleeves, weights, constraints; Accept / Edit) and **SizeCard** (Mentor — risk %,
   size, the desk's suggestion; Accept / Change). Their layout is designed in the phase-5 plan.

## 2. What the sweeps found that changes the plan

- The frontend carries most of the split: ~2,000 lines of `MainPage.jsx` are desk switching and the
  client conveyor; each desk panel mixes its chat with its working surface.
- **Duplication to remove on the way:**
  - the `_continue` prefill-resume copied seven times (every panel + MainPage), outside `useChatStream`;
  - per-panel boilerplate: `onLoadingChange`, `handleResumeThread` + `resumeRef`, `MessageBubble` wrappers,
    send-vs-continue request opts built twice;
  - backend: three request-parse styles (`parseChatMessages`, `parseStreamBody`, hand-rolled in
    analyst/strategy), two history helpers (`normalizeMessages` direct vs `buildDeskMessages`), the same
    stream scaffold in every controller, per-agent tag lists instead of `ALL_EMIT_TAGS`;
  - desk keys declared in five places (FE `DESKS`; BE `VALID_PIPELINES`, `ROUTABLE_DESKS`, `AGENT_DESK`,
    `EDIT_KIND_DESKS`); the candidate item shape built four times in MainPage; two FE route readers;
  - three entity transcript stores (`setups.chat_state`, `portfolio_chats.messages`, `trade-ideas.chat_state`);
  - Themis posts with `postBotCard` directly, skipping `postCard`.
- **Missing decision cards** the stop rule needs: Atlas has no mandate-approval step (the mandate sits in
  a ref), Mentor's sizing is an `answer` stage with no card.
- **Chain state is in memory today** (`sleeveSource.service.js` `state.sleeves`) — a restart loses it.
  Server-run chains must persist their state in the session.
- **Cards supersede by subject** (`_supersedePending`) — the timeline copy must supersede and resolve the
  same way, or stale asks pile up.
- An existing drift bug: AnalystPanel's `_continue` omits `coverage_symbols` that `_send` sends. It
  disappears with the copies.

## 3. Phase 1 — Dead-code purge (both repos, no behaviour change)

Independent of everything else; shrinks the surface before the rebuild.

**Frontend**
- The archived idea chat: `ChatPanel.jsx`; in MainPage `handleSend`, `_continueIdea`, `handleCancelBuild`,
  `handleEditIdea`, the `INVALIDATION_EDIT_IDEA` / `ENTRY_CONFIRM_EDIT` listeners, `chatPanelProps`,
  `ideaThreadIdRef`, `latestMessagesRef`, the `_cap*` helpers, `analysisState` / `deriveBuildingIdea`,
  MainPage's own `useChatStream`; `userPrompt.service.remote.js` (posts to the unmounted `/api/idea`).
- The client sleeve run — unreachable, nothing ever starts it: `sleeveRunRef`, `sleeveRun`,
  `_advanceSleeveRun`, `handleSkipSleeve`, `_screenSleeve`, `_researchSurvivors`, ScannerPanel's
  `sleeveRun` / `onSkipSleeve` props.
- Dead artifact kinds: `KIND.MANDATE`, `KIND.SCAN_REQUEST`, `briefMandate`, `briefScanRequest`, the
  `mandate` emit in `portfolio.contract.js`, `scannerSingle`'s scan_request branch, `handoffActive`.
- Kairos leftovers: `TAB_TO_STEP` kairos/idea entries, AccountSelector's `'kairos'` check,
  `CALL_CONFIRM_OPEN` (no listener left). MentorPanel's never-passed `onPendingSetup`.
- Move `AccountSelector.jsx` out of the `ChatPanel` folder (TradeTicket and the header use it).

**Backend**
- `scanner_chats` service, handlers and `/api/scanner/chat-state` routes (no frontend caller). The
  collection stays until the migration reads it (phase 9).
- Trade-idea `chat_state` (`_trimChatState` and its writers in `tradeIdeas.service.js`,
  `manualIdea.service.js`).
- `handoffTo === 'kairos'` in `scanner.controller.js` and `scanner.agent.service.js`; the stale idea /
  analysisState comments in `threads.controller.js` and `server.js`.
- Kept on purpose (CLAUDE.md): `AGENTS.kairos` branding, `kairos_pick` wire name, `KINDS.CALL`.

Tests: delete the tests of what is deleted; suites green in both repos.

**As done (2026-10-16) — moved out of phase 1, with the reason:**
- **The idea chat** — not dead: three live buttons still open it (the idea/call row pencil, the
  pre-entry dialog's Edit, the idea invalidation card's Edit), and today they open a chat that cannot
  answer (`/api/idea` is unmounted). Deleting it needs Roy's call on what those buttons do — pending.
- **`KIND.MANDATE` / `KIND.SCAN_REQUEST` and their briefs** — dead, but ~40 conveyor tests (`hop`,
  `deskSteps`, `pipelineNav`) use them as fixtures, and those files are ported (phase 5) and deleted
  (phase 7). They drop with the phase-5 port instead of being rewritten twice.
- **`CALL_EXPIRY_EDIT`** and the call card bubbles — emitted with no listener, like `CALL_CONFIRM_OPEN`
  (removed), but woven into the card family; they go with phase 6, where the cards are reworked.

## 4. Phase 2 — One backend turn pipe (dedupe before building on it)

So the session plugs into ONE place instead of five controllers.

- **`runDeskTurn(desk, ctx)`** in `api/_shared/` — the scaffold every controller repeats today
  (`streamAgentResponse` → experience level → `chatStream({...sseAgentCallbacks})` → `{reply, ...routeFields}`).
  Each desk supplies only its agent call and its done-payload shape.
- **One request parse** — `parseStreamBody` for every desk; the hand-rolled copies in analyst and strategy go.
- **One history helper** — `buildDeskMessages` for every desk; the direct `normalizeMessages(…, MAX_MESSAGES)`
  calls and the per-desk `_buildMessages` wrappers go; one constant name per desk.
- **Tag hiding** from `ALL_EMIT_TAGS`, not per-agent lists.
- **One desk registry** in `routing.util.js` from which `VALID_PIPELINES`, `ROUTABLE_DESKS`, `AGENT_DESK`,
  `EDIT_KIND_DESKS` derive.

Tests: `deskControllersHandle`, `agentStreamContract`, `parse.util`, `normalizeMessages`,
`promptCacheHistory`, `turnContextPlacement` updated; behaviour identical.

**As done (2026-10-16):**
- `api/_shared/deskStream.util.js` — `makeDeskStream({ log, parse, run, done })`; all seven desk
  streams ride it (Pythia and Aether too: separate panels, same pipe). `run` is the seam the session
  turn endpoint calls in phase 5.
- `parseDeskTurn` replaced `parseStreamBody` and the hand-rolled parses. **`userPrompt` is gone
  everywhere** — no client sent it; the five headless callers (research run, quick read, coverage
  refresh, industry assessment, industry review) pass `openingTurn(text)` as `messages`.
  `buildDeskMessages` and every per-desk `_buildMessages` wrapper are deleted; one constant name
  (`MAX_MESSAGES`).
- `cleanReply` strips from `ALL_EMIT_TAGS` (unwrapping `<ticker>`) — every per-desk strip list deleted.
- **Moved to phase 4:** the one desk registry. Its keys are pipelines (`trade`, `assist`, …), which
  phase 4 replaces with the agent that has the floor; merging them now would be redone there.
- Tests: `deskStream.test.js` (new), `parse.util`, `normalizeMessages` (+ `openingTurn`, `cleanReply`),
  `mentorResponse`, `routing`, `agentStreamContract`, `strategyAgent` updated. Suite 3970/0.

## 5. Phase 3 — The session store (backend)

- **`services/session.service.js` + `session.util.js`** (pure parts unit-tested). Collection `sessions`:
  `{ userId, status: active|archived, title, timeline[], floor, agentState{}, summaries{}, links[],
  chain, createdAt, archivedAt }`. One `active` per user (partial unique index). No tier, no TTL, no cap.
- **Timeline message:** `{ id, agent, role, kind: msg|handoff|decision|card|sealed, content, ref, at }`.
- **`services/entityContext.service.js`** — ONE way to seal and load an agent's context on any entity:
  `sealContext(kind, id, agent, ctx)` / `loadContext(kind, id)`. Field `agent_context` on setups, scans,
  coverage and the book. Replaces `setups.chat_state`, `portfolio_chats.messages`, `scan.chat`.
  `SCAFFOLD_FIELDS` follows the field.
- **API** `/api/sessions`: `GET /active`, `POST /new` (archive + open), `GET /` (history), `GET /:id`.
- **Delete:** `thread.service.js`, `thread.util.js`, `api/threads/*`, the `/api/threads` mount,
  `ensureThreadIndexes`; `portfolioChat.service.js`'s chat half (`saveChatState`, `getChatState`,
  `deleteChatState`, the draft writes in `persistStreamOutcome` / `persistStoppedTurn`, the draft read in
  `loadStreamContext`), `/api/portfolio/chat-state`, `chatState.util.js`. `deriveTitle` / `_lastLine`
  move into `session.util.js`.
- **Rename** `portfolio_chats` → `portfolio_books` (§1 q3) — the five book readers and `tradeCapture.service.js`'s
  `COLLECTION` import follow; the migration renames the collection.

Tests: delete `thread.util`, `threadAgents`, `threadUnfinished`; rewrite `portfolioStoppedTurn`; new
session + entityContext suites (one-active-per-user, archive, links, seal/load round trip).

### 5.1 Phase 3 — detailed plan (2026-10-16, for Roy's approval)

Read before writing it: every reader and writer of `threads`, `setups.chat_state` (in `entities`),
`scans.chat`, `coverage`, `portfolio_chats`. Facts that shaped it:
- **Pythia and Aether persist through `threads` too** (StrategyPanel/AetherPanel `saveDraft`/`getThread`;
  Pythia links to `industry_view`). Deleting `threads` means the session store must serve their
  separate panels as well.
- **Coverage is HOUSE data** — no owner, one thesis per symbol, a strict field whitelist
  (`normalizeCoverage`). An admin's Prometheus conversation written ONTO the coverage doc would be
  read by the other admin and travel with the house document. Today a revise starts with no history.
- `portfolio_chats` is keyed `{portfolioId, userId}` and has no indexes. (The sweep's report that
  `getPendingThemisChecks` was dead was wrong — `monitoring/themis.monitor.service.js` calls it; it stays.)
- No transcript store has a size cap.

**Three decisions this plan asks for (my recommendation first):**

- **D1 — The old stores die when their last caller moves, not in phase 3.** Phase 3 is ADDITIVE on the
  backend: sessions and agent contexts exist beside `threads`, `chat_state`, `scan.chat` and the chat
  half of `portfolio_chats`, and nothing the frontend calls changes — so the app keeps working and can
  be driven between phases. Each old store is deleted in the phase its last caller moves (the desks
  in phase 4 move the server side; the frontend in phases 7–8). Same rule as §0, applied to the
  caller rather than the phase number. *Alternative:* delete in phase 3 and accept a broken app on
  the branch until phase 8.
- **D2 — Sealed context lives in its own collection, keyed by the entity — not as a field on it.**
  `agent_contexts`, one row per `{userId, kind, entityId, agent}`. It works the same for an owned
  entity (setup, scan, book) and a house one (coverage, industry view): each user's conversation stays
  theirs. The entities' schemas do not change (no whitelist edits, no transcript in the setup that the
  monitors and pop-outs load). The design's "sealed onto the entity" holds in meaning — the context
  is found BY the entity and dies with it. *Alternative:* an `agent_context` field per entity, with a
  coverage exception.
- **D3 — The timeline is its own collection too.** `sessions` holds the header; `session_messages`
  holds one row per timeline message with a per-session `seq`. An endless chat as one growing array
  would approach Mongo's 16 MB document limit and rewrite the whole array on every turn; rows make a
  turn one insert, replay-after-reconnect one `seq > n` query (§1b q3), and sealing a `deleteMany`.

**Data model**

```
sessions          { sessionId, userId, scope: 'main'|'strategy'|'aether', status: 'active'|'archived',
                    title, summary, floor, agentState: { [agent]: {...} }, summaries: { [agent]: { text, throughSeq } },
                    links: [{ kind, id, agent, at }], seq, createdAt, updatedAt, archivedAt }
  indexes: sessionId unique · { userId, scope, status } partial-unique on status:'active' (ONE active
           per user per scope) · { userId, scope, archivedAt: -1 } (history)
session_messages  { sessionId, seq, agent, role: 'user'|'assistant', kind: 'msg'|'handoff'|'decision'|'card'|'sealed',
                    content, ref, to, at }
  indexes: { sessionId, seq } unique
agent_contexts    { userId, kind, entityId, agent, messages: [{ role, content, at }], summary, artifacts: [...],
                    sealedAt, updatedAt }
  indexes: { userId, kind, entityId, agent } unique · { kind, entityId } (cleanup on entity delete)
```

- `scope` gives Pythia and Aether their own single running session each (decision 16: separate panels),
  on the same store — so `threads` can be deleted outright later, not kept for two desks.
- `ref` on a message points at what it carries (an artifact, a card id, a sealed entity); `to` is the
  receiving agent of a hand-off — what `contextFor` reads in phase 4.
- **Size guard:** content is text only; tool payloads, scan rows and coverage stay on their entities
  (§3.10). A message over 32 KB of text is cut with a marker. A sealed context keeps its last 200
  messages plus its summary.

**Code (backend only)**

- `services/session.util.js` — pure: `newSessionId`, `deriveTitle` (moved from thread.util), `nextSeq`,
  `toTimelineMessage` (validate + cut), `segmentOf(messages, agent)` (an agent's own messages + hand-offs
  addressed to it — the seed of phase 4's `contextFor`).
- `services/session.service.js` — `ensureSessionIndexes`, `getActive({ userId, scope })` (creates one if
  none), `startNew({ userId, scope })` (archives the active one: title + summary, then opens a new one),
  `list({ userId, scope })`, `get({ sessionId, userId })`, `append({ sessionId, userId, message })`,
  `messagesSince({ sessionId, userId, afterSeq, limit })`, `setAgentState`, `addLink`. Every read and
  write is owner-scoped by `userId`.
- `services/agentContext.service.js` — `ensureIndexes`, `seal({ userId, kind, entityId, agent, messages,
  summary, artifacts })` (append to an existing row: an edit adds to the history), `load({ userId, kind,
  entityId, agent })`, `removeFor({ kind, entityId })`.
- `api/sessions/` — `GET /api/sessions/active?scope=`, `POST /api/sessions/new`, `GET /api/sessions`,
  `GET /api/sessions/:id/messages?after=`. Read-only plus "new" in this phase; turns arrive in phase 5.
- `server.js` — mount, `ensureSessionIndexes`, `agentContext.ensureIndexes`.
- **Rename `portfolio_chats` → `portfolio_books`** (§1 q3) in `portfolioChat.service.js`'s `COLLECTION`
  and `tradeCapture.service.js`'s import; `scripts/rename-portfolio-books.mjs` (idempotent; renames if
  the old name exists and the new one does not) run on axl_dev now, on prod in the deploy runbook.
  Add the missing `{ portfolioId, userId }` unique index.

**As done (2026-10-16):** all of the above, as planned. `tests/helpers/memDb.js` gained `$gt`/`$lt`,
`$inc` and `findOneAndUpdate`. `collectionNames.test` lists the three new collections and
`portfolio_books`. `removeFor` exists but is not yet called from entity deletes — that wiring goes with
sealing in phase 4. **The axl_dev move RAN on 2026-10-17** (18 books, same _ids, old collection dropped, unique index ok).
The script copies-verifies-drops rather than renaming: the client runs the Stable API strictly and
`renameCollection` is not in API Version 1. It also absorbs the EMPTY `portfolio_books` the new code creates
at startup — prod will see the same if the new code starts before the script. New tests: sessionUtil, sessionService,
agentContext, sessionsController (32). Suite 4002/0.

**Not in phase 3:** desks reading/writing the session (phase 4), sealing calls at Generate (phase 4),
the turn endpoint and channel (phase 5), anything in the frontend (7–8), the migration (9).

**Tests:** `session.util` (seq, cut, title, `segmentOf` never returns another agent's message); 
`session.service` against `tests/helpers/memDb.js` through a `deps.db` seam (the pattern the Pythia
services use) — memDb gains `$gt` (for `messagesSince`); it does not enforce unique indexes, so
"one active per user per scope" is asserted on the service's own logic (an upsert on
`{userId, scope, status:'active'}`), the partial-unique index being the production backstop. Cases: one
active per user per scope; `startNew` archives; owner scoping — another user's sessionId returns
nothing; `messagesSince` ordering; `agentContext.service` (seal → load round trip; a second seal appends;
another user's context is invisible; `removeFor`); the sessions routes (auth, scope validation);
`rename-portfolio-books` idempotency. QA loop + bug hunt + conflict check; no browser drive needed (no
UI changes).

## 6. Phase 4 — Per-agent context, floor, summaries

- **`contextFor(session, agent)`** in `session.util.js` — that agent's own messages + the artifacts
  addressed to it + its summary. Called by `runDeskTurn`, never by a desk.
- **`agentState`** replaces the client `chatState`: Mentor's draft + ledger (`agentState.mentor`, same
  shape, `mentorBuild.util.js` unchanged), Prometheus's `active_symbol` / `coverage_symbols`, Atlas's
  mandate/thesis in progress. `emptyMentorState()` seeds it.
- **Floor:** `session.floor`; moved by a hop, a route tag, or "@agent". The one-job-per-agent rule
  (today's `blockedDesks`) moves server-side and Axl voices it.
- **Summaries (§6.1 of the design):** at `trimHistory`'s high-water mark, the dropped turns go to a
  background Haiku 4.5 call that folds them into `summaries[agent]`; on failure, plain trim.
- **Sealing (§6.2):** Generate paths call `sealContext` — `setups.service.generateSetup`,
  `POST /api/trade-ideas/batch` (book), `createScan`, `initiateCoverage`. The session keeps a `sealed`
  line. Edit = `loadContext` into the live session as a collapsed card; save appends.
- Delete: `savePortfolioChatState`'s link step, `chat_state` in `/api/setups/generate(-all)` bodies,
  the setup PATCH-per-turn of `chat_state`.

Tests: an agent never receives another agent's messages; artifacts arrive in order; summary fires once
per high-water mark and never touches `agentState`; seal → load round trip per entity kind.

### 6.1 Phase 4 — detailed plan (2026-10-16, for Roy's approval)

Read before writing it: each desk's chatState and how the client folds the `done` payload back, every
Generate / delete / edit path, and where history is trimmed. Facts that shaped it:
- **Mentor's next state is already computed on the server** (`mentorBuild.util` + the agent); the
  client only copies `setup`→`draft`, `coverage`, `drafts` back and clears `ops`. Its display state
  (`gate`, `readiness`, the candidate `setups`) lives only in the panel. Today `drafts` (multi-name) is
  dropped by both the draft thread and `chat_state`.
- **Prometheus** re-derives `coverage_symbols` / `existing_coverage` server-side every turn
  (`_resolveCoverageContext`); only `active_symbol` and the coverage draft are real state.
- **Argus**'s body flags are conversation-long mode (`handoff`, `handoffTo`, `radar`/`radarBoard`,
  `profile`) plus the list being edited (`editList` = `pendingScan` while editing).
- **Atlas** already persists mandate / thesis / lifecycle server-side once a `portfolioId` exists
  (`portfolio_books`); a book under construction keeps its mandate in the draft thread.
- **Axl** and **Aether** carry no state; **Pythia** keeps its pending views client-side.
- Generate: setups `/generate(-all)` (+ update), `/trade-ideas/batch` + `savePortfolioChatState`,
  `createScan` / `updateScan`, `initiateCoverage` / `updateCoverage`, `publishIndustry`. Deletes: setup,
  scan, coverage have routes; a portfolio is deleted idea-by-idea then `deleteChatState`; an industry view
  has no delete. None touches a thread today.
- Trimming is per request (`normalizeMessages` → `trimHistory`, high-water ×3); nothing trimmed is kept.

**One decision this plan asks for:**

- **E1 — Phase 4 builds the session turn as an INTERNAL service, with no new HTTP route; phase 5 adds
  the route.** The desks' definitions move out of their controllers into `services/desks/`, so ONE
  definition serves both callers: today's `makeDeskStream` (the old path the frontend still uses —
  untouched, D1) and the new `sessionTurn`. Phase 4 is exercised by tests and a live script; phase 5
  puts the endpoint, the channel and the chain on top of the same `sessionTurn`. *Alternative:* a
  temporary `sessionId` mode inside `makeDeskStream` now, removed in phase 5 — a second path to build
  and delete.

**1. One desk registry** (moved here from phase 2) — `services/desks/registry.js`: per agent
`{ agent, desk (the pipeline key the client still routes by), brand, entityKind, scope, admin, maxMessages }`.
`routing.util`'s `VALID_PIPELINES`, `ROUTABLE_DESKS`, `AGENT_DESK`, `EDIT_KIND_DESKS` and
`session.util`'s `SESSION_AGENTS` / `CONTEXT_KINDS` derive from it — five hand-kept lists become one.

**2. Desk definitions** — `services/desks/<agent>.desk.js`, one per desk, each exporting
`{ agent, parse(body), run(ctx), done(result), nextState(prev, result, input), stateFromEntity(entity) }`:
- `parse` / `run` / `done` are today's controller code, moved (controllers become one line:
  `makeDeskStream(mentorDesk)`).
- `nextState` is the fold the client does today, done once on the server:
  - Mentor: `{ active_asset, draft: result.setup ?? prev.draft, coverage, drafts, view: { gate, readiness, setups } }`
    — `drafts` kept (fixes the drop), `view` is what the side pane draws after a reload; `ops` never stored.
  - Prometheus: `{ active_symbol, draft: result.coverage ?? prev.draft }`.
  - Argus: `{ profile, mode: { handoff, handoffTo, radar, radarBoard }, pendingScan: result.scan ?? prev.pendingScan, editingScanId }`.
  - Atlas: `{ portfolioId, mandate, thesis, reviewMode, adoptDraftId, pendingPlan, reviewUpdate }` — the
    construction mandate moves here from the draft thread; a built book keeps reading `portfolio_books`.
  - Pythia: `{ draft views }`. Axl, Aether: none.
- `stateFromEntity` rebuilds a desk's working state from the entity alone, for an edit: setup →
  `chat_state.draft`, else `normalizeSetup(doc)` (the legacy fallback the client builds today, moved); scan
  → its list and fields; coverage → the doc as draft + `active_symbol`; book → `portfolioId` + `reviewMode`.

**3. `contextFor(session, agent)`** — `services/desks/context.js`, built on `session.util.segmentOf`:
the agent's sealed context when it is editing an entity (`agent_contexts`), then its summary (as one
leading user turn), then its segment after the summary's `throughSeq`. A hand-off TO the agent reads as a
`user` turn (someone asking it); its own as `assistant`. `normalizeMessages` then coalesces and applies the
desk's `maxMessages` exactly as today.

**4. `sessionTurn`** — `services/desks/sessionTurn.js`:
`sessionTurn({ userId, sessionId, agent, text, ops, seed, emit, signal })` →
append the user message → build the conversation (`contextFor`) and the desk's input from
`agentState[agent]` (+ `ops` / `seed`, one-shot) → `desk.run` with the shared `common` bag (moved out of
`makeDeskStream` into one helper both use) → append the assistant message (`cleanReply` text) →
`setAgentState(nextState)` → move `floor` when the reply routes (registry: desk → agent) → return
`done(result)` + routing. `emit` carries the SSE callbacks; phase 5 points it at the session channel.

**5. Summaries** — `services/desks/summarize.js`: after a turn, when an agent's segment past
`throughSeq` exceeds `maxMessages × 3`, the oldest messages down to `maxMessages` are folded into
`summaries[agent] = { text, throughSeq }` by a background Haiku 4.5 call (fixed model, booked to the user's
usage like any call). It never touches `agentState`. On failure nothing changes — the turn is trimmed by
`normalizeMessages` exactly as today.

**6. Sealing and editing** — `services/desks/seal.js`:
- `sealFromSession({ userId, sessionId, agent, kind, entityId, name })`: the agent's segment since its last
  seal → `agentContext.seal` (with its summary); the agent's OWN rows leave `session_messages` (hand-offs
  stay — they are the sender's turns too); one `sealed` line is appended ("Mentor built AMD setup",
  `ref: { kind, id }`); `addLink`; `agentState[agent]` cleared.
- The Generate endpoints take an optional `sessionId` and call it after the entity is saved: setups
  `/generate`, `/generate-all`, update; `/trade-ideas/batch` (book); `createScan`, `updateScan`;
  `initiateCoverage`, `updateCoverage`; `publishIndustry`. Without a `sessionId` (today's frontend) they
  behave exactly as now.
- `openForEdit({ userId, sessionId, kind, entityId })`: `agentState[agent] = stateFromEntity(entity)`
  + `editing: { kind, entityId }`, a `sealed` card line with the context's summary and last few turns,
  `floor = agent`. The next Generate on that entity appends to the same sealed context (§6.2 step 3).
- `agentContext.removeFor` wired into the delete paths: setup, scan, coverage, and the portfolio's
  `deleteChatState` (an industry view has no delete).

**7. Live verification** — `scripts/drive-session-turn.mjs`: a real Axl → Mentor conversation through
`sessionTurn` on axl_dev (Axl routes, the floor moves, Mentor builds, a Generate seals, an edit reopens),
printing each step. A few cents of model spend. **Needs the Atlas access list fixed** (the phase-3
rename is blocked on the same thing).

**As done (2026-10-17):** 4a registry (4f20def) · 4b desk definitions (89d3f2f) · 4c sessionTurn, nextState,
contextFor, summaries (be9728c) · 4d sealing, openForEdit, Generate hooks, delete cleanup (7d8ef05) · 4e live drive.
- The live drive found a real gap: Axl routes "build a trade" to the COMPOSITE `trade` pipeline, which named
  no agent, so the floor never moved. The registry now gives a composite its entry (`trade` → Argus, preset to
  pick one name for Mentor — the client's entryTab) and the session turn uses it. Drive re-run: PASSED
  (route → Argus single-pick → its own context → seal → reopen → it remembers → cleanup).
- Seen in the drive, not fixed: a model emitted a corrupted `<䏕ticker>` tag; cleanReply unwraps only a clean
  `<ticker>`, so the markup reached the reply (the old per-desk code had the same pattern).
- `chatState.util.js` deleted (one caller left, inlined). Suite 4040/0.

**Not in phase 4:** the HTTP turn endpoint, the session channel, hand-offs between agents, the chain and
its stop rule, "@agent" and the busy-agent rule (phase 5); anything in the frontend (7–8). **Deleted in
phase 4:** nothing the frontend still calls (D1) — the moved controller code is a move, not a copy.

**Tests:** registry (every derived list matches what it replaced); each desk's `nextState` and
`stateFromEntity` (pure); `contextFor` (never another agent's turn; hand-off roles; summary placement;
sealed context first when editing); `sessionTurn` with a stub `run` on memDb (append → state → floor; a
stopped turn keeps the user message and stores no state); `summarize` (fires once per high-water mark,
never touches agentState, failure is a no-op); `seal` (rows leave, hand-offs stay, line + link added,
state cleared; a second seal appends); `openForEdit`; each Generate with and without `sessionId`;
`removeFor` called by each delete. Existing controller tests keep passing unchanged (the move must not
change one byte of the old path's behaviour).

## 7. Phase 5 — The chain runner (backend)

- **Port the conveyor to `services/chain/`:** `artifact.js`, `hop.js` (pure — ports as-is, its 28 tests
  come with it), the live contracts (`candidate_list`, `coverage_set`) with their `brief()` functions, and
  the two openers that live in panels today (MentorPanel's inbox opener, AnalystPanel's queue prompt).
  `sanitizeScanSeed` becomes the `candidate_list` item validator. The candidate item shape is built once.
- **Runner:** a desk's done payload that emits an artifact → append a `handoff` message → move the floor →
  run the receiver's turn headless, streamed to the session channel. Chain state lives in `session.chain`
  (survives a restart). The client `pipelineMode` toggle and `step.gate` go — always automatic, stopped
  only by the stop rule.
- **Stop rule:** a desk turn that needs the user appends a `decision` message and halts the chain; the
  user's answer resumes it. New decision cards: **Atlas mandate approval**, **Mentor sizing**. Existing:
  CandidatePicker, StageConfirm, SpanTable, EntryTable, Generate, Arm, review accept, AVOID confirm, order
  confirm, workspace pick.
- **Sleeve sourcing** stays a code screen (§1 q1 = a), shown in the timeline as Argus's work ("Argus
  screened 40 → 8") with the result written into Argus's context so a follow-up to Argus works; its in-memory `state.sleeves` moves into `session.chain`; the
  `sleeve_sourced` card's `threadId` becomes a session/entity link.
- **One turn endpoint + session stream** (§1 q2): `POST /api/sessions/turn`, `GET /api/sessions/events`;
  the per-desk `/stream` routes go (Strategy and
  Aether keep theirs — separate panels).

### 7.1 Phase 5 — detailed plan (2026-10-17, for Roy's approval)

Read before writing it: the live transports (per-turn SSE + `turnRegistry`, the social-chat WebSocket),
the frontend conveyor (hop / artifact / contracts / DESKS steps / the two panel openers), sleeve sourcing,
the user decision points, and every concurrency guard. Facts that shaped it:
- **The social chat's WebSocket already is most of the channel** (`api/chat/chatWs.js`): cookie-JWT auth on
  upgrade, a per-user socket set (every tab and device), a 30 s heartbeat, `emit(userId, event, data)`, a
  client that reconnects every 3 s. No replay — clients re-read over REST on `connected`. Single process,
  same as every other request-path state (docs/architecture/single-instance.md).
- **Only two artifact kinds are live**: `candidate_list` (Argus → Mentor for one pick, Argus → Prometheus
  for a research list) and `coverage_set` (Prometheus → Atlas). With no pipeline steps on the server,
  `hop.js` is not needed: a kind has exactly one receiver (`mentor` / `analyst` / `portfolio` accept them).
  The openers live in two panels (MentorPanel's "I want to work on a X trade — the read on it is …",
  AnalystPanel's queue prompt) and in one contract's `brief()` (Atlas's `briefCoverage`).
- **No turn lock exists anywhere**: nothing stops two turns on one session, or one agent, at once.
- **Sleeve sourcing** keeps its sleeves in memory, ends in a `sleeve_sourced` card with "Resume build",
  and loses the pending sleeves on a restart.
- **No step declares a gate today**; the decisions are client buttons (Generate, Arm, review accept, AVOID
  OK, order confirm) — the server already enforces the money ones.

**Four decisions this plan asks for (my recommendation first):**

- **G1 — The session channel rides the EXISTING WebSocket, not a new SSE stream. Roy, 2026-10-17: yes.** One live transport per
  user (the shared-pipe rule): new events on the same socket — `session_message`, `session_delta` (streamed
  tokens / status / reasoning / chart of a running turn), `session_removed` (seqs a seal took out),
  `session_state` (floor, an agent's state changed), `session_turn` (started / done / stopped / error). Replay
  is a client `session_sync { sessionId, afterSeq }` frame answered from the store (`messagesSince`), sent on
  every (re)connect — it replaces the REST re-read the social chat does. A turn still streaming is sent once
  as its text so far, then live (§1b q3). *Alternative:* the SSE channel §1b sketched — a second transport.
- **G2 — The turn endpoint returns at once; everything streams on the channel.**
  `POST /api/sessions/:id/turn { text, agent?, ops?, seed?, accounts?, mainAccountId?, clientTime?, turnId }`
  → `202 { turnId }`. The turn registers in `turnRegistry`, so the existing `POST /api/turns/:turnId/stop`
  stops it. *Alternative:* stream the user's own turn on the POST response and only chain turns on the
  channel — two ways for one thing.
- **G3 — The server needs no pipeline steps.** The conveyor ports as `services/chain/`: the two live kinds,
  `receiverOf(kind)`, each receiver's opening brief (Mentor's and Prometheus's openers move out of the
  panels into it, Atlas's `briefCoverage` too), and the runner. `hop.js` / `doors.js` / `DESKS[].steps` do
  not come along; they leave the frontend in phase 7. `mandate` / `scan_request` die here (dropped from the
  port; their frontend copies go in phase 7).
- **G4 — §1b's four proposals become the rules**, as written there: a user interjecting pauses the chain
  after the running turn (and the agent offers "Continue"); a restart marks a running chain paused and the
  floor-holder asks "I was interrupted — continue?" (never an automatic re-run); replay by seq on reconnect;
  a turn is a decision by a declared table, not by the model.

**5a. The channel** — `services/sessionChannel.js` (one module; chatWs stays the socket owner):
`emitSession(userId, event, data)` over `chatWs.emit`; the `session_sync` frame handled in chatWs's message
switch → replay rows with `seq > afterSeq` + the running turn's text so far. `sessionTurn` gets an `emit`
that forwards to it; `sealFromSession` emits `session_removed` + the line; state and floor changes emit
`session_state`.

**5b. The turn endpoint** — `api/sessions`: `POST /:id/turn`, `POST /:id/edit { kind, id }` (openForEdit, the
entity resolved owner-checked through its own service), `POST /:id/continue` (resume a paused chain).
- **Who answers:** `agent` when given (a tap on an agent), else an `@Brand` / `@agent` at the start of the
  text, else `session.floor`. `canSpeak` gates it.
- **One turn at a time per session** — an in-process per-session lock (`services/desks/turnLock.js`): a turn
  posted while another runs is QUEUED behind it (not refused, not interleaved); a user turn arriving while a
  chain runs sets the chain to pause after the current turn (G4).
- **Busy agent:** an agent's working state carries `job: { origin: 'user'|'chain', chainId }`. A user turn
  routed to an agent busy in a chain gets Axl's sentence instead ("Argus is in the middle of Atlas's scan —
  finish that first or set it aside?") as a `decision` with two taps; "set it aside" ends that chain step.
  `openForEdit`'s `busy` refusal goes the same way, and its tap passes `force`.

**5c. The chain** — `services/chain/`:
- `artifact.js` (`candidate_list`, `coverage_set`, `STATUS`, `makeArtifact`), `contracts.js` (per receiver:
  `accepts`, `brief(artifact)` → the opening sentence; the two panel openers and `briefCoverage`, moved).
- `emits.js` — per desk, what in a `done` payload is an artifact: Argus's `kairos_pick` in single-pick mode
  → a one-item `candidate_list` for Mentor; Argus's research list → a queued `candidate_list` for Prometheus
  (context: `queued`, `pool`, `bySector`); Prometheus finishing the queue → `coverage_set` for Atlas.
- `decisions.js` — the declared table (G4): Mentor `gate` open / `setups` offered / a ready `setup`; Atlas
  `plan` / `update` / `mandate` proposed; Argus a watchlist outside single-pick mode; Prometheus a coverage
  draft; any `route`. A match appends a `decision` message (the view its card draws from) and stops.
- `runner.js` — after every turn: decision? stop. Emitted artifact? append a `handoff` message
  (`agent` = sender, `to` = receiver, content = the receiver's brief, `ref` = the artifact), move the floor,
  run the receiver's turn with NO user message (`sessionTurn` gains `origin: 'chain'`, which reads the
  hand-off as its prompt). Repeat until a decision, a pause, or nothing emitted. Prometheus's queue runs one
  name per turn in the same loop.
- **Chain state** in `session.chain = { id, status: running|paused|done, origin, step, queue, startedAt }` —
  written before each step, so a restart finds it. **Boot sweep**: every `running` chain → `paused` + the
  floor-holder's "I was interrupted — continue?" decision (G4).
- A cap of 12 automatic steps per chain, then a decision ("keep going?") — a runaway loop costs at most that.

**5d. Sleeve sourcing joins the chain** (decision 1a: a code screen, shown as Argus's work): a sleeve sourced
from a session carries `sessionId`; on settle, instead of only the card, Argus's line ("Argus screened 40 → 8
for the growth sleeve") is appended with the result written into Argus's segment, then the `coverage_set`
hand-off to Atlas runs. A sleeve sourced from the old HTTP path keeps its card exactly as today (D1).

**5e. Live verification** — `scripts/drive-session-chain.mjs`: Axl → trade → Argus single-pick → automatic
hand-off → Mentor opens on the pick → stops at Mentor's first decision; an interjection mid-chain pauses it;
`continue` resumes; a simulated restart (the sweep run on a `running` chain) asks to continue; a seal emits
`session_removed`. On axl_dev, a few cents — with a WebSocket client in the script to see the events arrive.

**Not in phase 5:** background cards into the timeline (phase 6); anything in the frontend (7–8); the per-desk
`/stream` routes stay until the frontend moves (D1).

**Tests:** channel (emit shapes; `session_sync` replays after a seq; a running turn's partial text sent once);
turn endpoint (agent selection: explicit, `@mention`, floor; `canSpeak`; 202 + stop through the registry); turn
lock (a second turn queues, never interleaves; an interjection pauses a chain); busy rule (the decision and its
two taps; edit `force`); chain (each emit → the right receiver with the right brief; each decision row stops;
the step cap; Prometheus's queue one per turn; chain state written before each step; the boot sweep pauses and
asks); sleeve settle → Argus line + Atlas hand-off, and the old card path unchanged. Existing suites unchanged.

**Phase 5 as done (2026-10-17):** 5a channel (85729fb) · 5b turn endpoint (3341936, ce50064) · 5c chain (3f79a30) ·
5d sleeve sourcing into the chain (e9c5213) · 5e live drive (scripts/drive-session-chain.mjs): PASSED — the turn engine
streamed over the WebSocket path (812 frames), the hand-off reached Mentor and its chain turn ran with no user
message and stopped for the user, the restart sweep asked and Continue re-ran the step, a seal sent session_removed.
Argus declined to pick NVDA (its own call: the name did not validate), so the drive handed the chain a pick — the
hop and Mentor's chain turn were real; Argus choosing to pick was not exercised live.
- Busy rule, as built: it applies where the CHAIN wants an agent that holds the user's own unsealed work (finish /
  set it aside). A user turn to an agent mid-chain simply pauses the chain (G4) — the user is taking the wheel.

## 8. Phase 6 — Background cards into the timeline

- Themis moves onto `postCard` (one transport, no exceptions).
- Hook inside `postBotCard` after the message is written: append a `card` message to the user's active
  session and push it on the session channel. Supersede and resolve mirror `_supersedePending` /
  `message_resolved`. SocialChat keeps its copy.
- Card actions that open a desk today (`RESUME_BUILD`, `SETUP_INVALIDATION_EDIT`, `SETUP_SHARED_OPEN`,
  `MARKET_BRIEF_OPEN`, `OPEN_COVERAGE`, `SETUP_CONFIRM_OPEN`) become "floor → agent, load the entity's
  context" through one client call.

### 8.1 Phase 6 — detailed plan (2026-10-17, for Roy's approval)

Read before writing it: postCard → postBotCard, every producer and its card type / botId / scope, supersede,
resolve (by message id, by subject, house twins), the frontend card actions, card volume. Facts that shaped it:
- **No card fires often.** Talos latches its gates and re-fires a manage verdict only on higher urgency; the
  market brief offer is at most one per user per weekday; supersede keeps ONE live ask per type + subject.
  Mirroring every card into the chat does not flood it.
- **Every post is one row for one user.** House cards (coverage events, Pythia's industry views, house
  coverage refreshes) are a caller loop over the admins — one row per admin; the brief offer loops over all.
- **A card's state changes without the user**: supersede, and house-twin settlement (one admin's "done"
  settles the other's). Resolution is addressed by the `chat_messages` id (+ conversation) — the
  `message_resolved` frame carries exactly that.
- **Themis still calls `postBotCard` directly**, bypassing `postCard`. `resolvePortfolioReviewCard` sends no
  live `message_resolved` at all.
- **botIds**: axl, portfolio, mentor, analyst, strategy map 1:1 to desks; `kairos` posts the archived calls'
  cards (branding kept — CLAUDE.md); Talos posts as mentor, Themis as portfolio, the coverage monitor as
  analyst. Pythia's cards belong in Pythia's own session scope, not the main chat.
- Card actions fall in four groups: **open a dialog** (order confirm, setup confirm, the queued list, the
  setup pop-out) — stays a dialog; **edit an entity** (setup invalidation → Mentor, coverage event / refresh →
  Prometheus, portfolio review → Atlas) — becomes a session edit (openForEdit + floor); **an Axl turn** (the
  market brief); **an inline form** (manual entry/exit) — stays.

**Three decisions this plan asks for (my recommendation first):**

- **H1 — The timeline row REFERENCES the card; it is not a second copy.** One `card` message per card:
  `{ agent, kind: 'card', content: the card's text, ref: { msgId, conversationId, type, subject, action } }`.
  Its live state (pending / done / dismissed / superseded) is read from `chat_messages` and moved by the same
  `message_resolved` frame the social chat already receives — keyed by `msgId`. The card store stays the one
  record; SocialChat keeps its copy (decision 15). *Alternative:* copy the status into the timeline row and
  keep it in step on every supersede, resolve and twin settlement — three places to forget.
- **H2 — Every desk card mirrors, the daily brief offer included.** The volume above is low by construction;
  a card that does not mirror is an alert the chat does not show. DMs between users (`setup_shared`, a human
  sender) stay in SocialChat only — they are not desk cards. *Alternative:* skip the broadcast brief offer.
- **H3 — A card lands only in a session that ALREADY EXISTS, in its agent's scope.** No session is created
  for a card (a user who never opened the chat gets the card in SocialChat, as today). Pythia's industry-view
  cards land in the admin's `strategy` session, if one exists; everything else in `main`.

**Code (backend)**

- `api/chat/chat.service.js` — `onCardPosted(fn)`: a hook `postBotCard` calls after the row is written
  (registered, not imported — the chat layer never depends on sessions, the pattern `onSleeveSettled`
  set). The hook gets the stored message and its botId; a throw in it never fails the post.
- `services/sessionCards.js` — the registered hook (one module):
  - `agentOfBot(botId)`: axl / portfolio / mentor / analyst / strategy → themselves; `kairos` → axl (the
    archived calls' cards still read in the chat; their desk is gone).
  - the scope from the registry; `sessionService.findActive({ userId, scope })` — a new store read that
    never creates; no active session → nothing appended.
  - `cardAction(message)` — the action the timeline card offers, from the card type: `{ type: 'dialog',
    event, ids }` (the client's existing doorway), `{ type: 'edit', kind, id }` (→ `POST /:id/edit`),
    `{ type: 'turn', agent: 'axl', text }` (the brief), `{ type: 'form' }` (manual entry/exit). ONE table, so
    the side pane and the timeline never decide it twice.
  - appends `{ agent, role: 'assistant', kind: 'card', content, ref: { msgId, conversationId, type, subject, action } }`
    — the append pushes `session_message` like every other row.
- **Resolve stays one path**: `message_resolved` already reaches every socket the user has; the timeline client
  matches it on `ref.msgId`. Plus: `resolvePortfolioReviewCard` emits `message_resolved` (the gap found).
- **Themis moves onto `postCard`** (one transport, no exceptions — the plan's phase 6 bullet).
- **A card whose sleeve already settled into the session** (phase 5d) is never posted, so it never mirrors twice.

**Not in phase 6:** rendering the card in the timeline and wiring its action (phase 7–8); any change to how
cards are built, superseded or resolved.

**Tests:** the hook is called once per post and a throw in it never fails the post; `agentOfBot` for every
botId in use (incl. `kairos` → axl, unknown → axl); scope routing (Pythia → `strategy`, the rest → `main`);
no active session → nothing appended, and no session is created; the row carries `msgId` / `conversationId` /
`subject` / `action`; `cardAction` for every card type in use (dialog / edit / turn / form / none); house cards
mirror per admin into each admin's own session; Themis posts through `postCard`;
`resolvePortfolioReviewCard` emits `message_resolved`. Existing card suites unchanged.

**Phase 6 as done (2026-10-17):** H1–H3 approved by Roy. chat.service onCardPosted (desk cards only, never
`type: text`) → services/sessionCards.js (agentOfBot, scope, findActive — never creates, cardAction — the one table) ·
Themis on postCard · resolvePortfolioReviewCard emits message_resolved. Live check on axl_dev: a real postCard landed as a
reference row (agent mentor, msgId + conversation + action), then both copies were removed and the conversation preview
restored. Suite 4097/0.
Phase 6 CR (2026-10-17): a superseded card now sends message_resolved (it sent none, so the timeline showed two live
asks) · the mirror keeps post order per user (mirrorInOrder) · one timestamp for a review resolve · chat.service and
Themis gained test seams (`_setDeps`; Themis `post`). Carried to phase 7: the review card's "next review <date>" line
reads its payload, which message_resolved does not carry.

**REVERTED (Roy, 2026-10-18) — H2 overturned: desk cards are NOT mirrored into the session.** Review notifications
(and every desk card) live, and are acted on, in the social chat only, as before the unified chat. Removed: the
`onCardPosted` hook, `services/sessionCards.js` (mirror, `cardAction`, `hydrateCards`), `cardsById`, append's `live`,
the `card` message kind; frontend: the timeline's card row, `useSession.resolveCard`, the reducer's
`message_resolved`. KEPT (the social chat uses them): Themis on `postCard`, the supersede and portfolio-review
`message_resolved` frames (`tests/unit/cardResolveFrames.test.js`). Card rows already written to `session_messages`
fall through as plain text and are in no agent's context; delete them with
`db.session_messages.deleteMany({ kind: 'card' })` (axl_dev only — prod never had the branch).

## 9. Phase 7 — Frontend: session client + timeline

- **`services/session/session.service.remote.js`** replaces `threads.service.remote.js`.
- **`useSession()`** — subscribes to the session channel, sends turns, handles stop/continue ONCE (the
  seven `_continue` copies go), exposes `timeline`, `floor`, `agentState`.
- **`ChatTimeline`** — built on the shared pieces (`AgentMessages`, `ChatBubble`, `AgentChatInput`,
  `SuggestionChips`, `AgentGlyph` + `AGENTS`): agent header per speaker run, hand-off divider with artifact
  card, decision card slot, sealed-context card, tap-to-answer on any agent's turn.
- **Card rows** (phase 6) draw from `ref` and follow `message_resolved` by msgId; on resolve the card re-reads
  its row, so payload-borne lines (a review's "next review <date>") are fresh — the frame carries status only.
- **AxlHub shrinks to the greeting + Axl's opening.** Delete: desk cards, chip strip, ticket card,
  `TicketGlyph`, summon screen, `_summon` / `pendingRoute`, `deskBadge` / `deskLockTitle` / `blocked` /
  `resumableThread` / `handleDeskPick` / `handleTicketPick`, the unfinished fetch, the draft restore,
  `_sendReturn`, its private `MessageBubble` / scroll / input. Keep and lift: `suggestions`,
  `LANDING_ASKS` (become the opening's tap options), `ShowOffer`, `_sendBrief`.
- **Axl prompt** (`axl_system_prompt.md`): the opening question, intent → agent, leftover-work and
  busy-agent sentences, the order-ticket intent.
- Delete: `RouteOffer.jsx`, `useRouteOffer.js`, AxlHub's inline route reader, `useDeskHandoff.js`,
  `doors.js`, `contracts.js` + the four `*.contract.js` (ported in phase 5), `pipelineNav.js`,
  `deskWork.js`, `deskReset.js`, `ThreadHistory` (→ session history), `AgentSummon` / `AxlBotGlyph`,
  `SUMMON_MS`, `RETURN_MS`, `TICKET_DESK`, `DESKS[].steps`. Keep `AgentIntro`, `AgentTurnTag`,
  `BotAvatarGlyph`.

### 9.1 Phase 7 — detailed plan (2026-10-17, for Roy's approval)

Read before writing it: AxlHub (998 lines) and its tests, the threads client and its nine importers, the chat
socket client, the shared chat pieces, the six desk panels' send / persist / continue paths, MainPage's chat
column, SocialChat's card dispatch, the event bus, and the backend's session routes, frames and turn payloads.
Facts that shaped it:
- **Nothing on the client speaks to sessions yet.** No `/api/sessions` call, no `session_*` listener, and the
  socket client cannot SEND (`chatWsService` has `connect / disconnect / on / off`; its only outbound frame is
  the ping). It is connected once, by `useChatWs` in AppHeaderAxl.
- **The desk panels are entangled with their own transport.** Each one streams to `api/<agent>/stream`
  through its own `useChatStream` state, persists through threads or an entity's `chat_state`, and draws its
  working UI (Generate, pickers, summaries) from that state. They cannot be pointed at the session one by one;
  they come out together with the surfaces in phase 8.
- **What a reply carries beyond prose dies on reload.** `suggestions` (the tap options), `chart` and `show`
  ride only the live `session_turn: done` payload; the stored row holds `content` alone.
- **The server moves the floor on a route but does nothing else with it.** Axl's `opening` (the user's words
  to carry), its `edit` (reopen an item) and the market brief exist only on the old HTTP paths.
- **A card row is a bare reference** (`ref.msgId`, phase 6); the card bubbles need the card itself (payload,
  actions, status). SocialChat's card dispatch is an inline ternary in ChatWindow (213–251); the bubbles only
  emit on the event bus, so they render anywhere given a message and an `onResolve`.
- **Streaming on the socket is a different shape from SSE**: `session_delta {turnId, agent, type, data}` and
  `session_turn {status}`, with `session_message` as the settled row. `useChatStream` (504 lines, SSE-bound)
  does not fit; ChatBubble, ChatInputRow, SuggestionChips, ChatChart and AgentGlyph do.

**Six decisions this plan asks for (my recommendation first):**

- **J1 — Phase 7 replaces AxlHub with the timeline for EVERY agent's conversation; the desk panels stay as
  they are until phase 8, and the deletions that belong to them move to phase 8.** Between the two phases the
  branch has the timeline (talk to any agent, chains, cards) and the old panels behind the entity Edit buttons
  — two ways in for a few days, on a branch that ships nothing until phase 10. Moved to phase 8 (their
  importers are the panels and MainPage's pipeline code): `RouteOffer`, `useRouteOffer`, `useDeskHandoff`,
  `doors`, `contracts` + the four pipeline `*.contract.js` (NOT `Floor/queuedAction.contract.js`, a live
  Floor module with the same suffix), `pipelineNav`, `deskReset`, `ThreadHistory`, `AgentSummon` /
  `AxlBotGlyph` (MainPage's "Heading back" overlay), `RETURN_MS`, `DESKS[].steps`. *Alternative:* merge
  phases 7 and 8 into one — a single 5–6k-line change with no point to drive in between.
- **J2 — A reply row keeps its extras: `ref: { suggestions, chart, show }`** (each only when present). Tap
  options, the chart and the "show me" offer survive a reload and replay. No new field: `ref` already exists
  on every row. *Alternative:* keep them live-only — a reload loses the options under the last question.
- **J3 — Card rows are HYDRATED on the server, by one shared `hydrateCards(rows)`**: the messages route, the
  `session_sync` replay and the live `session_message` push attach `card: { payload, actions, status,
  resolveOutcome, resolveNote }` from `chat_messages` (one `$in` read). The stored row stays a reference
  (H1). The client renders it with ONE card dispatcher extracted from ChatWindow — `<CardBubble msg onResolve
  onClose>` — used by both SocialChat and the timeline; resolve goes through the existing
  `chatService.resolveMessage(ref.conversationId, …)`. `message_resolved` patches the status; the review
  resolve's frame also carries its `payload` patch (`resolved`, `outcome`, `nextReviewAt`), which closes
  the line carried from phase 6. *Alternative:* a client-side fetch per card — N requests per load.
- **J4 — The server acts on Axl's routing in the session.** After an Axl turn: a route WITH an `opening`
  queues the receiving agent's first turn with the opening as the user's message (the chain runner's queued
  turn — not a second runner); an `edit` runs `openForEdit` exactly as `POST /:id/edit` does (a busy agent
  → the decision card the chain already draws); `show` stays a client action (it opens a pop-out, no desk).
  The market brief becomes an Axl session turn with `input: { brief: true }` (the Axl desk calls the brief
  service) — the brief card's button and the bus event post that turn. *Alternative:* the client re-sends the
  opening as a turn — the client deciding what the server already knows.
- **J5 — Axl's opening question is a STATIC empty state, not a model turn.** An empty session shows Axl's
  greeting and tap options — *Trade it · Build a portfolio · Find ideas · Research a company · Ask about the
  app* — each sent as the user's own message to Axl, who routes (decision 10). No model call per new session;
  `LANDING_ASKS` joins the same options row. *Alternative:* a generated greeting — a model call for a
  sentence that never changes.
- **J6 — One small client reducer for the session, not `useChatStream`.** `sessionReducer(state, frame)`
  (pure, node-tested) folds `session_replay / message / removed / state / delta / turn` into `{ sessionId,
  rows, live: { turnId, agent, text, reasoning, phase, status } | null, floor, agentState, chain }`;
  `useSession(scope)` wires it to the socket and the REST client. Rendering reuses ChatBubble (a row maps to
  its `msg` shape), ChatInputRow, SuggestionChips, ChatChart, AgentGlyph + `AGENTS`. *Alternative:* adapt
  `useChatStream` — its SSE-shaped state machine for a socket that already delivers settled rows.

**Steps**

- **7a — backend (one commit):** J2 (sessionTurn appends the reply with `ref` extras; a tags-only reply with
  options still gets a row) · J3 (`services/sessionCards.js` `hydrateCards`, used by the messages route,
  `replay` and the live push; the review frame's payload patch) · J4 (route + opening → queued turn, edit →
  `openForEdit`, the brief as an Axl input) · the Axl prompt (`axl_system_prompt.md`): one chat, not "the
  desk's chat"; the opening question's options; intent → agent; leftover work ("Mentor still has your NVDA
  setup open — carry on, or start fresh?"); a busy agent; the order ticket opens as a `show`.
- **7b — client transport:** `chatWsService.send(event, data)`; `services/session/session.service.remote.js`
  (active, new, list, messages, turn, edit, continue; stop stays `turn.service.stopTurn`);
  `services/session/sessionReducer.js` + `useSession(scope)` — `session_sync` on mount and on every
  `connected` (a reconnect replays what it missed after the last seq); a client-minted `turnId` per turn.
- **7c — the timeline:** `cmps/ChatTimeline/` — `ChatTimeline` (scroll via `useChatScroll`), `TimelineRow`
  per kind: `msg` (ChatBubble; an agent header when the speaker changes), `handoff` (a divider "Atlas → Argus"
  with the artifact's one-line summary), `decision` (the question + choice buttons → `continue`; settled
  once answered), `sealed` (the reopened-context card), `card` (CardBubble); the live turn as a streaming
  bubble with its phase chip; tap options under the last reply that has them; ShowOffer lifted out of
  AxlHub; the input row with Stop (the running turn's id) — no per-desk `_continue`.
- **7d — mount and delete:** MainPage's chat column renders `ChatTimeline` where AxlHub was (the old panels
  still render on their tabs, J1); a "New session" button and a session history drawer (archived sessions,
  read-only). `MARKET_BRIEF_OPEN` posts the brief turn. Delete: `AxlHub.jsx` (its greeting SVG, options and
  ShowOffer move into the timeline's empty state), `AxlHub.test.jsx` (→ timeline tests), `deskWork.js` +
  test, `TICKET_DESK`, `SUMMON_MS`, `TicketGlyph`, the hub's private `MessageBubble`, `axlService
  .streamAxl` / `streamBrief` (their last callers go), ChatWindow's inline card dispatch (→ CardBubble).
  AxlHub.scss shrinks to what the empty state uses.
- **7e — drive:** `scripts/drive-unified-chat.mjs` (Playwright on the built bundle, the throwaway QA user):
  empty state → tap "Trade it" → Axl routes → Mentor answers in the same timeline under its own header; Stop
  mid-turn; reload → the timeline and the last tap options come back; a posted card appears live and its
  dismiss flips it; New session → history lists the old one.

**Not in phase 7:** the side pane and surfaces, MainPage's pipeline teardown, the panels (phase 8); Pythia
and Aether (their own scopes, still on their panels and threads — threads die with their last caller, D1);
migration (phase 9).

**Tests:** backend — the reply row's `ref` extras (present / absent / tags-only); `hydrateCards` (one read,
missing card → `card: null`, non-card rows untouched) on all three paths; the review frame's payload patch;
route + opening queues exactly one turn for the receiver, under the lock; a route without an opening queues
none; `edit` → `openForEdit` and busy → decision; the brief input. Client — `sessionReducer` for every frame
(replay merge by seq, duplicate `session_message` ignored, delta append, turn done/stopped/error clears
`live`, `removed`, `archived`); `useSession` sends `session_sync` on connect and reconnect with the last seq;
ChatTimeline renders each row kind, the speaker header only on a change, decision choices post `continue`,
tap options post a turn, Stop calls `stopTurn` with the live turn id; CardBubble renders every card type
ChatWindow did (the existing card tests move onto it); the empty state's options. Existing panel suites
unchanged.


**Phase 7 as done (2026-10-17):** J1–J6 approved by Roy. Backend 7a `f954ccb` (replyExtras; hydrateCards + the review
payload patch; the runner's route follow-up — opening → the landing desk's turn, edit → findForEdit + openForEdit, busy →
reopen/keep decision; briefTurn; `<show>ticket`; the edit route under the lock; the Axl prompt's one-chat section) and
7d `438b346` (the Axl HTTP routes deleted — the session turn replaces both; resolveMessage echoes message_resolved to the
user's own sockets). Frontend 7b `0d2518f` (chatWsService.send, session client, sessionReducer, useSession), 7c+7d
`046ac59` (ChatTimeline + rows + CardBubble extracted from ChatWindow; MainPage mounts it; AxlHub, deskWork,
TICKET_DESK, SUMMON_MS, axl.service.remote deleted; AxlHub.scss → AgentSummon.scss) and `b094028` (drive polish).
7e: `scripts/drive-unified-chat.mjs` on Vite :5173 — 13/13 (opening question, tap → Axl → Atlas answering below under
its own name, Stop, reload, a card + dismiss, New session, History read-only, phone width). Suites: backend 4111/0,
frontend 1259 vitest + 443 node. Deviations from the plan, each smaller:
- a tags-only reply still has no row, so its taps stay live-only (an empty row would reach the agent's context);
- the ticket offer opens the pad and charts the symbol — TradeTicket takes no starting symbol;
- `AxlBotGlyph` stays (BotAvatarGlyph draws Axl with it); only the `AgentSummon` overlay goes in phase 8;
- the active-session header carries no `agentState` (HEADER_PROJECTION) — the phase-8 surfaces need a read for it;
- a drive must not edit backend files while it runs: nodemon restarts and kills the turn in flight.

Phase 7 bug hunt (2026-10-17, all six applied — BE `2497759`, FE `a2911c3`): the user can speak while a turn runs (it
queues; a chain pauses for it) · Axl knows its surface (the social chat drops hand-offs, so it never promises one) · "Ask
Axl instead" while a desk holds the floor · taps only while their reply is the last word · a refused edit says why · a
replay's running turn wins. Drive re-run 13/13.

Phase 7 CR (2026-10-17, two reviewers, 20 findings, all applied — BE `d6968d4`, FE `2ae2341`, bundle `975f098`): an
opening runs ONE turn (origin `opening` — no desk-to-desk ping-pong) · card reads ride the conversationId index ·
`openForEdit` refuses another scope's item (`wrong_scope`) · a show-only reply gets a line · name matches skip closed
setups · a brief is always Axl's · the replay carries the chain, the agents' states and the running text · an accepted
turn never strands the input after a reconnect · the server's agent names the live turn · a failed first message shows
· a waiting message can be cancelled · history cards have no buttons · the drawer is a proper dialog · stale /api/axl
docs fixed. Suites: BE 4119/0, FE 1269 vitest + 452 node. Drive 13/13.

## 10. Phase 8 — Frontend: side pane + MainPage teardown

- **Surfaces extracted from the panels**, reading `agentState` from the session; every action goes through
  ONE call, `act(agent, text, ops)`, which posts a turn (today's `_press(ops, text)` generalised):
  - `MentorSurface` — SetupSummary, CoverageChips, CandidatePicker, StageConfirm, SpanTable, EntryTable,
    Generate / Generate-all, Arm, edit bar.
  - `ScannerSurface` — list summary, Prometheus radar read, research offer, Generate / Update, lens toggle.
    The "Send to X" pick bar goes (hops are automatic).
  - `PortfolioSurface` — thesis card, build summary, review Accept/Dismiss/Later, Generate/Update,
    `AdoptBookGrid`.
  - `AnalystSurface` — CoverageDraft, Initiate/Update. "Back to Atlas" goes.
  - `TradeTicket` — as is.
- **`SidePane`** — a DRAWER over the chat column (§1b): follows the floor, pin, tabs per opened surface;
  bottom sheet on narrow screens.
- **MainPage teardown:** delete `activeTab` switching, `activePipeline` / `pipelineStep` / `pipelineMode`,
  reset keys, `returningToAxl` and friends, `resumeRefs`, `deskBusy` / `liveWork`, `handleBackToAxl`,
  `finishPipeline`, `handleAxlPick`, `handleRoute`, `_applyHop`, `emitArtifact`, `enterPipelineAt`,
  `scannerHandoffTo`, `handleSendPick`, `handleCancelHandoff`, `handleResearchCandidate`,
  `handleResearchList`, `handleSleeveResearched`, `handleBuildFromCandidate`, `seedMentorChat` and the seed
  builders, `PipelineCrumb` / `TAB_TO_STEP`, the agent bar, the seven mounted panels, the "Heading back"
  overlay. Keep `openForEdit`'s resolver and the entity-save half of `handleGenerateList` /
  `handleUpdateList`. The edit openers (`handleEditSetup`, `handleEditCoverage`, `handleEditScan`,
  `handleEditPortfolio`) collapse into one "edit entity" call.
- `TradeIdeasList`'s `chatTab` filter signal reads the floor instead.
- Moved here from phase 7 (J1): delete `RouteOffer`, `useRouteOffer`, `useDeskHandoff`, `doors`, `contracts` + the four
  pipeline `*.contract.js` (keep `Floor/queuedAction.contract.js`), `pipelineNav`, `deskReset`, `ThreadHistory`,
  `AgentSummon` / `AxlBotGlyph`, `RETURN_MS`, `DESKS[].steps`.
- The desk panels (`MentorPanel`, `ScannerPanel`, `PortfolioPanel`, `AnalystPanel`) are deleted once their
  surfaces are out. `StrategyPanel` / `AetherPanel` stay, opened from admin-only buttons in `FloorLists.jsx`
  (§1 q4, temporary).

Tests: rewrite `AxlHub.test.jsx`; split the panel tests into surface tests (kept) and timeline tests;
delete `deskWork`, `pipelineNav`, `useDeskHandoff`, `deskReset`, `doors`, `deskSteps`,
`handoffDestination`, `RouteOffer`, `ThreadHistory` tests; port `hop` / `artifact` / `scanOrigin` tests to
the backend. Browser-drive every flow: Axl question → Mentor build → Generate; Atlas → sourcing →
Prometheus → back; edit a setup; a background card arriving; new session + history.

### 10.1 Phase 8 — detailed plan (2026-10-17, for Roy's approval)

Read before writing it: the four desk panels' working UI (every block, what it reads, what its buttons do), every
desk definition's `nextState` / `done` / `stateFromEntity`, every Generate/commit endpoint, the session header and
agentState transport, Mentor's ops, the chain's reads, MainPage's tab/pipeline machinery (2820 lines), every edit
doorway and bus listener, and the existing overlay patterns. Facts that shaped it:
- **The surfaces' data is almost all in agentState already.** Mentor keeps draft, coverage, drafts, gate, readiness,
  candidates; Argus keeps pendingScan + its mode; Atlas keeps mandate, thesis, pendingPlan, reviewUpdate; Prometheus keeps
  the draft. Lost on reload today: Atlas's `screen_requests` / `coverage_request` notices, Pythia's `assessments`, the
  phases. It reaches the client only on the socket (`session_state` per change, `session_replay` whole) — no HTTP read.
- **Every commit takes the draft from the CLIENT body** (setups generate / generate-all / arm, trade-ideas batch,
  rebalance, complete-review, scans create / update, coverage initiate / update, strategy publish). The seal runs from a
  `sessionId` in the body, in the background.
- **Some edits live only in the panel today**: Mentor's SetupSummary edits (sent as the next turn's `chatState.draft`),
  Argus's Prometheus read rewriting the candidates, the trading/investing lens, the angle chips. In a server-held state
  they need a way in.
- **Payloads are sent twice**: a Mentor turn ships the draft in `session_state` AND in the `session_turn: done`
  payload (and `build` a third time). No cap anywhere.
- **The session path has gaps for Atlas**: nothing sets `reviewMode` or `adoptDraftId`; the edit route ignores the
  card's `reviewMode`; Axl's `adopt` is consumed nowhere. Adopt mode (AdoptBookGrid) is unreachable since phase 7.
- **About 1,000 of MainPage's 2,820 lines are tab/pipeline machinery**; the save halves of the edit openers and of
  generate/update list/plan survive. Twenty-one `setActiveTab` sites; twelve bus listeners, five of them open a desk.
- **DetailPanel already does the hard parts of a drawer**: portal (docked in the chat column / full page on a phone),
  Esc, focus in and back, phone back-button. One active id app-wide.
- Production still imports `RouteOffer`, `AgentSummon` (`BotAvatarGlyph` lives there), `agentMeta.DESKS`,
  `pipeline/artifact` — they go with the panels, in order.

**Six decisions this plan asks for (my recommendation first):**

- **K1 — Build it desk by desk, each surface replacing its panel, in steps that each leave the app working.** 8a backend
  (state, commits, edits) → 8b the drawer + Mentor's surface (Mentor's panel deleted) → 8c Atlas (+ adopt) → 8d Argus and
  Prometheus → 8e the doorways, MainPage's teardown, Pythia/Aether/the ticket in the drawer, the shared-module deletions →
  8f drive. *Alternative:* all at once — ~6k lines with nothing to drive until the end.
- **K2 — Commits read the draft from the SESSION, through ONE route with desk-owned actions.**
  `POST /api/sessions/:id/act { agent, action, args }` → the desk definition's `actions[action](state, args, ctx)`, which
  calls the EXISTING service (generateSetup, createBatch, createScan, initiateCoverage, applyRebalance, completeReview,
  publishIndustry) with the draft from agentState, then seals in-line under the session lock and answers the result. The
  pipe is shared, the judgement stays with each desk (CLAUDE.md). The REST endpoints stay for their non-session callers;
  their `sessionId` seal hook (sealAfterGenerate) goes once nothing sends it (D1). *Alternative:* the client posts the
  agentState draft it received to today's endpoints — two copies of the draft, and the client decides what is committed.
- **K3 — Direct edits are a validated state patch, not a model turn.** `PATCH /api/sessions/:id/state { agent, edit }` →
  the desk's `applyEdit(state, edit)` (Mentor: a draft edit, re-validated by the existing validateSetup → gate/readiness;
  Argus: the lens, the Prometheus read, the angle set; Atlas: none yet) → `setAgentState` → `session_state`. Presses that
  ARE turns (a candidate pick, a stage confirm, spans, entries, delegate) keep Mentor's `ops` on a turn — one
  `act(agent, text, ops)` on the client. *Alternative:* every edit rides the next turn — the user's edit is invisible until
  they speak, and lost if they don't.
- **K4 — The surface reads agentState ONLY; the `done` frame carries what the state does not.** Each desk's `nextState`
  keeps what its surface shows (Atlas's notices, Pythia's assessments; Mentor's `build` already rides the draft); the
  `session_turn: done` payload drops the fields agentState carries (sent once, not twice); the active-session read gains
  agentState (`GET /api/sessions/active` — the first paint before the socket replays). Atlas's `reviewMode` / `adopt` are
  set by the edit route (`reviewMode` honoured) and by Axl's adopt route (`onRouted`). *Alternative:* surfaces read
  `done` payloads — gone on reload, the whole problem phase 7 fixed for replies.
- **K5 — The drawer reuses DetailPanel's shell; it docks over the chat column from the right, the chat still showing.**
  A `SidePane` (cmps/SidePane) built on DetailPanel's portal / Esc / focus / phone-back mechanics, extracted into one
  shared `DrawerShell` both use (share the pipe): on desktop ~min(560px, 70%) of the chat column from the right edge, so
  the conversation stays readable; on a phone a bottom sheet (decision 13) — EntityDetailHost's history handling, sheet
  styling. It follows the floor (Mentor speaks → Mentor's surface), can be pinned, and keeps one tab per opened surface.
  *Alternative:* a new drawer from scratch — a second copy of focus/Esc/history.
- **K6 — Pythia, Aether and the order ticket open IN the drawer.** Pythia's and Aether's panels are mounted as drawer tabs,
  opened from admin-only FloorLists buttons (§1 q4, temporary); the ticket is a drawer tab opened by `<show>ticket` and
  the Lists. MainPage's chat column then holds only the timeline. *Alternative:* keep a tab system for those three — the
  machinery this phase exists to delete.

**Steps**

- **8a — backend (one commit) — DONE 2026-10-17, see §10.2 for what was built (it differs from this bullet):** K2 `act` route + `actions` on mentor (generate, generateAll, arm, update, later), portfolio
  (generatePlan, updatePlan, acceptReview, dismissReview, completeReview), scanner (generateList, updateList), analyst
  (initiate, update), strategy (publish) — each through its existing service, seal in-line, `busy`/refusal reasons through
  `sendReason`; K3 `state` route + `applyEdit` (mentor, scanner); K4 nextState additions, the slimmer done frame,
  agentState on the active read, `reviewMode` on the edit route, Axl's adopt → Atlas `onRouted`; the scanner turn input
  gains `radarBoard` (the Floor's radar scan). Tests for every action and edit, the seal, the scope rules.
- **8b — the drawer + Mentor — DONE 2026-10-17, see §10.3:** `DrawerShell` extracted from DetailPanel (DetailPanel rebuilt on it, its tests kept);
  `SidePane` (desktop dock / phone sheet, pin, tabs, follows the floor); `useSession` gains `act(agent, text, ops)`,
  `edit(agent, edit)`, `commit(agent, action, args)`; `MentorSurface` from the panel's blocks — SetupSummary, CoverageChips,
  CandidatePicker, StageConfirm, SpanTable, EntryTable (moved as they are, reading agentState), the Generate / Generate-all /
  Arm / Leave waiting / Update / Later bar. Delete `MentorPanel.jsx`; its block tests move to the surface.
- **8c — Atlas — DONE 2026-10-17, see §10.4:** `PortfolioSurface` — thesis card, build summary, limits notes, sleeve/coverage notices, the review
  Accept / Dismiss / Later and Generate / Update bar, `AdoptBookGrid` (adopt reachable again). Delete `PortfolioPanel.jsx`
  (`PortfolioPanel.scss` stays — the shared `portfolio-panel__*` bubble classes; renamed in phase 10).
- **8d — Argus + Prometheus — DONE 2026-10-17, see §10.5:** `ScannerSurface` — list summary, PrometheusStep (the read through K3), lens toggle, angle
  chips, Generate / Update (the research offer and the pick bar are the chain's decision cards now); `AnalystSurface` —
  CoverageDraft, Initiate / Update. Delete both panels.
- **8e — doorways + teardown — DONE 2026-10-17, see §10.6:** one `editEntity(kind, id, opts)` (→ `POST /:id/edit`, a 409 busy asks then repeats with
  `force`, the drawer opens on that agent) replaces handleEditSetup / Coverage / Scan / Portfolio and openForEdit's
  dispatch; every pencil and the five desk-opening bus listeners call it; seedMentorChat (earnings / IPO / Aether "trade
  with Mentor"), handleScanRadar and the research-queue Start become session turns; Pythia / Aether / ticket into the
  drawer (K6). Delete from MainPage: the tab and pipeline state, `handleBackToAxl` / `finishPipeline` / `handleAxlPick` /
  `handleRoute` / `_applyHop` / `emitArtifact` / `enterPipelineAt` / `handleSendPick` / `handleCancelHandoff` /
  `handleResearchCandidate` / `handleResearchList` / `handleSleeveResearched` / `handleBuildFromCandidate` / the seed
  builders' desk half, `PipelineCrumb` / `TAB_TO_STEP`, the agent bar, the mounted panels, the "Heading back" overlay;
  `TradeIdeasList`'s `chatTab` reads the floor. Delete the modules: `RouteOffer`, `useRouteOffer`, `useDeskHandoff`,
  `doors`, `contracts` + the four pipeline `*.contract.js` (keep `Floor/queuedAction.contract.js`), `hop`, `artifact`
  (FE), `pipelineNav`, `deskReset`, `ThreadHistory`, the `AgentSummon` overlay + `RETURN_MS` (`BotAvatarGlyph` /
  `AxlBotGlyph` / `AgentIntro` / `AgentTurnTag` move to their own file), `agentMeta.DESKS` and its `.steps`;
  `useChatStream` / `agentStream` / the HTTP desk `/stream` routes and `threadsService` stay only for Pythia and Aether
  (D1 — they go in phase 9 when those move or in a later phase). Their tests go with them; scanOrigin's surviving half moves.
- **8f — drive:** `scripts/drive-unified-chat.mjs` grows: a Mentor build to Generate and Arm from the drawer; Atlas →
  sourcing → Prometheus → back to Atlas, Generate plan; a pencil edit on a setup (busy → set aside); a portfolio review card
  → Accept; the drawer as a bottom sheet at phone width; Pythia from the admin button.

**Not in phase 8:** migration of old threads / chat_state (phase 9); moving Pythia and Aether onto the session (their
panels only change where they are mounted); the input row's clear icon (Roy, 2026-10-17: leave it).

**Tests:** backend — every desk action (draft from state, the existing service called with it, the seal in-line, the
refusals), every `applyEdit` (accepted / refused / re-validated), the slimmer done frame, agentState on the active read,
`reviewMode` and adopt landing; frontend — DrawerShell (DetailPanel's suite passes on it), SidePane (follows the floor,
pin, tabs, sheet at phone width), each surface's blocks (the panel suites' block assertions move over), `act` / `edit` /
`commit`, `editEntity` incl. busy → force; the drive above.

### 10.2 Phase 8a — as built (2026-10-17)

Commits: `32f3f61` (8a) · `d0de776` (bug hunt) · `6e4eb00` (CR). Suite 4187/0 (excluding talosRecorder). Not pushed;
the routes are not live-driven yet — the 8b drawer is the first thing that presses them (drive in 8f).

**The contract the 8b client codes against:**
- `POST /api/sessions/:id/act { agent, action, args, rev }` → `{ ...result, rev }`; `PATCH /api/sessions/:id/state
  { agent, edit, rev }` → `{ ok, rev }`. `rev` is REQUIRED: the agent's revision the user was looking at
  (`agentRev[agent]`, bumped by every `setAgentState`, pushed on `session_state` as `rev` and on `session_replay` as
  `agentRev`). A stale one answers `409 stale_state` with `extra.rev` — the client redraws, then asks again.
- Verbs, the same on every desk: `generate` (a new entity — `not_new` while editing one) · `update` (the one being
  edited) · `later` (stop editing, nothing saved); plus Mentor `generateAll` / `arm` / `leave`, Atlas `accept` /
  `dismiss`, Pythia `publish { industry }` (no `later`).
- Results are `{ <kind>: doc, ...extras }`: Mentor `{ setup }` / `{ setups, failed }`; Atlas `{ portfolio: { portfolioId,
  ideas? }, failed | left | rebound | rebalance | held, nextReviewAt }`; Argus `{ scan, profile }`; Prometheus `{ coverage,
  revised }`; Pythia `{ view }`. Everything refused is a refusal (`409 nothing_saved`, `extra.failed`), never a success
  with nothing in it. `stateWritten: false` on a saved commit whose state write failed — refetch.
- Args: `accounts` is the account OBJECTS for every desk (`parseCommitArgs`), `mainAccountId` a string. The AVOID ask is
  one round trip: `409 avoid_needs_ok` with `extra.avoid` → ask → press again with `avoidOk: [symbols]` (or, on Accept,
  `dropAvoid: true`).
- Edits: Mentor `{ draft, accounts? }` (the session's build ledger is kept — the client's dropped); Argus `{ profile }`
  (refused in a hand-off) and `{ read: { tickers, rows } }` (the client runs `POST /aether/batch-read`, minutes long,
  then hands the rows over; `409 stale_read` when the list changed). The angle chips are NOT an edit — they compose a turn.
- Refusals: the session's table first (`no_such_action`, `nothing_to_commit`, `nothing_to_edit`, `nothing_saved`,
  `not_new`, `too_many`, `invalid_edit`, `not_editable`, `stale_state`, `action_failed` 500), then the desk's
  (`setupReason`, `PORTFOLIO_REASONS`, `SCANNER_REASONS`, `ANALYST_REASONS`, `STRATEGY_REASONS`). Prometheus's writes
  are admin-only in the action (`forbidden`); Pythia's by the speaker rule.

**Shared mechanism (the REST routes run the same code):** `api/setups/setupCommit.service.js` (commitSetup resolves an
update's cards, armSetup), `setupService.generateSetups` (the one MAX_NAMES cap), `api/portfolio/portfolioCommit.service.js`
(createBook, recordConstruction, replacePlan — moved off MainPage —, rebindAccounts, closeReview, acceptRebalance),
`api/analyst/coverageCommit.service.js`, `api/strategy/industryPublish.service.js`, `services/setupVerdict.js`; refusal
tables in `setupReasons` / `coverageReasons` / `portfolioReasons` / `viewReasons`; `services/desks/markers.js`
(keepMarkers — the turn fold, a direct edit, Atlas's onRouted); `services/desks/scannerMode.js`.

**State rules moved from the panels to the server:** a review turn without a proposal withdraws it (2026-10-03) and a
same-turn thesis rides on it; only Prometheus's latest `<coverage>` stands (`standing`) and a revision about another
symbol is refused (`wrong_symbol`); a Prometheus read rewrites `editList` too while a saved scan is refined; only a
review's Accept closes the review (`applyRebalance({ closeReview })`, Roy 2026-10-17) — an edit's Accept leaves a due
review due; edit-mode Atlas proposals wait on Accept instead of applying on arrival (Roy 2026-10-17); a radar board on a
session turn reaches Argus (it was dropped).

Phase 8a bug hunt (2026-10-17, six, all applied — `d0de776`): the build ledger stays the server's on a hand edit · own
action names only (`constructor` answered 200) · no review closed outside a review · a failed state write after a save
answers success with `stateWritten: false`, never 500 · Atlas takes the same account objects · `action_failed` is 500.

Phase 8a CR (2026-10-17, two reviewers, 6 correctness + 6 reuse findings and D1/D2, all applied — `6e4eb00`): Atlas kept
its plan across a route but dropped `editing` / `chainId` · a model-written `avoid_ok` on an add-to skipped the AVOID ask
· a read left `editList` stale · the scanner import cycle · an AVOID-retry Accept closed the review twice · read rows
typed and capped · setups and the book document moved into their commit services · Mentor's `invalid_*` rule no longer
swallows the session's reasons · one batch cap · D1 one vocabulary and result envelope · D2 revisions.

Left as is, on purpose: a retry after `stateWritten: false` can save twice (it needs two DB failures in a row — clearing
the state would fail the same way); views Pythia published from a batch the user walks away from stay unsealed (their
conversation stays in the session). The REST routes' `sessionId` seal hook (sealAfterGenerate) still stands — it goes
once nothing sends it (D1 of §10.1).

### 10.3 Phase 8b — as built (2026-10-17)

Commits: FE `771ae2e` · BE `42b5492` · bundle `bccf74f` (8b, bug hunt folded in) · FE `299ab13` + BE `353c2cd` (CR).
Driven: `scripts/drive-mentor-surface.mjs` 13/13 on Vite :5173 — Mentor's state is SEEDED (no model call): the pane on
the floor, a hand edit, a stale press refused, Generate, Arm, a pencil reopening the setup in the session, the phone
sheet. Not pushed.

**Built (frontend):**
- `cmps/DrawerShell` — the drawer mechanics, once: Esc closes the TOP open shell only (a stack), focus in on open and
  back on close (`autoFocus` false for a surface that opens beside the user's work), the handheld back gesture (a history
  entry, `{ field, key }`), portal or in place. `DetailPanel` is rebuilt on it.
- `cmps/SidePane` + `sidePane.store.js` — one tab per opened desk; follows the floor on its CHANGE (a closed pane stays
  closed until the floor moves); pin. Docked beside the timeline in `.chat-with-pane` (`min(560px, 58%)`, `min-width: 0`
  — the worksheet header pushed it to 650px without it); a bottom sheet portalled to `<body>` on a handheld, z 250 —
  under the dialogs (300–320). A surface is keyed on the session id.
- `context/SessionContext` — ONE `useSession('main')` on MainPage, shared by the timeline, the pane and the doorways.
  `useSession` gains `commit(agent, action, args)`, `edit(agent, change, { rev })`, `reopen(kind, id, opts)`; every
  answer is an outcome `{ ok, reason, message, extra }`; revisions fold from the load, the replay, `session_state` and
  each answer, never backwards (`mergeRevs`). A `stale_state` refusal also asks for a replay, so the surface redraws
  before the next press (bug hunt #1). A press made before the session loaded waits for it, up to 10 s; a failed load
  answers at once (bug hunt #2, CR).
- `cmps/MentorSurface` — the worksheet, coverage, candidates, gates and the Generate / Generate all / Arm / Leave /
  Update / Later bar, from `agentState.mentor`. Gates and picks are TURNS (ops), worksheet fields are debounced HAND EDITS
  (600 ms, one in flight), the bar is COMMITS. Its rules (readiness, the press builders, `mentorHolding`) are in
  `mentorSurface.utils.js`. `MentorPanel.jsx` and its suite are deleted; the blocks in `cmps/MentorPanel/` stay.
- A commit announces its kind's change event (`session.service.remote` → `SETUPS_CHANGED` for Mentor), so the Floor
  reloads at once. 8c and 8d add their kinds to the same map.
- MainPage: `talkTo` / `openDesk` / `editEntity` (reopen → busy asks → force; `onOpened` runs only once it reopened);
  the pencil and the redraw card reopen IN the session; calendar / Aether / Argus picks are turns; a shared setup is a
  `fresh` edit (`mentorHolding` asks first) and a turn. A temporary bridge turns any old Mentor seed, inbox or tab
  switch into the same — deleted with that machinery in 8e.

**Built (backend, `42b5492`):** Mentor's `{ draft, fresh: true }` edit — a NEW plan on a cleared table, markers dropped
(`act.editState` honours `dropMarkers`).

Phase 8b bug hunt (2026-10-17, two applied): a stale press redraws before the next one (the replay); an early press
waits for the session instead of being dropped.

Phase 8b CR (2026-10-17, two reviewers, applied — FE `299ab13`, BE `353c2cd`): a press inside the edit's settle window
committed the plan WITHOUT the edit (a press now settles the edit first; Update lights off the server's draft) · a
debounced edit sent the revision current at send time and could overwrite a turn the user never saw (it names the one
it was made against) · a pending edit was dropped on close · a cancelled pencil still switched workspace and accounts
· a shared plan wiped a generated-not-armed setup unasked, and failed mid-turn (asks on any work; one retry) · doorways
opened Mentor under the docked detail panel (`openDesk` closes it) · the Floor stale after a commit (the change event)
· the phone sheet over the dialogs (650 → 250) · the docked pane took focus from the chat input · one Esc closed the
history drawer AND the pane (claimed in capture) · Mentor's edit stored the client's raw draft (now the normalised plan
plus the session's ledger / spans / entries / summary) · smaller: the editor's in-flight flag on a throw, accounts read
at send time, the refusal text once.

**Carried, on purpose:**
- **To 8e.** Resuming an old Mentor thread (the unfinished list, the threads drawer) opens an empty surface —
  `resumeRefs.mentor` had only the panel to set it. Arm / Leave no longer end the pipeline (`finishPipeline`). The old
  panel's RouteOffer, "continue a stopped reply", Clear and `deskLoadingSetters.mentor` have no session counterpart
  yet. The agent bar's Mentor AccountSelector branch is dead behind the bridge. `handleBackToAxl` still clears
  `mentorChatRestore`, which nothing reads.
- **To 8f.** MainPage's doorways have no unit suite (the old panel suite covered the hand-off firing once, a calendar
  seed once, a reopen with / without an ask) — the drive covers them end to end.
- **With 8c / 8e.** A `fresh` plan (and a forced reopen, already) leaves Mentor's seal boundary where it was, so the
  put-aside setup's conversation seals onto the next generated one. Move the boundary, or seal the dropped segment onto
  `editing.entityId`, for both at once.

### 10.4 Phase 8c — as built (2026-10-17)

Commits: FE `4ae4649` · BE `cf56524` · bundle `cc1a1ae` (8c) · the CR commits (FE + BE + bundle, after `cc1a1ae`).
Driven: `scripts/drive-portfolio-surface.mjs` 14/14 on Vite :5173 — Atlas's state SEEDED (no model call): the plan on
the floor, Generate saving a real book, a review listed and dismissed (asked first), adopt mode staging and pricing a
paste, Cancel, an adopt over an unsaved plan asking first, the phone sheet; it removes everything it made (the book,
its sealed context, the drafts, the session) and fails on a page error. Not pushed.

**Built (frontend):**
- `cmps/PortfolioSurface` — the book's thesis (editing), the build summary (the plan on the table, else the book as it
  stands), the house's limits, the sleeve / coverage notices, the proposal LISTED before Accept (`describeChange`,
  moved from MainPage's never-raised rebalance dialog), and the bars: construction Generate; an edit's Update (a plan
  on the table must be sized; with none, Update pushes moved accounts) and Accept for its proposal, both when both
  apply, and Later; a review's Review (a turn) until a pass ran (`reviewed`), then Accept / Dismiss (asked first) /
  Later. The AVOID ask is the `again` round trip (yes → `avoidOk`; no on a proposal → `dropAvoid`; no on a book →
  nothing saved). Rules in `portfolioSurface.utils.js`.
- Adopt mode on the surface: the grid (`cmps/AdoptBook`, styled at last), the draft read after every Atlas turn
  (answers out of order dropped), never a dead end (a failed stage or read says so, with Try again and Cancel), and
  the "put it aside?" question over unsaved work.
- `customHooks/useSurfacePress` (CR) — the press mechanics both surfaces share: the marked accounts, one press at a
  time, the note (a refusal's is sticky until the next press; other errors clear when the revision moves), the stale
  text, `before` (Mentor settles its hand edit) and `again` (Atlas's AVOID ask). What a press MEANS stays per surface.
- MainPage: a book reopens IN THE SESSION (`editEntity` with `reviewMode`; accounts / workspace / the waiting reset only
  once it reopened); a save re-reads the lists and the queue; an adoption opens the new book; the "building" row is a
  plan on Atlas's table, in its own workspace. Deleted: `PortfolioPanel`, `avoidOk`, the save / update / apply /
  accept handlers (the server's actions since 8a), the rebalance dialog, `adoptDraft`.
- Both surfaces grow in the pane and the pane scrolls (the shared `portfolio-panel` shell clipped them).

**Built (backend):** Atlas's hand edit `{ adopt: 'start' | 'end' }` (the user rides to `applyEdit`); `reviewed`;
the book's standing thesis on reopen (`entityLookup` → `stateFromEntity`). CR: `plan_not_ready` (Generate and Update
refuse an unsized plan — an Update never passes it over for a rebind); Axl's adopt lands on a CLEAN table (no book
being edited, no markers) and over unsaved work waits for the yes (`adopt_over_work` until `fresh: true`, Roy
2026-10-17 decision (a)); any other route ends adopt mode; `start` replaces a committed or vanished draft; the latest
turn decides a proposal outside a review too; a review whose every change was declined closes as held.

Phase 8c bug hunt (2026-10-17, Roy): Update needs a marked account — kept, as Mentor's; the rest carried to 8e (below).

Phase 8c CR (2026-10-17, two reviewers, all applied with decision (a)): the unsized-plan Update / Generate · adopt mode
outliving the user's exit · a withdrawn edit proposal blocking Update · the surfaces clipped · "Opening the adoption…"
a dead end, and a committed draft reused · the building row sticking across visits and workspaces · the stage guard
stuck after a failure, a racing stage's false error, MainPage's dead adopt branch · a refusal's note cleared by the next
frame · an all-AVOID review looping · `useSurfacePress` · "on 0 holdings", the live count, `bookPending` on the shared
status list, a stale comment, `setPortfolioChatRestore`, the drive's cleanup.

**Carried to 8e** (Roy 2026-10-17, with 8b's list in §10.3): a Discard for an unsaved plan on the surfaces (the old
input's Clear); Atlas's thread resume (the threads drawer, RESUME_BUILD for a book not yet saved) — `resumeRefs` had only
the panel to set them; a save no longer ends the pipeline (`finishPipeline`), as Mentor; dead code —
`tradeIdeasService.createBatch` has no caller.

### 10.5 Phase 8d — as built (2026-10-17)

Commits: FE `1a93a4e` · BE drive `5bcc44a` · bundle `c9b2bf9` (8d) · BE `a0047b7` + FE `b36ca90` (bug hunt) · the CR
commits after them. Driven: `scripts/drive-scanner-analyst-surface.mjs` 12/12 (seeded state, no model call, no
Prometheus read — it asserts none is asked for): Argus's list on the floor, the lens as a hand edit, Generate saving the
scan, the scan reopened and Updated, a radar cut's verdict drawn, Prometheus's draft whole with its save offered. The
Mentor (13/13) and Atlas (14/14) drives re-run. Every drive now fails its process on a failed check. Not pushed.

Running several drives back to back trips the dev server's in-memory rate limits (auth, then the API — 429s that read as
a page that never loads, or an Update that "saved the old list"): restart the dev backend between runs (touch a file).

**Built (frontend):**
- `cmps/ScannerSurface` — the list in progress (each name a button to its chart, the read's caveat beside it), the lens
  (a hand edit), the angle chips (one turn, reset once sent), the Prometheus read of a radar cut — run by itself on its
  own route, handed back as a hand edit of THAT list (a stale hand-back retried on the revision the refusal named; a
  list that came and went read again; an answer for a closed surface or another session discarded) with Save without
  the read (it discards the answer only once the save went through) and Try again — and Generate / Update / Later. The
  single-pick hand-off and the research offer are the chain's.
- `cmps/AnalystSurface` — the standing draft (`CoverageDraft`, uncapped in the pane) and Initiate / Update (admins) /
  Later; a refusal says its detail; a turn that ended without a draft to save says so; a draft about another company
  mid-revision is said, and saved as its own coverage.
- `useSurfacePress` gains `edit` (a hand edit that says a refusal); `SidePane/SurfaceNote` and the `.desk-surface` shell
  (SidePane.scss) are the four surfaces' one note line, lead and frame.
- MainPage: a saved scan and a thesis reopen IN THE SESSION (`editEntity`; the coverage pencil on its revise turn); new
  work onto Argus's table — the radar cut (its board on the turn), a brief from a route or a card — goes through ONE
  step, `onArgusTable`: Argus holding a list, a saved list being edited or a name for another desk → the user is asked;
  then a fresh table, then the turn. A research candidate is a turn to Prometheus with its seed. Coverage joins the
  commit change events (COVERAGE_CHANGED). Deleted with the panels' last callers: the save / update / research /
  sleeve-hand-back handlers, the conveyor (`emitArtifact`, `_applyHop`, `enterPipelineAt`), the single-pick hand-off,
  `finishPipeline`, the remount keys, the inbox bridges, the auto/manual toggle, and the modules nothing ran any more —
  `deskReset`, `scanOrigin`, `hop` (with their tests, `deskSteps` and `handoffDestination`).

**Built (backend):** Argus's `{ fresh: true, profile? }` hand edit (a clean table, markers dropped, the lens kept or
set). CR: the chain's "Research the top N" SAVES the list first through Argus's own action and seals its conversation
onto it, then runs the research (Roy 2026-10-17, decision (a) — the old one press; a list that does not save is not
researched); Prometheus's draft about another company than the thesis being revised is new work — Initiate takes it,
Later keeps it (`elsewhere`, analyst.actions).

Phase 8d bug hunt (2026-10-17, Roy: 1 and 2 applied — `a0047b7`, `b36ca90`): a radar cut landing on Argus's work (now a
fresh table, asked first) · a re-emitted list not read again.

Phase 8d CR (2026-10-17, two reviewers, all applied with decision (a)): a brief from a route landing on a saved list
being edited (onArgusTable) · the stale hand-back retried on the same stale revision · the coverage book not reloaded ·
the other-company draft a dead end · a refused "save without the read" stranding the read · the original list re-emitted
after a narrowing read · a read handed to a closed surface · Later counted as a save · ticker → chart · a refused lens
silent, the angles never reset, "working" over a stopped desk, "coverage on null" · SurfaceNote and the shared shell ·
the dead code above · the drive's exit code, its no-read assertion and its cleanup.

**Carried to 8e** (Roy 2026-10-17): an old hand-off queue researches only its first name (only the leftover bridge can
still send one); stepping back along the pipeline crumb to a surfaced desk bounces to Axl (the crumb goes in 8e).

### 10.6 Phase 8e — as built (2026-10-17)

Commits: FE `d96ee22` · BE `3de482d` · bundle `7d52ce0` (8e) · FE `ca0d1af` (bug hunt) · the CR commits after them.
Driven: `scripts/drive-pane-tabs.mjs` 8/8 — the chat column is the timeline and the pane only; Pythia and Aether open
from the chat's header as kept pane tabs and keep a half-typed message across a pane close and a tab switch; Discard
asks, clears Mentor's table and moves the seal point and summary past its turns. Mentor 13/13, Atlas 14/14,
Argus/Prometheus 12/12 re-run. Not pushed.

**Built (frontend):**
- The chat column is ALWAYS the timeline and the side pane. Deleted from MainPage: the desk tabs (`activeTab`), the
  agent bar, `PipelineCrumb` / `TAB_TO_STEP`, the step back, the walk-home overlay and `handleBackToAxl`, Axl
  reception's desk pick (`handleAxlPick`), the thread-resume plumbing (`resumeRefs`, `_resumeThreadOn`), the desk busy
  state, the desk doors (`useDeskHandoff`, `doors`) and their bridges. Every remaining doorway opens the pane or is a
  session turn: the research queue's Start, the order ticket, a coverage card, a sleeve card (a pre-session thread is
  said, not resumed), a route Pythia's or Aether's panel offers (an edit, a session turn — Argus's through
  `onArgusTable` on the trading lens — or the other panel's seed). The Lists follow a DESK taking the floor (Mentor →
  setups, Atlas → portfolios), never Axl answering.
- KEPT pane tabs (K6): Pythia's and Aether's panels (their own chats still) and the order ticket stay MOUNTED while
  hidden — each renders once through a portal into a host node of its own, which the pane moves in when its tab shows
  (SidePane `KeptSlot`); closing the pane PARKS them (`sidePane.store.parked`); only a tab's own ✕ ends it. The pane
  resets when the user changes. An admin opens Pythia and Aether from a row under the chat's header (every layout has
  it; the plan's FloorLists buttons were not, on the classic layout). A seed is sent once, ever (`useSeedTurn`).
- Discard on every surface for UNSAVED work (`SidePane/DiscardButton`, asked first) — the old panels' Clear; a saved
  item being edited keeps Later. Mentor's drops a hand edit still settling first.
- Deleted modules: `useDeskHandoff`, `services/pipeline` (artifact, contracts, doors), the four desk contracts,
  `pipelineNav`, `ThreadHistory`, the summon overlay and `RETURN_MS`, `DESKS`' steps, `tradeIdeasService.createBatch`,
  the four desks' `sendStream` (D2), and the agent-bar / summon / panel-tab CSS. The agent glyphs moved to
  `AxlHub/AgentGlyphs.jsx`. Kept on purpose: `RouteOffer` / `useRouteOffer` (Pythia's and Aether's panels offer
  routes) and `agentMeta.DESKS` without steps (a route's key → its agent).

**Built (backend):** `sealing.putAside` — dropped work's turns are set aside: the seal point and the summary move past
them (they stay in the timeline), so they never seal onto what the desk builds next (carried from 8b); run after the
write it belongs to, on a reopen of a DIFFERENT item, a hand edit that replaces the work (`dropMarkers`), and a discard.
`discard` is the act pipe's own action — refused over an edit (`editing_use_later`) and over a table with no work, the
desk's settings kept (`cleanTable`: Argus's lens, Atlas's mandate), the chain the work belonged to ended
(`endedChain`, shared with the runner). D2: the four desks' `POST /stream` routes are gone (Mentor's router with them);
the agent limiter guards Pythia's and Aether's.

Phase 8e bug hunt (2026-10-17, Roy: fix 1, keep 2 — `ca0d1af`): a Pythia / Aether route to Argus skipped the clean-table
ask · a reopen of a different item sets aside all the desk's unsaved turns since its last seal (kept, by design).

Phase 8e CR (2026-10-17, two reviewers, all applied with D1 (a) and D2 (a)): Discard too blunt (an edit, a table with only
settings, the desk's settings wiped, a running chain bringing the work back) · a Pythia / Aether seed re-sent when its
tab reopened · the route to Argus on the wrong lens · Mentor's Discard against a settling edit · set-aside before its
write · the Lists filter reset on every Axl reply · the kept slot's empty frame, tabs surviving a user change · dead CSS,
stale comments, the glyphs' file · the drive's checks and the set-aside verified end to end · tests for the summary
reset, a desk's own discard, a refused discard, the kept slot in the phone sheet. D1 (a): Pythia's and Aether's drafts
are still SAVED, their dead resume / pipeline / busy props removed — resuming one returns when they move onto the
session. D2 (a): the four desk streams deleted now.

**Carried:** resuming a Pythia / Aether conversation (with their move onto the session — phase 9 or later); a parked
Pythia / Aether panel scrolls back to the top when shown again (its DOM is detached while hidden — accepted); MainPage's
doorways have no unit suite (8f drives them); `openForEdit`'s per-kind dispatch still calls the `handleEdit*` doorways
(each carries its own options — kept).

### 10.7 Phase 8f — the drive (2026-10-18)

Changed from the §10.1 bullet by the card revert (§8.1, same day): a review card is pressed in the SOCIAL CHAT, not the
timeline. Two new drives, both against Vite :5173 as `ui-smoke`, both clean up after themselves and exit 1 on a failure:
- `scripts/drive-doorways.mjs` — 21/21. Every desk card's button pressed in the social chat: a portfolio review →
  Atlas's surface, the book in review mode · a setup invalidation over Mentor's other work → asked; no keeps it, yes
  reopens the setup with the re-draw turn running (the pencil's busy path — the same `editEntity`) · a coverage verdict
  → Prometheus, the thesis reopened, the revise turn running · the brief card → Axl's brief turn, Stop ends it · the
  queue card → the queued desk (Floor) or the "it is on the Floor" note (classic) · no card in the timeline. The
  doorways' turns are stopped as soon as they show (cents).
- `scripts/drive-live-mentor.mjs` — 9/9, REAL model turns: a plan typed in the empty chat → Axl hands it to Mentor →
  Generate lights in the pane (3 turns) → Generate saves it from the session → Arm → Talos watching, Mentor's table clear.
Regression: drive-unified-chat 13/13, drive-mentor-surface 13/13, portfolio / scanner-analyst / pane-tabs re-run (the
results are in the commit that records them).

**Found by the drive and fixed (Roy: fix all — FE `1dc5fe4`):** (1) HIGH — MainPage built the workspace's lists inline;
it re-renders per streamed token, so TradeIdeasList re-read pending reviews per token (527 reads in one build) and the
API limiter refused the page — Generate answered "Too many requests". Lists memoised; the read keyed on the books.
(2) `showUserMsg('text')` rendered an EMPTY toast — three doorways said nothing; a string is an info toast now.
(3) SocialChat set the header's badge inside its own state updater (React's setState-in-render warning) — reported
after commit. (4) the live drive waits 5 min for a first turn (Axl + the desk's opening ran over 3).

**Not driven live, on purpose:** Atlas → sourcing → Prometheus → Atlas — multi-minute research per name; the chain is
driven server-side by `drive-session-chain.mjs` and the surfaces by the seeded drives. The Pythia admin button and the
phone sheet are in drive-pane-tabs / the surface drives. **Ops note:** the sign-in limiter is 20 per 15 min, in memory —
five drives in a row exhaust it; wait the window out (touching a file did not restart nodemon this time).

**Roy's changes during 8f (2026-10-18), all driven:**
- **A commit ENDS the session** (`act.endAfterCommit`). Generate / Update / Initiate / Accept / Dismiss / Publish archive the
  session (History keeps it) and open a fresh one with Axl; its first row is a `sealed` line `{ ref.ended: true }` —
  "✓ Mentor built NVDA setup — saved to your Setups. You're back with Axl." — drawn ABOVE Axl's greeting and taps (the
  session still reads as empty). A setup's line opens the setup's own window ("Open the setup to arm it") — Mentor's
  session ends at Generate, so arming lives there now. Not mid-chain: a save by a desk the chain went THROUGH keeps the
  session; the chain's own desk ends it. `startNew({ force })` archives even a message-less session. The desks' pane tabs
  close on a session change (kept tabs stay). Superseded on the way: keeping the conversation with a divider (asked,
  then withdrawn), and the "you just built" context note (moot with a fresh session).
- **The side pane**: about a third of the chat column (`clamp(280px, 34%, 400px)`, was `min(560px, 58%)`), and a
  Show / Hide toggle in the chat header (`PaneToggle`, `reopenPane` restores the tabs it was closed over). Mentor's
  folded worksheet header wraps its chips below the handle at that width (they crushed it).
- **The edit bar** (`.desk-surface__bar`): in every edit / review mode the presses are always on screen, pinned to the
  pane's bottom, dark until there is something valid to save and while the desk answers, with a line saying why.
- **Cards only in the social chat** confirmed live: the BAC card that reached a timeline at 20:32 came from the old
  server (it had never reloaded this morning's revert — `npm start` has no watcher; restart after a backend change).
- **Also found and fixed:** a house model (gpt-6-luna) intermittently answered "X (no final) X" — `cleanReply` drops the
  marker line and an adjacent repeated paragraph (`dropDebris`, every desk) · Stop on the market brief waited out a stale
  brief's rewrite — it now ends the turn at once · the backend's `npm run lint` was failing on the drives' unused
  `/* global document */` lines.
Drives after all of it: mentor-surface 14/14, portfolio-surface 14/14, scanner-analyst 13/13, pane-tabs 12/12, doorways
21/21, live-mentor 9/9 (real turns). The surface drives wait for the server's NEW session before checking a commit — a
session a commit opened starts with an ended line, which an "an ended line is on screen" wait passed on too early.
**Carried:** Mentor's "Arm it / Leave it waiting" step in the pane is unreachable now (the session ends at Generate) —
remove it, and its `arm` / `leave` actions, in a follow-up.

## 11. Phase 9 — Migration (`scripts/migrate-unified-chat.mjs`)

Idempotent, dry-run first, axl_dev before prod.
- Linked threads, `setups.chat_state`, `portfolio_chats.messages`, `scan.chat` → the entity's `agent_context`.
- Unlinked threads and `scanner_chats` rows → one archived session each.
- Then drop the old fields and collections (`threads`, `scanner_chats`) and the old indexes.
- **Unset `chat_state` on every `trade-ideas` document** (CR 2026-10-16, B1). The archived idea agent
  wrote whole transcripts there; phase 1 stopped writing and clearing it, so the existing ones sit
  in Mongo until this step — dead weight against the 512 MB cap. (`call` documents keep theirs: the
  `call` kind is kept data, see CLAUDE.md.)
- Measure the database size before and after (512 MB cap) — migration removes duplicates, so it should shrink.

## 12. Phase 10 — Docs, merge, deploy

- Rewrite: APP_SPEC §2 (Axl), CODE_MAP, README chat/flow diagrams, `botmarket-frontend/docs/hand-offs.md`,
  the desk docs; mark `pipeline-service.md` superseded; `npm run check:docs` clean.
- Merge both branches together; build and commit the frontend bundle into `public/`
  (the frontend ships only through it).
- Deploy order: new code first, then the migration (the new code reads `agent_context`; old fields are
  dropped by the migration's last step, after the deploy is confirmed).

## 13. Size and risk

- Biggest phases: 7 and 8 (frontend). Phase 5 is the riskiest backend change (headless turns on the server).
- Phases 1–2 are safe and independent of the session work, and planned to file/function level.
- **Phases 3–10 are outlines.** Each gets its own detailed plan (exact files, schemas, tests), approved by
  Roy, before it starts — phases 5–7 will change what 8 looks like, so detailing it now would be guessing.
- Between phases the app must still work end to end — each phase is mergeable on the branch, not on main.
  Nothing reaches main until phase 10.
