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

## 8. Phase 6 — Background cards into the timeline

- Themis moves onto `postCard` (one transport, no exceptions).
- Hook inside `postBotCard` after the message is written: append a `card` message to the user's active
  session and push it on the session channel. Supersede and resolve mirror `_supersedePending` /
  `message_resolved`. SocialChat keeps its copy.
- Card actions that open a desk today (`RESUME_BUILD`, `SETUP_INVALIDATION_EDIT`, `SETUP_SHARED_OPEN`,
  `MARKET_BRIEF_OPEN`, `OPEN_COVERAGE`, `SETUP_CONFIRM_OPEN`) become "floor → agent, load the entity's
  context" through one client call.

## 9. Phase 7 — Frontend: session client + timeline

- **`services/session/session.service.remote.js`** replaces `threads.service.remote.js`.
- **`useSession()`** — subscribes to the session channel, sends turns, handles stop/continue ONCE (the
  seven `_continue` copies go), exposes `timeline`, `floor`, `agentState`.
- **`ChatTimeline`** — built on the shared pieces (`AgentMessages`, `ChatBubble`, `AgentChatInput`,
  `SuggestionChips`, `AgentGlyph` + `AGENTS`): agent header per speaker run, hand-off divider with artifact
  card, decision card slot, sealed-context card, tap-to-answer on any agent's turn.
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
- **`SidePane`** — follows the floor, pin, tabs per opened surface; bottom sheet on narrow screens.
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
- The desk panels (`MentorPanel`, `ScannerPanel`, `PortfolioPanel`, `AnalystPanel`) are deleted once their
  surfaces are out. `StrategyPanel` / `AetherPanel` stay, opened from admin-only buttons in `FloorLists.jsx`
  (§1 q4, temporary).

Tests: rewrite `AxlHub.test.jsx`; split the panel tests into surface tests (kept) and timeline tests;
delete `deskWork`, `pipelineNav`, `useDeskHandoff`, `deskReset`, `doors`, `deskSteps`,
`handoffDestination`, `RouteOffer`, `ThreadHistory` tests; port `hop` / `artifact` / `scanOrigin` tests to
the backend. Browser-drive every flow: Axl question → Mentor build → Generate; Atlas → sourcing →
Prometheus → back; edit a setup; a background card arriving; new session + history.

## 11. Phase 9 — Migration (`scripts/migrate-unified-chat.mjs`)

Idempotent, dry-run first, axl_dev before prod.
- Linked threads, `setups.chat_state`, `portfolio_chats.messages`, `scan.chat` → the entity's `agent_context`.
- Unlinked threads and `scanner_chats` rows → one archived session each.
- Then drop the old fields and collections (`threads`, `scanner_chats`) and the old indexes.
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
- Phases 1–2 are safe and independent of the session work.
- Between phases the app must still work end to end — each phase is mergeable on the branch, not on main.
  Nothing reaches main until phase 10.
