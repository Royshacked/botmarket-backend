# Code Map

Where things live and how they're named. For the runtime architecture + app-flow
diagrams see [README.md](README.md); for behavioral contracts see [APP_SPEC.md](APP_SPEC.md).

## Layers

```
HTTP (api/*)  →  services/  →  providers/            request path
monitoring/   →  services/  →  providers/            background path (poll + reconcile)
```

- **api/** — the HTTP surface. One folder per feature, each with up to three files:
  `<feature>.routes.js` (Express router) · `<feature>.controller.js` (request handlers) ·
  `<feature>.service.js` (DB + business logic). Controllers stay thin; logic lives in services.
- **services/** — business logic, the LLM agents, and cross-cutting utilities. No Express here.
- **providers/** — thin clients for external systems (LLMs, market data, brokers, Mongo).
  This is the only layer that talks to the outside world.
- **monitoring/** — background workers started in `server.js` (poll loop, reconciler, paper engines).
  The arrow to services/ runs both ways for PURE modules: services import the evaluators' indicator
  math, tilt.assess's diff, the condition parser and monitorJournal's writer. What must not happen
  is a service reaching into the monitor tier for a FETCH or a CLIENT — those live in services/
  (lastPrice.service, anthropic.provider) since 2026-09-16.

## Directory map

```
server.js                 app wiring, route mounts, background-service boot
api/
  trade-ideas/            idea CRUD + order placement /api/trade-ideas/*
    tradeIdeas.service.js     save/get/update/delete, broker forking; getTicker-resolved
                              brokerSymbol + fork-time basisOffset per child; venue gate
                              (no broker + no paper → reject, reason:'no_venue').
                              enrichPositions = what THIS tier knows about a broker's positions:
                              the authored assetClass (null → the client's symbol heuristic) and
                              the owning callId. §1 flagged it homeless inside broker.controller;
                              §4 placed it here, beside the two maps it reads
    ideaExecution.service.js  placeOrdersForIdea / placeRestingEntryForIdea / triggerEntryNow ("Buy now")
    exitOrders.service.js     in-position exit (re)arming — through buildExitOrder, so the basis offset is
                              applied once, by the one helper, on this path as on placement
  mentor/                 Mentor chat SSE /api/mentor/stream — the trader's desk (agents/mentor)
  setups/                 the `setup` kind — Mentor's artifact, Talos's charge  /api/setups/*
    setups.service.js         Generate (the readiness gate + the server-stamped binding: mode /
                              broker / accounts / venue / event_risk) and owner-scoped CRUD over
                              kind:'setup' in `entities`, answering in the shared crud's shape. An
                              in-position edit touches CONTEXT only and clears monitor_state.dormant
                              (a condition may have been added to a live leg); a pre-position edit
                              clears last_assessment so the next read is a first_look. A live
                              position is delete-locked. Routes: generate · blueprint · validate ·
                              list/get · :id/journal (Talos's rows, newest first, paged by `before`)
                              · :id/action (talos.handoff) · :id/disarm (cancel a resting limit) ·
                              patch · delete
  portfolio/              Portfolio Agent + review    /api/portfolio/*
                          A book is NOT a document — it exists as the items carrying its
                          portfolioId — so its CRUD reads are shaped by hand rather than by
                          makeEntityController: GET / = the user's books (listPortfolios),
                          GET /:portfolioId/items = the book's holdings, its get-by-id.
                          Both added 2026-08-14 so the client READS a book by id like every
                          other kind instead of filtering it out of its own ideas list
  scanner/                Scanner Agent + saved scans /api/scanner/*
                          GET /scans/:id is crud.get over scanService.getScanById — written
                          long before, wired 2026-08-14 when the frontend needed to open a
                          scan by id rather than find it in a list
  analyst/                Analyst coverage (research/valuation)  /api/analyst/*
    coverage.service.js       `coverage` collection = living per-name thesis, HOUSE-OWNED (one doc per
                              symbol, no userId — since 5c12b8c): variant-perception + our PT vs Street (the
                              gap) + monitorable kill-criteria + append-only revisions[]. normalizeCoverage +
                              CRUD (initiate/update-w-revision/retire). Writes ride houseArtifact.repo, the
                              pipe it shares with tilt.service: revise = `$set` of ONLY the patched fields +
                              `$push` of the revision at position 0, in one update (`_updateSet` is the pure
                              half). Own collection — NOT the execution-tier entities (P1 of the Analyst)
  strategy/               Pythia — the house SECTOR VIEW  /api/strategy/*. THE WHOLE DESK IS ADMIN-ONLY
                          (router-wide requireAdmin, 2026-09-14). strategy.controller streams the desk +
                          the tilt publication log (current · list · publish · update · retire — no
                          delete: a desk that can erase its calls has no track record). Every handler
                          rides makeHandle. Publish diffs against the view in force (tilt.assess.
                          diffStances) → tiltNotify.notifyTiltChanged to every admin → runHouseScan
    tilt.service.js           `tilt` collection = ONE active house view per benchmark, superseded on
                              publish, never overwritten; house-owned like coverage (no userId). Each
                              ROW owns its clock (forecastClock.openWindow: reaffirm keeps set_at,
                              re-author restarts) and its FROZEN baseline (base_px / base_bench_px —
                              stampBaselines at publish). stanceCoherence refuses a row whose words and
                              number disagree; balanceOf records an unbalanced table rather than losing
                              it. Writes ride houseArtifact.repo (`_updateSet` = only the patched fields)
  aether/                 Aether — the EVENT-EXPOSURE desk  /api/aether/*. Node is READ-ONLY against the
                          engine's collections: the Python aether-engine (a separate repo) writes them, and
                          only when an admin starts a discovery run. What survived the channel-engine
                          removal (2026-09-09): aether_event_runs (one named event), aether_event_candidates
                          (one company it reaches, with the engine's filing verdict), aether_scorecard (ONE
                          document, graded at expiry by the engine's nightly). Stream + discovery are
                          admin-only; the list, the per-ticker drill-down and the scorecard are broadcast
    aether.service.js         groupCandidatesByRun (newest event first, best rank inside — sorted BEFORE
                              the limit, or the newest run fell off) + evidenceOf (a tally off the engine's
                              verdicts, never a second opinion) + shapeTickerResult + shapeScorecard, all
                              pure and tested without a database. TICKER_RE (aether.model) bounds a ticker
                              off a URL path — refused when too long, never trimmed into shape
    aether.controller.js      hand-rolled try/catch answering fixed slugs — the §9 error-shape decision;
                              startDiscovery answers off err.status (409 in flight · 503 no engine here)
  broker/                 broker connections/orders/positions  /api/broker/*
    adapters/
      broker.interface.js     BrokerAdapter base class — THE contract every broker fulfils
                              (incl. getCandles + capabilities().ohlcv, resolveSymbol "getTicker")
                              capabilities().selfExecuted = the ACCOUNT HOLDER executes (manual): post
                              the card and record the intent, never call a trading method. NOT the same
                              question as trading:false — IBKR is that too, but it is unwired rather
                              than hand-traded. Asked through venue.resolve.isSelfExecuted, never by name
      ctrader.adapter.js      + ctrader.execution.js (ProtoOA→BrokerExecution translator).
                              getCandles now serves trendbars (ohlcv:true); resolveSymbol via symbol list
      virtual.adapter.js      the shared READS of both virtual venues (account · trading accounts · positions
                              · findOpenPosition · resolveSymbol = identity), scoped by brokerType. Reads never create.
      paper.adapter.js        extends VirtualAdapter — the TRADING half (fills via paperExecution; ohlcv:false → app feed)
      manual.adapter.js       extends VirtualAdapter — every trading op THROWS (selfExecuted); no execution feed
      ibkr.adapter.js         data-only, in progress — see APP_SPEC / do not extend casually
      normalize.js
    broker.factory.js         getBrokerAdapter(type); SUPPORTED_BROKERS registry
    broker.service.js         broker-agnostic entry point used everywhere (getCandles/resolveSymbol)
    brokerPrice.service.js    basis conversion: computeBasisOffset (cashIndex−future daily closes,
                              index futures only) + applyOffset + real/cash ticker maps
    paperBroker.service.js / paperExecution.service.js
  paper/                  paper mode toggle/settings/reset/trades/equity  /api/paper/*
  workspace/              WHICH BOOK the user is standing in  /api/workspace (GET · PUT) →
                          { workspace, stored }. Its own surface, not a field on /api/paper/state:
                          a workspace is not a paper concept, and `manual` — the whole reason the
                          record exists — is the one with no paper account behind it. `manual` is
                          broker-less so it has NO connection flag to derive itself from; the choice
                          lived only in the client's localStorage and every server-side read saw a
                          manual user as a live one. workspace.model.js holds resolveWorkspace —
                          the precedence rule (paper flag WINS, else stored manual, else live),
                          mirrored verbatim in the frontend's useWorkspaceMode
  pendingAction/          the QUEUED list  /api/pending-actions (GET · POST /:id/execute ·
                          POST /:id/cancel). What is waiting on the user, from BOTH stores —
                          off-hours-queued intents AND entities the market-open sweep unparked.
                          Execute REPLAYS through the origin's own function, never a copy
  axl/                    Axl chat SSE /api/axl/stream (converse + chart + two hand-off tags:
                          `<route>desk SYMBOL` opens a desk for NEW work, `<edit>kind ID` reopens an
                          item the user already has, in the editor that owns it — see APP_SPEC §2)
                          and POST /api/axl/brief/stream — DELIVERY, not a turn: streams today's
                          market brief into the Axl chat panel (the confirm behind the offer card).
                          No model runs on it and the whole brief goes out as ONE token event, but it
                          speaks the same SSE shape as a turn, so the client's chip/typewriter/Stop
                          work with the handlers it already has
  chat/                   social DM + bot notifications (chatWs.js = WebSocket, userId → SET of
                          sockets: every tab is a reader of the same inbox, and one socket per user
                          meant a second tab displaced the first WITHOUT closing it — that browser
                          never reconnected and its unread badge silently froze); postCard → postBotCard is
                          the ONE notification transport (sendBotMessage is a back-compat alias with
                          no caller outside this file),
                          BOT_IDS (one notify bot per agent — it also keeps an ARCHIVED desk's id,
                          so the cards already in a user's thread still render with the brand that
                          sent them) + botForKind (kind → sender) and RETIRED_BOT_IDS (`idea`:
                          feed gone, thread hidden, its orphan cards fall back to Axl).
                          listCardRecipientsSince(type, since) = the shared dedupe read for any
                          fan-out notifier ("who already got today's?"), conversation→user join.
                          ADMIN_BOT_IDS (`strategy`, `analyst`) + visibleConversationsFor(convs, role):
                          the admin desks' feeds are hidden from a non-admin on list AND on
                          read-by-id (getMessages takes the reader's role from the HTTP path only)
  authentication/       signup · signin · signout · me  /api/auth/*. signin mints the session JWT
                          ({ _id, username, fullname, role }, 7d, httpOnly cookie); signup IS
                          userService.createUser (one path — it validates, refuses a taken name and
                          seeds Axl's welcome; a second copy here had drifted and welcomed nobody)
  user/                   /api/users — TWO AUDIENCES on one router: the account CRUD (list · get ·
                          create · patch · delete) is requireAdmin; a trader reaches only their OWN
                          /:id/usage and /:id/preferences (assertOwnOrAdmin, reading `role`).
                          user.model: buildUserDoc, invalidUserFields (the server twin of the sign-up
                          form's rule: username 3–32 no whitespace, fullname ≤ 80, password ≥ 8 with
                          ≥ 2 digits), listAllUserIds / listAdminUserIds (the two fan-out reads),
                          stripUser. Users are keyed by `id` (a UUID string), not Mongo's `_id`
  experience/             experience.model — how to TALK to a user (beginner may be inferred,
                          experienced only declared); its own collection, never the user doc
  threads/                the generic draft thread API over thread.service (/api/threads: draft ·
                          link · pin · list · unfinished · get · discard · pipeline drafts). AGENTS is
                          the draft-save whitelist — LIVE desks only, and the second half of a pair
                          with each panel's saveDraft (threadAgents.test pins it)
  turns/                  POST /api/turns/:turnId/stop — stopping a turn is spoken, walking away is
                          silent (turnRegistry); owner-scoped
  market/ calendar/       chart candles + quotes + market status; the week's earnings / Fed / IPO
                          calendars (calendar.service owns the shaping; the controller is three lines)
  transcribe/             raw audio → Whisper (OpenAI SDK, the only OpenAI use). Mounted BEFORE
                          express.json so the raw-body parser sees the bytes; authed — it is a paid API
  health/                 /api/health (liveness — no IO, 200 while draining) and /api/health/ready
                          (readiness — 503 the moment shutdown begins; db ping cached 5s ok / 1s fail).
                          Unauthenticated, mounted BEFORE the rate limiters, written with .end() so
                          Express never 304s a probe. Reports leader + loop count (roster only in dev)
  _shared/                cross-controller helpers:
      sse.util.js             startSseStream() — SSE headers + heartbeat + abort wiring
      parse.util.js           parseChatMessages / parseIdeaAccounts
      handle.util.js          makeHandle(log) — wrap an async handler so a throw is logged WITH its
                              route and forwarded; errorHandler — THE global error handler (mounted
                              last in server.js): a minted `httpError` answers with its status +
                              sentence, anything else is a 500 (generic body in production). Every
                              controller rides the pair; none hand-rolls `catch → res.status(500)`
      chatState.util.js       makeGetChatState / makeDeleteChatState factories (over makeHandle)
      reason.util.js          THE reason→HTTP map (in_position=409, forbidden=403 …) + sendReason();
                              route-owned reasons are passed in as `overrides`, never re-mapped locally
      entityController.util.js  makeEntityController() — list/get/patch/delete for any owner-scoped
                              kind (the HTTP twin of services/entity/entityCrud); `envelope` carries
                              the legacy `{idea}/{ideas}` body shape, everything else answers bare
services/
  agents/                 the 6 LLM desks (analyst · axl · mentor · portfolio · scanner ·
                          strategy). A seventh is archived and lives under archive/, imported by
                          nothing — see archive/README.md, and `npm run check:archive`, which
                          is what keeps "imported by nothing" from meaning "loads no more".
                          Five of the six append LANGUAGE_RULE + VENUE_RULE + BREVITY_RULE to their
                          base prompt; `strategy` takes LANGUAGE + BREVITY only and marketBrief
                          LANGUAGE only — a broadcast has no user whose venue could be read. Moved out of the flat services/ root 2026-08-07 — they are a
                          distinct KIND of module (a desk, not a service), and they were the
                          largest single group making an 80-file directory hard to read. Their
                          prompts live in `prompts/` (`join(__dirname, '../../prompts/x.md')`)
  tools/                  the 12 agent-facing tool modules (*.tools.js) — the handlers + LLM-ready
                          formatters an agent is wired with. Schemas stay in agentTools.registry
                          marketData.tools._fetchCandleRows = the ONE candle read behind get_candles,
                          get_indicators and the SMC tools. Appends candleFetch's forming bar
                          (_withFormingBar, converting the one bar back to provider SECONDS) so an
                          agent's NUMBERS cover the same session its chart IMAGE already showed.
                          Deliberately NOT in candles.provider: that router also feeds the monitors,
                          and a `structured` leaf resolves on a CLOSED candle — a forming bar there
                          would fire close-confirmed breaks the close never confirms
  portfolio.agent.service.js  scanner.agent.service.js
                          Atlas tools: screen_candidates + get_macro_snapshot + enriched get_fundamentals
                          (FMP Starter); review-state block renders benchmark-relative perf + regime delta
                          (_formatReviewDelta) from the fingerprint. _buildPortfolioStateSection is the
                          ONE rendering of the book, in every mode — the holding's `[itemId]` before each
                          ticker, its authored size + condition trees (authoredLine), and in REVIEW the
                          frozen thesis. There WAS a second one: an EDIT MODE block built from the ideas
                          list the CLIENT sent, spelling the same holding's id `ideaId:` — so one prompt
                          described the book twice while telling the model one of them was the only id
                          source, and an empty client list left Atlas inventing ids that came back
                          not_found on every accepted change. Deleted §4; a desk reads its subject from
                          the database
                          Argus (scanner) systematic-discovery funnel: Phase-2 grounded sources
                          screen_candidates + get_market_movers + get_sector_snapshot + get_analyst_actions
                          (no memory-recall); Phase-3 get_candles/get_indicators baseline + get_chart/
                          get_orderblocks/get_false_breaks vision (KLineCharts, onChart:null = model-only)
  portfolioState.service.js listPortfolioItems = THE query for a book's rows and the one place
                            ownership is enforced on them; every caller comes through it (the
                            rebalance's sibling + conviction reads included), with its own projection
                            and an optional injected db. computePortfolioState = actual weights,
                            drift, unrealized P&L, thesis age, earnings — 5-min TTL snapshot so review
                            follow-ups reuse one prompt-cacheable block. STATE_PROJECTION is exported
                            and TESTED against the fields the mapper reads: it omitted
                            conviction_history, so convictionPrev was null on every holding and the
                            conviction review trigger could never fire. listPortfolios = the cheap
                            book enumeration (also the watchlist's)
  portfolioMode.util.js     mode/broker/account derivation for a book — _deriveMode, _accountLabel,
                            _virtualAccountNames, formatWorkspaceLine. Lived under api/portfolio (it
                            was carved out to break a portfolioChat↔portfolioState cycle); moved to
                            services/ in §4, where two of its three consumers already were
  earningsWindow.util.js    the two PURE halves of the earnings join shared by computePortfolioState
                            and upcomingEvents: the window (today +30d, YYYY-MM-DD) and
                            earningsBySymbol (first row per name = its next report). The FETCH is
                            deliberately NOT shared — portfolioState swallows a failure, upcomingEvents
                            must name it in `unavailable`
  portfolioReview.util.js   PURE review-lifecycle helpers (no I/O): benchmarkTicker (mandate text→ETF proxy),
                            buildFingerprint (the "then" snapshot), computeReviewDelta (benchmark return +
                            regime then→now), computeReviewTriggers (the non-LLM pre-check signals)
  valuation.engine.js       PURE computeValuation (Analyst T1 relative: justified multiple × forward metric
                            → PT + bear/base/bull + GAP vs Street consensus); percentile/median. Shared by
                            the Analyst agent (P3) + coverage monitor (P5) — one source of truth for "our number"
  valuation.tools.js        get_consensus + compute_valuation agent tools over valuation.engine + FMP consensus
                            feeds; pure LLM-ready formatters (edge classified above/below/thin vs Street). (P2)
  agentUtils.js           shared tool handlers, makePromptLoader, makeToolHandler,
                          formatMoney/buildAccountLines, stripEmitTags, runtime glue.
                          formatMoney is UNGROUPED on purpose: `$94,500` read the other way round is
                          `94.500`, and the desks came back with 94.5 — money an agent READS carries
                          no thousands separator (toFixed never groups; toLocaleString does)
  tradingContext.service.js  ONE venue read for every desk: getTradingContext (the WORKSPACE the user is
                          standing in, connected brokers, each account's balance + free cash +
                          capabilities + selected + open positions) and checkBrokerSymbol (is this
                          tradable HERE, and what does the broker call it — 3-state: true / false /
                          null=unreachable, never merged).
                          EVERY venue goes through brokerService.getTradingAccounts, live and virtual
                          alike. Reading paper/manual accounts straight from the store (which this
                          once did) returns raw documents with NO freeMargin — virtual cash is never
                          debited when a position opens, so only the adapter derives what is actually
                          deployable, and every desk silently sized against balance instead.
                          withBrokerAvailability rides on get_quote so a live-book desk is TOLD
                          tradability rather than asked to remember to check (TTL-cached per user+ticker)
  workspace.service.js    getStoredWorkspace / setStoredWorkspace (the user's own choice, 60s TTL —
                          shorter than experience's 5min: a level changes twice in a life, a
                          workspace several times an hour) + getActiveWorkspace, which joins it with
                          the paper flag for callers that do NOT already hold the connections.
                          getTradingContext deliberately does not use that join — it reads the
                          connections anyway, so going through it would fetch them twice. Both
                          funnel through venue.resolve.activeWorkspace, which is the part that must
                          not drift; only the fetching differs
  tradingContext.tools.js  get_trading_context + check_broker_symbol handlers (userId-bound, built
                          per request) + the shared tool descriptions. Wired into all 7 agents.
                          ALSO buildVenueSection — the same read PUSHED into every turn, because a
                          tool is an invitation and desks kept opening with "are we in paper or
                          live?". Four facts only (workspace · broker · accounts · available to
                          deploy); positions and P&L stay in the tool, since they move every tick.
                          _WORKSPACE_LINE and _accountHead are SHARED by the block and the tool
                          answer, so the two can never quote a different book or a different number.
                          Rides attachTurnContext (the turn, never the system prompt — free cash
                          moves on every fill). Excluded: Pythia + the market brief, which are
                          broadcasts with no user to report on
  marketHours.tools.js   the AGENT-facing half of market.service: ONE formatMarketStatus renderer
                          serving BOTH surfaces — get_market_hours (the explicit ask) and
                          withMarketStatus, which rides on every get_quote so a desk is TOLD the
                          market is shut rather than asked to remember to check (same discipline as
                          withBrokerAvailability). Unbound — hours belong to the instrument, not
                          the user, so the handler is static in every agent
  entryTimeGate.util.js  PURE entryTimeGate(entity) — is entry clock-gated, wholly or partly?
                          Lifted out of minos.monitor once marketOpen.monitor needed the same read.
                          Drives the market-closed exemption + the `off_hours` card note
  llmStream.util.js       createTagSuppressor({ onToken, captures }) + ALL_EMIT_TAGS — the ONE list
                          of tags suppressed from every agent's token stream. A new emit tag goes
                          here first, or it leaks raw into the chat AND is never captured
  routing.util.js         desk-to-desk ROUTING — the shared mechanism (2026-09-18). The grammar Axl
                          always spoke (`<route>desk SYMBOL</route>` + `<open>…</open>`, or
                          `<edit>kind id</edit>`), its parsers, the controller-tier validation
                          (routeFields: desk vs role, symbol, opening gated on a desk), the capture
                          an agent wires (makeRouteCapture) and the rule a desk's spine carries
                          (buildRouteRule — every routable desk but its own; never an admin desk).
                          Every desk speaks it; the client lands all of them on one doorway
                          (MainPage.handleRoute → handleAxlPick). Nothing structured crosses — the
                          OPENING is where what the sender found travels, as prose. WHEN to route is
                          each desk's judgment; the rule only gates it on the user's ask
  suggestions.service.js  follow-up CHIPS — the shared pipe for "what might I ask next". Owns the
                          `<suggest>` tag, the capture, the cleaning and the cap of 3; one line
                          (makeSuggestionCapture) wires any desk in and the client renders one
                          thing. Costs no extra latency: they ride out inside the reply already
                          streaming, not a second model call. WHAT to suggest is NOT here — that is
                          judgment and lives in each desk's prompt (a shared generator would be the
                          cross-desk unifier the house rule forbids). Axl only, so far, and never on
                          a routing turn (see APP_SPEC §2)
  conditionTree.service.js  resolve/collect/normalize condition trees
  orderPlan.service.js  protectionPlan.service.js
  price.service.js        THE candle cache for the monitors + agent tools: an in-process envelope per
                          ticker × timeframe (bounded), fetched incrementally (the tail, or one backfill)
                          through candles.provider. Freshness alone decides a refetch, and a FAILED or
                          EMPTY fetch is stamped too — a down or uncovered symbol is asked once per hour,
                          not once per read. Was a JSON file per series under data/ (unsafe, machine-local)
  news.service.js         THE ONE NEWS PIPE: Finnhub for a ticker or the front page, GNews for words;
                          one in-process shelf per (category, subject), 1h (15m for headlines), fetched
                          incrementally and merged; a provider failure serves the warm shelf STALE and
                          does not re-stamp it. The shelf was a file under data/news until 2026-09-16
  timeframe.service.js  brokerSymbol.service.js
  market.service.js       THE market-hours engine: one class-aware gate (isAssetOpen), one status
                          read (getMarketStatus → open/nextOpenMs/session/phase), sessionPhase +
                          sessionStartMs, and nextCandleCloseMs(symbol, assetClass, rung, nowMs) —
                          the ONE place "when does the next `rung` candle close for this instrument"
                          is computed (session-aligned intraday, session close for `day`, first close
                          of the next session when shut), which is Talos's whole schedule. Four
                          calendars — crypto 24/7 · forex 24/5 · CME index futures near-24/5 · US
                          equity RTH. sessionFor is the ONE classifier (explicit asset_class first,
                          symbol heuristic second). NO holidays or half-days, and no non-US exchange
  lifecycle.service.js    startLoop(name, loop) / stopLoops() / loopNames() / markDraining() —
                          the registry that makes shutdown writable: every background loop is
                          started through it and stopped in reverse, one bad stop() never strands
                          the rest. loopLeader.js is the one boolean (leader / follower) health reports
  instanceLock.service.js createInstanceLock — the background-loops LEASE (system_locks): a single
                          conditional upsert only one process can win; a duplicate-key error is the
                          "someone else holds it" signal, not a fault. onLost stands the loops down
                          so two reconcilers never coexist. See docs/architecture/single-instance.md
  httpError.util.js       (below, with the utilities)
  config.js               THE configuration surface — every env var named once, with its type,
                          default and purpose. Was 43 vars read as inline `Number(process.env.X)
                          || d` at ~70 sites. It OWNS dotenv (so no module depends on having been
                          imported after something that happened to load .env — that ordering was
                          real and it bit monitor.claude), every value is a live GETTER (tests
                          override process.env; freezing would break them), and it does NOT load
                          .env under `node --test` — the unit suite runs offline and several tests
                          depend on the database being unreachable. server.js fails fast on a
                          MISSING required value AND on a MALFORMED one (set but unparseable —
                          previously a silent fallback), and warns on .env keys nothing reads
  priceAnalytics.service.js  risk (annualised vol + ATR), correlations, price action, cycles — the
                            desks' get_risk_metrics / get_price_action / get_correlations /
                            get_cycle_analysis and Atlas's raw vols+matrix read. Arithmetic over a
                            candle series from WHICHEVER source candles.provider picks; lived in the
                            Yahoo provider until 2026-09-16 with a private FMP→Yahoo fetch that bypassed
                            the router. The pure math is priceStats.util + cycleAnalysis.service
  format.util.js  http.util.js  ttlCache.util.js  priceStats.util.js  cycleAnalysis.service.js
  mongoCache.util.js      makeMongoBackedCache({ collection, ttlMs }) → { read, write }: an in-process TTL
                          map over a Mongo collection, best-effort on both sides. FMP fundamentals and
                          Finnhub profiles ride it (each had written the pair by hand)
  httpError.util.js         httpError(status, message, extra?) — THE way to throw an error the client
                            may see (sets `expose`; errorHandler trusts nothing else). Replaced 28
                            `const err = new Error(msg); err.status = 404; throw err` blocks
  number.util.js            rounding, once: roundTo/round2/round4/round8 (NaN through), roundOrNull
                            (display: not-reported → null), roundOrZero (quantities). Replaced twelve
                            private `_round2`-style copies; import from here, never redeclare
  restingOrders.service.js  cancelRestingEntryOrders(entity, userId) — pull an entity's WORKING entry
                            orders off the broker (an `orderId` with no `positionId`). The pipe for
                            every path that stops an entity claiming its order: delete, disarm,
                            expiry. WHEN there is one to pull stays the caller's judgment
  logger.service.js       debug/info/warn/error → console + logs/backend.log (async appends;
                          switchToSyncLogging() at shutdown so the tail is not lost to process.exit).
                          Writes NO file under the test runner (_setLogSinkForTests to redirect).
                          Timestamps are toLocaleString('he')
  timeout.util.js         withTimeout(promise, ms, label) — THE one timeout guard (monitors, coverage
                          refresh, the health ping); lives here so both layers reach it
  tokenUsage.service.js     recordUsage(userId, model, usage, agent, { monitor }) books every LLM
                            call into the month document; `monitor: true` (Talos assessments) also
                            accumulates `monitorCost`, and chatSpend(doc) = totalCost − monitorCost is
                            what overCeiling compares — a user's own monitors must never degrade
                            their chat model, and are never blocked by it (they bypass the seam)
  ohlcv.service.js          getCandles(symbol,timeframe,count) → the compact {t,o,h,l,c,v} the
                            EVALUATORS read. A relabel over priceService, not a fetcher. Was
                            providers/ohlcv.provider.js until 2026-08-07 — it reaches nothing
                            external, so it sat in the one layer defined by doing exactly that.
                            NB distinct from candleFetch.service below: this one is the monitor/
                            paper-fill shape, that one is the FMP-first ROUTER behind the chart
  candleFetch.service.js    fetchMarketCandles(symbol,{timeSpan,multiplier,from,to}) + toMsCandles — shared
                            FMP-first (USE_FMP_CANDLES) → Massive/Yahoo fallback (futures/index/broker symbols
                            only) → sec-to-ms pipeline. Massive defaults missing from/to to avoid a crash. One code path for the
                            /api/market/candles endpoint AND the chart renderer (same data the monitor sees).
                            (Named distinctly from monitorUtils.fetchCandles, the monitor's broker-candle router.)
                            + buildFormingBar: TODAY's bar, which the EOD feed publishes LATE (measured
                            2026-08-17: absent 90min into the session, present ~3.5h in) — so early in a
                            session day/week/month series still ended on the PREVIOUS day and the
                            chart painted the live price onto that CLOSED candle. Built from the quote
                            (open/dayHigh/dayLow/volume), stamped at today's ET midnight. Gated on the
                            quote's own TRADE TIME falling in a later period than the last bar, so a
                            weekend (quote still reads Friday) and a feed that already carries today both
                            fabricate nothing. day/week/month at multiplier 1 only — intraday feeds carry
                            their own forming bar, an aggregate's groups would be shifted by an extra one.
  chartImgCache.service.js  cachedChart(symbol,timeframe,studies) → { png, source } — 60s shared chart-PNG
                            cache; cachedChartImage() is the png-only view (monitor evaluators, price-
                            structure tools). FALLBACK-FIRST: own KLineCharts render first (OWN_CHART_RENDER,
                            default on), chart-img (TradingView) on any error/timeout. `source`
                            (CHART_SOURCE.OWN | CHART_IMG) lets get_chart label the image honestly to the LLM.
  chartRender/
    klineRender.provider.js   renderChartImage(symbol,timeframe,studies) → base64 PNG via headless
                              Chromium (Playwright). Warm single browser + serialised render chain +
                              closeRenderer() shutdown hook. Registers custom VWAP/ATR in-page (not
                              klinecharts built-ins); paneId 'candle_pane' for overlays.
    studyTranslate.js         studiesToIndicators/translateStudy — _buildStudies TradingView study
                              objects → klinecharts indicator descriptors (overlay vs own-pane split).
    NB: computeRR in services/setup.schema.js (PESSIMISTIC r:r — worst entry, furthest stop,
        NEAREST target) is mirrored by the FE cmps/TradeIdeas/orderRisk.util.js, which is what the
        OrderConfirmDialog shows at approval. Keep the convention in sync.
    NB: the FRONTEND popup chart mirrors this — botmarket-frontend cmps/TradeIdeas/chartOverlay.js
    (textToIndicators = FE port of _buildStudies+studyTranslate) + cmps/PriceChart/PriceChart.jsx
    (VWAP/ATR registerIndicator templates + tradeLevel overlay). Keep the ported logic in sync.
  marketBrief.service.js    THE market brief — one broadcast of what the world is doing, shared by
                            EVERY user (no userId anywhere; that is load-bearing, not an optimization).
                            Data assembled in code — tape board (indices/rates/commodities/FX via the
                            Yahoo-fallback quote path, so ^GSPC / EURUSD=X / GC=F all price), macro
                            snapshot, and a 7d calendar filtered to Fed rows + MAJOR_EARNINGS only —
                            then ONE model turn with web_search for the narrative. Cached 45min
                            (MARKET_BRIEF_TTL_MS) + single-flight: the morning fan-out costs one run,
                            not one per user. Two consumers: Axl's tool and POST /api/axl/brief/stream
  marketBrief.tools.js      get_market_brief — UNBOUND (no userId, so the brief cannot be made
                            personal). Axl RELAYS the brief; it does not write market commentary
  watchlist.service.js      listWatchedItems — "what am I watching?" across EVERY list the Floor
                            shows, in ONE read (setups · books · coverage · scans · the off-hours
                            QUEUE · Aether runs, one row per event · and, for an admin, the research
                            queue — ADMIN_KINDS, dropped before the read for a trader so the list is
                            absent, not refused). SCOPED to the workspace the user is standing in:
                            WORKSPACE_SCOPED_KINDS (setup · portfolio · queued) bind to an account and
                            belong to one book — a queued row carries the mode of the entity it is
                            about, resolved at read; research binds to none. COMPOSES the owning
                            services rather than querying Mongo, and settles them independently: one
                            read failing is REPORTED in `unavailable`, never reported as zero.
                            Returns structured rows only — see entity/toWatchRow.js for the projectors
  userData.tools.js         the ADAPTER over it (+ performance / upcomingEvents): rows → the compact
                            text a model reads. Every watch line leads with `[kind:id]`, and that id
                            is load-bearing: it is the handle Axl quotes back in `<edit>` to reopen
                            that exact item. Formatting is judgment, the read is a pipe, and the pipe
                            is shared — a future card or route renders the same fields
  eventRisk.service.js      buildEventRisk({asset,assetClass}) — scheduled catalysts FROZEN onto an
                            entity at build: earnings (Finnhub, equities) + Fed/macro (FRED),
                            low-impact dropped, 10d horizon. Never throws. A monitor reads it to hold
                            off entering into an unresolved binary
  tradeCapture.service.js   append-only `trades` history (captureOpen / captureOpenBare / captureClose)
  sleeveSource.service.js   the autonomous Atlas → Argus → Prometheus → Atlas hop. One <screen_request>
                            = one sleeve: FMP screen under the school's pond (SCHOOL_SCREEN, a proxy —
                            Prometheus applies the real bar) → drop covered → research_queue rows
                            (source 'argus', context.sleeve) → researchRun.startRun AS THE HOUSE
                            (userId null: no budget degrade — and no spend booked to anyone, a known gap) → onRunSettled → an Atlas
                            card `sleeve_sourced` to the requester. Pending sleeves are in-process
                            memory, like the run. See docs/desks/roles-and-sourcing.md
  aetherScheduler.service.js  The Node side of the Python aether-engine: spawns scripts/scheduler.py as a
                            child process when AETHER_ENGINE_PATH points at a checkout with a built venv
                            (a quiet no-op everywhere else — every deploy), bridging the Mongo connection
                            Node is ACTUALLY on into MONGO_URI/MONGO_DB and refusing to spawn when the db
                            name cannot be resolved (an inherited MONGO_DB once wrote a parallel copy of
                            every aether_* collection). Started OUTSIDE the instance lease, on purpose.
                            runDiscovery spawns select_events.py on an admin's press — the one leg that
                            spends real money — one at a time, progress parsed off the engine's own log
                            lines, refusals stamped with a status
  aetherQuickRead.service.js  Prometheus's quick read on one Aether name (credible · priced_in ·
                            contradicted · unclear) — phases 1–2 on Sonnet, one paragraph, optional.
                            Node OWNS aether_candidate_reads (the engine's rows are Python's); one read
                            per name per event, one in flight, re-read only when the SET of live events
                            naming the ticker changed. Judged against every live event, not the one pressed
  lastPrice.service.js      fetchLastPrice(symbol): THE last-price read — quote first, a 1-minute-candle
                            fallback second, null only when both fail; a non-positive price is NO price.
                            The input to every zone gate, baseline stamp and coherence check. Lived in
                            monitoring/monitorUtils until 2026-09-16, which had two services reaching up
                            into the monitor tier for it
  exitOrders.util.js        buildExitOrder (applies +basisOffset → broker price space) / exitOrderRecord /
                            closeSide / orderSymbol — the closing-order shape three api services and two
                            monitors share. Was monitoring/, importing api/broker to serve api/
  researchRun.service.js    headless Prometheus over the research queue, one name at a time, writes
                            the coverage. ONE run per process; onRunSettled(fn) is how sleeveSource
                            learns a run ended (and chains the next when its names were queued after
                            the run listed the queue). The abort controller is cleared only if still
                            ours — a run chained from a listener must stay stoppable
  houseArtifact.repo.js     The write pipe under the two HOUSE ARTIFACTS (coverage, tilt) — a standing
                            view with no owner, kept as a publication log. revise(id, $set, revision)
                            prepends the revision and sets the patched fields atomically; a $set carrying
                            `revisions` is refused. recordMonitorState = the monitor's quiet bookkeeping,
                            no revision. The schema, the gates and what counts as a revision stay in each
                            service; injectable getDb so the update's shape is testable
  houseScan.service.js      Argus's admin-pipeline mode: on tilt publish, FMP-screen each overweight
                            sector and queue the hits. Same screener as sleeveSource, own inline call
  coverageNotify.service.js Prometheus's cards. coverage_event = the monitor's material verdict,
                            fanned out to EVERY ADMIN (listAdminUserIds, visibility 'admin') — house
                            coverage has no owner, so the audience is derived at delivery, as
                            tiltNotify's review offer does. coverage_refreshed = the ping after a
                            headless refresh: to the ONE user whose <coverage_refresh> hop asked, or
                            — for the monitor's scheduled re-model, which has no user — to every admin
  tiltNotify.service.js     Pythia's cards, both to the ADMIN ROSTER: tilt_event on publish (what
                            moved, via tilt.assess.diffStances) and tilt_review when the monitor finds
                            the view due. The change card used to be narrowed by a coverage.userId join;
                            coverage lost that field at the house pivot and the card went to nobody for
                            three weeks — there is no per-user sector audience left in the data
  manualNotify.service.js   broker-less entry/exit FillCards → social chat (embedded price/qty confirm)
  tradeNotify.service.js    notify+route cards → social chat: entry_confirm (paper/live idea entry)
                            + queue_ready (the market-open nudge, from Axl) + setup_invalidation /
                            setup_manage (Talos, from Mentor). Pure builders + thin postCard
                            wrappers; card is the alert, existing UI is the destination. A few
                            builders here have callers only under archive/ and emit nothing.
                            entry_confirm carries a `note` (passed_earlier | off_hours | null) for scheduled entries
                            A card WITHOUT `actions` is a statement, not a request (ran_away /
                            invalidated_fyi) — no buttons, no pending lifecycle
  positionManage.service.js THE HANDS of in-position management, shared by every desk: resolve the
                            broker links, fan the accepted action across ALL accounts (amend stop/TP,
                            partial/full close), write position_state once and the `manage` journal
                            row with it (manageApplied → repo.update's journal seam). Kind-BLIND — the caller
                            passes `entity` (owns position_state) + `holder` (owns brokerOrders); for a
                            setup they are the same doc, and the split exists for kinds where they
                            are not.
                            Execution contract: move_stop{new_stop} take_partial{size_pct}
                            let_run{new_tp|cancel_tp} exit_now{}. The contract keeps let_run (a
                            queued row written before 2026-09-17 may still carry it) but no live
                            desk proposes it any more — Talos's menu dropped it: moving a target is
                            an edit of the plan, not a monitor act. Each desk translates its own dialect in
  talos.handoff.service.js  Mentor's half: POST /api/setups/:id/action → accept (move_stop|take_partial|
                            exit_now) or dismiss. Translates Talos's {stop,why}/{leg,quantity,size_pct}
                            into the contract above — the partial's size is the WATCHED TARGET's own,
                            resolved by the monitor, never a fraction the model chose. `add_leg` →
                            `confirm_order` (it is a parked ORDER, not a manage action — accepting
                            here would place the size twice)
  journal.service.js        the monitor journal's ONE owner — appendJournal / listJournal over the
                            `journal` collection (index {entityId, at:-1}; newest first, cursor on
                            `at`; no cap, no TTL). Left the entity document 2026-09-17: at one row per
                            candle `monitor_state.timeline[]` could neither ride the envelope every
                            list fetch carries nor keep its cap of 50. Writers: dueLoop.makePersist
                            (the monitor's row) and entityRepo.finalizeClose (the close line);
                            reader: GET /api/setups/:id/journal. monitoring/monitorJournal.js builds
                            the row, this file stores it
  pendingAction/            the OFF-HOURS QUEUE (docs/architecture/off-hours-queue.md). RULE: nothing
                            executes off-hours, paper included — a decision confirmed while the venue
                            is shut is queued, not fired and not lost.
                            executionGate.js  THE market-hours gate. deferIfClosed() → proceed, or
                                              queued + do not touch the broker. Replaced five call
                                              sites that each decided hours policy and disagreed
                            pendingAction.repo.js  `pending_actions`: the record (an intent with no
                                              entity of its own). enqueue is idempotent per
                                              (user, entity, verb); transitionFilter is the guard
                            originRegistry.js  execute + cancel per origin (portfolio_item, call,
                                              setup, idea). Keyed, not a switch; the gate REFUSES
                                              to queue an unregistered origin. `_byDecider` splits
                                              a review's exit from a MONITOR's — both spell `exit`,
                                              but a monitor's can be a slice, and running that
                                              through _exitItem would liquidate the position
                            pendingWork.service.js  listWaiting = the one read unioning queued actions
                                              + entities awaiting_confirm into one row shape
  thread.service.js  thread.util.js   unified subject-bound conversation threads
                          (`threads` collection). A conversation gets a threadId at the
                          start (subject-independent), is saved as a `draft` once it crosses
                          the agent's substantive floor (thread.util.isSubstantive over the
                          agent's emitted phase — NOT content), TTL-expired + LRU-capped, and
                          is `linked` to its artifact (idea/portfolio/scan) on generate.
                          Generalizes portfolio_chats; migrating agents off per-agent chat-state.
providers/
  anthropic.provider.js         THE ONE Anthropic call path: streamAnthropicWithTools — the request → tool
                                → request loop, adaptive thinking + effort per model (_thinkingConfig, with
                                THINKS_BY_DEFAULT for Opus 5 / Sonnet 5), the cache-breakpoint walk, and
                                _noteStop, which logs a max_tokens or refusal stop with the model and the
                                stop_details category. The model is the caller's (llmModels resolves it);
                                there is no second default here. The non-streaming twins were deleted
                                2026-09-16 with no caller. (OpenAI SDK is used directly, transcribe only)
  yahoofinance / massive / finnhub / fmp / fred / sec / gnews / binance / usaspending
                            EVERY JSON call rides services/http.util.getJson — timeout per attempt, the
                            request meter, typed err.status + err.body, a jittered retry on 429/5xx.
                            chartImg (a POST for a PNG) is the one exception. Nothing imports axios
  fmp.provider.js               Starter plan: getFundamentals (valuation+analyst+ETF look-through), getEarnings(Calendar),
                                screenCandidates (company-screener), getMacroSnapshot + getMacroRaw (treasury/econ/sector);
                                getSectorSnapshot / getMarketMovers / getAnalystActions (Argus discovery feeds);
                                getAnalystEstimates / getPriceTargetConsensus / getGradesConsensus + getGradesHistorical /
                                getHistoricalMultiples (Analyst consensus + valuation feeds, P2);
                                getSectorRaw. fmp.price.provider.js = live quote + candles (paper feed); week/month
                                aggregated from daily EOD via groupOhlcByPeriod (FMP has no native week/month endpoint)
  chartImg.provider.js          chart-img (TradingView) PNG — now the FALLBACK behind the own-chart
                                renderer (services/chartRender); still primary when OWN_CHART_RENDER=false
  ctrader.provider.js  ctrader.session.provider.js (getTrendbars + trendbarToOHLCV)  ctrader.ws.provider.js
  ibkr.gateway.provider.js  TWS-socket client to a local IB Gateway (the Client Portal REST provider was deleted 2026-09-15)
  mongodb.provider.js       getDb() — ONE MongoClient per process: concurrent first callers share the
                            in-flight connect (the boot fires ten un-awaited index ensures; until
                            2026-09-16 that was ten clients, nine orphaned). closeDb(), getDbName(),
                            stripId/stripIds; _setClientFactory is the test seam
monitoring/
  preflightEntry.js         the arm-time "is the entry level ALREADY held?" check. Two evaluations
                            of the same tree — a STATE read and an EDGE read — because the monitor
                            fires on a rising edge, so a breakout that happened before the arm can
                            never fire and the entity sits at `looking` forever. Lifted out of
                            minos.monitor.service.js when Minos was DELETED (2026-08-18); its other
                            export, resetIdea, only cleared Minos's own Map and went with it.
                            Best-effort: every failure path returns not-satisfied so the arm still
                            proceeds. NB the `idea` KIND is untouched — it is the execution tier.
  (One monitor moved to archive/monitoring/ on 2026-08-18 with the desk it served — see
   archive/README.md. Its two shared helpers, _allText and _formatEventRisk, stayed behind in
   assess.shared.js because Talos imports them.)
  talos.monitor.service.js  Talos — the Mentor-setup loop (own tick, kind:'setup'). TWO BRAINS, ONE LOOP:
                            pre-entry readiness, past-entry management (_managePosition). THE LOOP ONLY:
                            wake handlers, scheduling, writes and the injectable IO. THE RULE (rebuilt
                            2026-09-17, docs/design/talos-per-candle.md): a model call only on a
                            condition the user wrote in words. Pre-entry that is always true, so EVERY
                            wake reads — on each candle close of the rung the model chose, and ahead of
                            it when a price guard fires; reason = expiry_review | guard | first_look |
                            candle. Cheap and free come first: the SCENARIO gate (which PREMISE price
                            reached — a fired guard resolves to its own zone, _hitFromGuard, because
                            the spot check a minute later may have missed the crossing) and the
                            validity gate (close, not touch — it can only KILL). In position it reads
                            only if a leg is WATCHED (setup.schema.watchedLegs); a position of plain
                            levels is stamped monitor_state.dormant and excluded at the QUERY. The
                            verdict is held to allowedVerdicts(watched); a take_partial is sized from
                            the leg, an add_leg needs a watched pending leg actually printing. No
                            cadence: next_check_at = nextCandleCloseMs(rung) + READ_LAG_MS (30s). No
                            reads off-hours (the fill stamp and the expiry review are the exemptions).
                            Talos NEVER executes — every verdict is a card the user confirms
  guardSweep.service.js     Talos's tier 0 — the FREE wake. Every config.guardSweepIntervalMs it prices
                            every open-market setup once (quoteMapForSymbols, one call for the whole
                            set) and tests each armed guard {price, direction, means} against the
                            RANGE since the last sweep (guardFires) — a level touched and left between
                            two looks still fires. Writes nothing but `woke_on` + next_check_at = now;
                            the loop's wake reads what fired. Skips shut markets. The time term and
                            its backstop went 2026-09-17 — the candle close is the timer
  monitorJournal.js         the journal ROW: journalEntry(reason, opts) is the one builder for every
                            line — a read (first_look | candle | guard | expiry_review | limit_order |
                            limit_disarmed) and the code-written events (entry | invalidation | exit |
                            pre_active | manage). Carries rung, price, verdict, note, the conditions checked,
                            the tools pulled, the guard that fired and the guards armed now. Non-read
                            wakes write nothing. Storage is services/journal.service.js
  monitorSchedule.util.js   the persisted cadence entry.monitor and exit.monitor SHARE — poll/timeout/
                            min/idle constants, the ISO next-check stamp (floored at a minute) and the
                            sleep-until-open arithmetic. Two loops that must agree on when a document
                            is due; they used to carry a copy each. Talos is NOT a caller (it has no
                            cadence — its next wake is a candle close)
  talos.gates.js            its PURE tier, split out 2026-09-15: the zone/scenario gates, guard
                            resolution (_hitFromGuard), the in-position arithmetic (rMultiple /
                            computeMetrics — R, MAE, MFE for the read and the UI), the validity + breach
                            machinery, and the condition/cost ledger (normalizeConditionResults,
                            latchPatch, costPatch). No IO, no clock beyond an explicit nowMs.
                            positionGate / reviewDue went 2026-09-17 — nothing decides WHETHER to read
                            any more, only whether a leg is watched
  talos.assess.js           the setup read (readiness + in-position). Conditions are PROSE with a
                            weight/mode, graded one entry per declared id — the model goes and checks
                            them with the shared assessTools kit rather than being pre-fetched at.
                            EVERY READ OPENS CHEAP: candles on its rung + reference quotes + memo +
                            what it armed, NO IMAGE (openingContext); the chart, indicators, structure
                            reads, correlations and the web are TOOLS it calls when the numbers cannot
                            answer, and _runRead returns the calls it made (_tools) for the journal
                            row. One prompt core (_CORE) with a pre-entry and an in-position tail; the
                            in-position menu line is generated from allowedVerdicts so the prompt
                            never offers a verdict the monitor would refuse. TIMEFRAME IS THE MODEL'S
                            CHOICE: it returns `next_timeframe` (clamped to the setup's ladder, stored
                            on monitor_state.timeframe) and the next read OPENS there — openingRung —
                            at that candle's close. There is no next_check_min and no cadence: the
                            rung IS the pace, so the two can never contradict each other. Ladder floors
                            at 5min (1min is 402 off-plan at FMP). Model default Sonnet, thinking off
                            (assessRouting) — the saving was the image, not the model
  dueLoop.js                the wake-up chore every monitor is built on: find what is due, CLAIM it
                            against a lease, check it under a timeout. THE LEASE IS THE SUBTLE PART —
                            withTimeout ABANDONS a slow check but cannot cancel it, so without one the
                            next tick re-selects an entity whose check is still in flight and fires it
                            twice. Shared by Talos, exits, coverage and tilt. `statePath` is what lets
                            the research loops ride it (they schedule under `monitor.*`, entities under
                            `monitor_state.*`) and `kind` is OPTIONAL because their collections hold one
                            thing and carry no such field — passing one selects nothing, forever,
                            silently. `afterTick` is for a budget spent ACROSS the due set
  entry.monitor.js          the ENTRY loop — what an armed entity's `looking` status has always
                            claimed ("a monitor is watching for entry") and, between Minos's deletion
                            and this, nobody did. Evaluates on a RISING EDGE against `entryFloorAt`
                            (requireHeld), so a level already true at arm time does not fire — which
                            is what preflightEntry warns about instead. On trigger: `hit`, an order
                            plan, a confirm card — or `awaiting_market` off-hours, silently, because
                            the market-open sweep owns that card. Manual never gets a plan. A PURE
                            SCHEDULED entry (every leaf a time leaf) is exempt from the market gate:
                            the clock fires it, not the tape. `clearsEntrySchedule` is exported here
                            and called by tradeIdeas.updateIdea — arming must clear the persisted
                            cadence or the loop sleeps through the arm
  exit.monitor.js           the SOFTWARE exit tier's loop — the caller positionMonitor.checkPosition
                            lost when Minos was deleted (2026-08-18), and did not have again until
                            this. Kind-BLIND like marketOpen, because the work is written by more than
                            one kind (idea, portfolio_item, either of them manual) and a loop tied to
                            one desk dies when that desk is archived. Excludes `setup`: its zone exits
                            rest at the broker, checkPosition cannot read a zone, and Talos already
                            claims the same schedule field — two claimants would push each other's
                            wake-up forward until the loser stopped running. hasMonitoredWork
                            pre-gates BEFORE any IO, because this loop sees every open position in the
                            app and almost all of them are protected entirely by resting orders
  positionMonitor.js        what exit.monitor drives, and the one place a monitor can send a closing
                            order: evaluate the residual stop/tp legs and any additional entries for an
                            open position, then close at the broker — or QUEUE for the open, or alert a
                            manual holder to close it themselves. NOTHING EXECUTES OFF-HOURS, paper
                            included. executeDeferredClose replays a queued close through the very same
                            closer, so an overnight stop and an in-hours stop place identical orders
  themis.monitor.service.js (was portfolio.monitor.js) due-review NOTIFY-only; runs the non-LLM
                            pre-check computeReviewSignals → enriches the bubble + payload with triggers[]
  marketBrief.notify.js     the daily market-brief OFFER: one card per user per weekday (12:00 UTC,
                            MARKET_BRIEF_OFFER_HOUR_UTC; MARKET_BRIEF_OFFER=off disables). Posts the
                            OFFER, never the brief — the confirm builds it, so the fan-out costs no
                            tokens. Dedupe reads the posted cards themselves (listCardRecipientsSince),
                            so a mid-fan-out restart resumes instead of double-posting. The confirm
                            takes the user to AXL and streams it there; the brief never lands in the
                            social chat (a page of prose in a one-line surface, with nobody to ask)
  tilt.monitor.service.js   Pythia's slow loop. Cheap tier daily (re-price each open stance vs its
                            FROZEN baseline, mature the ones whose window closed — tilt.assess, pure).
                            Expensive tier is an OFFER, not a run: reviewDecision says due (stance
                            matured / macro catalyst / 30-day floor, under a 7-day cooldown) →
                            tiltNotify.notifyTiltReviewDue posts a `tilt_review` card to every admin,
                            and the confirm runs the review at PYTHIA'S DESK — a re-author supersedes
                            the view everyone reads, so it takes a confirm. Both clocks anchor on
                            reviewAnchorMs (last publish/reauthor off the revision trail), NEVER on
                            updated_at — the loop's own maturity write moves that
  coverage.monitor.service.js  Prometheus's slow loop (dueLoop, hourly tick, ~daily per name, every
                            status but retired). Cheap tier: price + the Street's PT distribution →
                            coverage.assess.classifyGapState (target_hit / target_hit_early /
                            validating / diverging / stable) → a revision + a coverage_event card to
                            every admin on a material verdict, bookkeeping only on a quiet one. The
                            early-hit ratchet is scoped to the TARGET it silenced (early_hit_at vs
                            price_target.set_at). Expensive tier = a RE-MODEL: coverage.remodel.
                            remodelDecision (catalyst passed / edge changed category / 90-day floor /
                            early hit, under a 14-day cooldown; an Aether signal can pull it in) →
                            _runRemodels after the tick, held names first, MAX 3 → claimRemodel (a
                            compare-and-swap on last_remodel_at, so a second process stands down) →
                            coverageRefresh.refreshCoverage({ userId: null }) — a HOUSE run: no venue,
                            no audience level, the refreshed card to every admin. That call answered
                            bad_args from the coverage pivot (2026-08-26) to 2026-09-16 and the
                            tier did nothing; _runRemodels reads its answer now
  coverage.assess.js        the PURE gap classifier + recomputeGap (our PT's percentile in the Street's
                            low–high range, not a % off the mean) + statusForState (only target_hit
                            moves status) + nextCheckAt (ALWAYS a next check — a thesis lives until
                            retired). No price-based thesis_broken, deliberately: research is not a
                            position, a cheaper name is not a wrong one
  coverage.remodel.js       PURE: when is a thesis worth the expensive tier. classifyEdge (contrarian /
                            variant / contained, vs the Street's range), parseCatalystDates (strict
                            YYYY-MM-DD only — fuzzy dates are prose for the analyst), remodelDecision.
                            Not a trigger: price, raw consensus drift, sector rotation (declined
                            2026-07-30 — Atlas's question, not Prometheus's)
  tilt.assess.js            PURE grading for the house view: relativeReturnPct / contributionBp
                            (active_bp × relative return — attribution, not opinion; null, never 0,
                            when unpriceable), gradeRow (a row MATURES when its own window closes),
                            diffStances (what moved between two views), reviewAnchorMs (off the
                            revision trail, NEVER updated_at — the monitor's own maturity write moves
                            that), reviewDecision (matured / macro catalyst / 30-day floor, 7-day
                            cooldown). The same cooldown → triggers → floor shape as remodelDecision,
                            deliberately NOT collapsed — the constants ARE the judgment
  paperFill.service.js  paperEquity.service.js
  monitor.claude.js         the monitor tier's three one-shot LLM reads — claudeJSON (a condition parse),
                            claudeText (a YES/NO verdict), claudeVision (a look at a chart) — as thin
                            readings of anthropic.provider.callAnthropicOnce, model ids from llmModels.
                            Was a SECOND Anthropic client with hardcoded ids and no usage hook
  monitor.orchestrator.js   evaluateTree: the recursive condition-tree evaluator (AND short-circuits on
                            the first failure, OR on the first success, children cheapest-first: time →
                            touch/structured/volume → indicator → news → chart) + isTimeBlocked (skip the
                            fetch when only the clock stands in the way) + the legacy flat-array shim
  monitorUtils.js           candleMs, parseYesNo, round, remainingForAccount, timeframe resolvers;
                            brokerCandleCtx + fetchCandles/buildVolumeCtx broker-candle routing
                            (primary instrument → broker candles shifted −basisOffset into authored space;
                            cross-assets/paper/no-broker → app feed)
  parsers/                  condition.parser.js, indicators.parser.js
middleware/
  auth.middleware.js        requireAuth (the session cookie → req.user, 401) · requireAdmin (role, 403)
  rateLimit.middleware.js   THREE limiters, in-memory (single-instance): apiLimiter (per IP, the
                            runaway backstop), authLimiter (per IP, credential stuffing), agentLimiter
                            (per SESSION — hashed cookie — the COST ceiling on every /stream).
                            agentLimiterCoverage.test walks the mounted streams
  securityHeaders.middleware.js  the hardening headers, written out rather than helmet (no CSP —
                            deliberately; see the file). HSTS in production only
  logger.middleware.js      `log` — one line per request: METHOD originalUrl
tests/
  unit/                     node:test unit tests — run by `npm test`
  test.*.js                 MANUAL harnesses (hit live broker/DB) — NOT run by npm test
scripts/                    ops one-offs — none run by `npm test`. Kinds: migrations
                            (migrate-*, one-shot idempotent collection/field moves — migrate-journal
                            moved monitor_state.timeline[] into the journal collection, mapping the
                            legacy reasons and dropping quiet-wake lines; run once after deploy), repairs
                            (repair-*, drop-ghost-*, dry-run-by-default data fixes), diagnostics
                            (check-*, verify-*, fmp-candle-parity — read-only), admin (set-admin-role,
                            create-admin-user — the latter rides userService.createUser), and dev
                            (free-port, clone-db-for-dev). tests/unit/scriptsImport.test.js loads
                            every one STATICALLY (they run on import) and fails if an import or a
                            named export it reaches has been moved — the only guard they have.
  check-archive-loads.mjs   `npm run check:archive` — imports every file under archive/ and fails
                            on the first that cannot resolve. The archive reaches ~40 symbols in the
                            LIVE tree and nothing lints or tests it, so a sweep that deletes an
                            export no live caller uses breaks it silently. Run it after any such
                            sweep. A script, not a test, so archive/ stays out of `npm test`.
  check-docs-drift.mjs      `npm run check:docs` — pulls every checkable claim out of the living docs
                            (backtick paths, module names, routes, emit tags, symbols, constants,
                            markdown links + anchors) and reports the ones that resolve to nothing,
                            or only to archive/. Per-doc counts first, worst first; `--json` for a
                            fix pass; a folder or file argument to narrow, including one in a sibling
                            repo. Mechanical only — it says which sentences to distrust, not whether
                            the prose is still true. Its verdict rules are pinned by
                            tests/unit/docsDrift.test.js (the cases a code review found it passing).
prompts/                    every prompt loaded at RUNTIME (6 desks + Argus's
                            profile/handoff + market brief + concepts). Hot-reloaded, lazily —
                            so a bad path is an ENOENT on a live turn, not an import error.
                            tests/unit/promptPaths.test.js guards both directions (a path that
                            resolves to nothing, AND a prompt nothing loads)
docs/                       docs/README.md is THE index. architecture/ (how it is built) ·
                            desks/ (each agent + its monitor) · design/ (proposed, not built) ·
                            trust-gaps-todo + live-verify-checklist (open work)
```

## Naming conventions

- **Feature modules:** `<feature>.routes.js` / `.controller.js` / `.service.js`. Routers apply
  `requireAuth` + `log` middleware. (Exception: `transcribe`… see APP_SPEC.)
- **Providers:** `<name>.provider.js`; export bare named functions. A few also export a
  `<name>Service` namespace object.
- **Broker adapters:** `<broker>.adapter.js`, a class extending `BrokerAdapter`; register in
  `broker.factory.js`.
- **Evaluators:** `<type>.evaluator.js`, export `evaluate<Type>` / `evaluate`.
- **Private helpers:** `_camelCase`. **Log tags:** `const LOG = '[feature]'`, used as `logger.x(LOG, …)`.
- **User id:** `req.user._id` (and `user._id`) is the custom string id equal to `idea.userId` —
  NOT the Mongo `_id`. Strip Mongo `_id` from responses via `stripId` (providers/mongodb.provider.js).
- **Consumers branch on capabilities/flags, never on broker name.** The predicates live in
  `services/venue.resolve.service.js` and none of them throws (an unregistered or absent broker
  answers false, because the callers are monitors iterating live documents):
  `isSelfExecuted(broker)` — does the USER execute here? the one question behind every "post a card
  instead of placing an order" branch, and the eleven sites that used to spell it `broker ===
  'manual'`. `isBindableVenue(broker)` — will anything here ever fill the trade (`trading` OR
  `selfExecuted`)? the setup Generate gate, which used to keep its own broker list.
  Two exceptions, both deliberate: the paper/live `mode` tag in tradeCapture, and the literals in
  `resolveMode` / `knownVenue` / `workspace.model` — those DEFINE the workspace vocabulary rather
  than dispatch on it, and routing them through a capability would make the vocabulary depend on
  the table it is supposed to be independent of. They carry a comment saying so.
- **Error handling:** ONE pipe. Every handler is wrapped in `makeHandle(LOG)` (`api/_shared/handle.util.js`),
  which logs a throw with its label + route and forwards it; `errorHandler` (same file, mounted last in
  `server.js`) is the only place a thrown error becomes `{ error }`. **What an error may tell the client
  (§9, 2026-09-16):** an error minted with `httpError(status, message)` (`services/httpError.util.js`,
  sets `expose`) answers with its status and sentence — a 404 "User not found", a 409 "Username already
  exists". Anything else is a 500 whose body is `'Internal server error'` in production and the message in
  development. A PROVIDER's status (`http.util.getJson` stamps `err.status`) is not ours and is never
  answered as such. No controller hand-rolls `catch → res.status(500)`; the one inner try/catch left
  (pendingAction's execute) unwinds a claimed row and RETHROWS. OAuth redirect handlers keep their own
  try/catch because they answer a browser navigation.
  - **Preferred:** `export const x = handle('x', async (req, res) => { … throw httpError(400, 'why') … })`
    — the service throws `httpError(404/409, …)` for what the user did, and a bare `Error` for what broke.
  - **Result-shaped (`{ok, reason}`) services:** never hand-roll the ladder — `sendReason()` from
    `api/_shared/reason.util.js` owns it. A reason that more than one kind can raise (`in_position`,
    `already_placed`, `not_found`…) lives in that file's SHARED table so two routes cannot answer the
    same refusal differently; reasons a single route owns (`missing_*`, manual-mode fills) are passed
    as `overrides`. A guard test fails the build if a controller branches on a shared reason itself.
  - **Plain CRUD on an owner-scoped kind:** don't write the handler at all — `makeEntityController()`
    gives you list/get/patch/delete. Every kind rides it (call · setup · idea/portfolio_item ·
    coverage · scan); only the kind's own moves (Generate, act, place orders, initiate, retire) stay
    hand-written. Portfolio has no entity CRUD at all — a portfolio is the SET of ideas sharing a
    `portfolioId`, not a document — so its controller is stream + reviews + rebalance only.
  - **Services answer in the crud's shape.** `{ ok:true, doc }` / `{ ok:false, reason }`, never re-keyed
    under the kind's own name (`{ok, setup}`, `{ok, coverage}`), so a caller never has to remember
    which function renamed the document.

## Where to add things

| Task | Touch |
|------|-------|
| New HTTP endpoint | `<feature>.routes.js` + handler in controller + logic in service |
| New SSE stream | `startSseStream()` from `api/_shared/sse.util.js` |
| New agent tool | schema + handler; put shared ones in `agentUtils` (`COMMON_TOOL_HANDLERS`, `makeToolHandler`) |
| New broker | `providers/<b>.provider.js` + `adapters/<b>.adapter.js` (extend `BrokerAdapter`) + one line in `broker.factory.js`; add aliases in `brokerSymbol.service.js` only if it renames instruments. `capabilities()` is an exhaustive literal, not a spread of the base — state EVERY flag, including `selfExecuted`, or it reads `undefined`. A broker-less venue (the user places the orders) sets `selfExecuted:true` and needs no other change: the eleven card-instead-of-order branches already ask the capability. `tests/unit/selfExecutedVenue.test.js` pins the inventory and fails when a second one arrives |
| New aliased index future (broker basis) | add to `brokerSymbol.service.ALIASES` + `brokerPrice.service` REAL_TICKER/CASH_INDEX maps; offset auto-measured at fork, candle-shifted in monitor |
| New evaluator / leaf type | `evaluators/<type>.evaluator.js` + wire into `monitor.orchestrator._evalOne` + `condition.parser` |
| New pure utility | add a `tests/unit/<name>.test.js` (that's the "write tests after a feature" rule in practice) |
| New background loop | `startLoop('name', svc)` in `server.js` — and the service MUST export both `start` and `stop`. `startLoop` refuses one without a `stop()` with a log line and returns false, so a missing `stop` means the loop silently never runs (this happened to `execution.reconciler`). `tests/unit/loopContract.test.js` is the guard |
| New env var | one getter in `services/config.js`, reading through `_raw` / `_str` / `_num` / `_bool` — the known-key set is derived from the readers (`knownKeys()`), and `config.test` fails on a getter that reads `process.env` directly |
| New Axl tool | APPEND to `TOOLS` in `axl.agent.service.js` (never insert — the snapshot compares by index and the prompt cache keys off the array prefix) + append the built entry to the `axl` array in `tests/fixtures/agentTools.snapshot.json` in the same commit |
| New agent tool that is a FACT about the venue/instrument | ride it on `get_quote` (`makeQuoteHandler`) as well as giving it a tool — a desk cannot then be unaware of it |
| New notification card | build it through `postCard` (notifyCard.js), give it `actions` only if it's actionable, add a bubble + a `msg.type` branch in the FE `ChatWindow.jsx`; a recurring fan-out dedupes via `listCardRecipientsSince` |
| New admin-only desk (or route) | `requireAdmin` on the router (router-wide when the whole desk is admin's), `adminOnly: true` on its `DESKS` entry + any Floor/Radar surface (frontend `agentMeta.jsx`, `FloorLists.jsx`), its bot id in `ADMIN_BOT_IDS` on BOTH sides if it has a feed, its notifier narrowed to `listAdminUserIds` + `visibility: 'admin'`, the desk in Axl's `ADMIN_DESKS` + a line in `buildRoleSection`, and a row in `docs/desks/roles-and-sourcing.md`. `adminGate.test.js` pins the router |
| Desk-to-desk hand-off on a new agent | four lines, all in routing.util: `+ buildRouteRule('<key>')` after its spine (before the closing LANGUAGE/VENUE/BREVITY rules), `...route.captures` in `buildTagCaptures`, `...route.result()` in the return, `...routeFields(result, req.user.role)` in the controller's done payload. Client: `useRouteOffer()` + `<RouteOffer>` in the panel, `onRoute={handleRoute}` from MainPage. Add a row to `tests/unit/routing.test.js` |
| New emit tag (any agent) | add the name to `ALL_EMIT_TAGS` (llmStream.util.js) BEFORE anything else — unlisted tags leak into the chat and are never captured — then `buildTagCaptures({ tag })` in the agent + `stripEmitTags` on the return value |
| Follow-up chips on another desk | `makeSuggestionCapture()` (suggestions.service.js) → wire `suggest:` into that agent's `buildTagCaptures` + add `'suggest'` to its `stripEmitTags` list + return `suggestions`. The plumbing is done; write the desk's OWN "what is worth asking next" section in its prompt |
| New off-hours-queueable action | ask `executionGate.deferIfClosed` before the order, and register the origin's `execute` + `cancel` in `originRegistry.ORIGINS` — the gate REFUSES to queue an unregistered origin. Cancel must reach back into the deciding desk |
| New Axl `<edit>` kind | one row in `EDIT_KIND_DESKS` (axl.agent.service.js) + `EDIT_KINDS` (axl.controller.js) + a `case` in the FE `openForEdit` (MainPage.jsx) pointing at that kind's EXISTING pencil handler + the tag in the prompt. The prompt-vs-gate test fails if the prompt teaches a kind the gate drops |
| New kind that can be REOPENED (card / pencil / Axl hand-off) | give it `GET /:id` (`makeEntityController.get` over `crud.getOwnedStripped`) + a getter on its FE service + one line in `GETTERS` (frontend `services/entityResolve.js`). Every doorway then READS it by id through the full pipe. NEVER resolve an entity out of a client list and never fall back to a stale row: a card can arrive before its list has loaded, and the empty list is indistinguishable from a failed read — that is how a portfolio review came to be authored against no holdings, invent its item ids, and fail on Accept with `not_found` |

## Deployment shape

ONE process, and ENFORCED since 2026-08-18. `server.js` starts thirteen background loops through
`startLoop` (`services/lifecycle.service.js`), behind a Mongo lease
(`services/instanceLock.service.js`): the process that wins it starts them, a second process starts
none and says so while still serving HTTP, and losing the lease mid-flight stands them back down.
It buys SAFETY, NOT SCALE — a handful of module-level `Map`s are load-bearing rather than caches,
the exit-order lock in `execution.reconciler` and the WebSocket registry in `chatWs` most of all,
and the latter is per-process request-path state, so a user on the follower still misses the cards
the leader emits. Before changing an instance count read
[docs/architecture/single-instance.md](docs/architecture/single-instance.md), which lists what is
already claimed through Mongo, what is not, and the order to fix it in. A green lease is not
permission.

**Shutdown is ordered and bounded.** SIGTERM/SIGINT (and any uncaught exception) run one path:
mark draining so readiness answers 503 → `stopLoops()` → `server.close()` + `closeIdleConnections()`
→ force the SSE sockets that never close on their own → `closeRenderer()` → `closeDb()`. A `SHUTDOWN_GRACE_MS`
backstop force-exits if any step hangs. `createPollLoop.stop()` awaits the tick already in flight,
so nothing is cut mid-write.

**Probes.** `GET /api/health` is liveness (200 even while draining — a 503 there gets the container
restarted mid-shutdown); `GET /api/health/ready` is readiness (503 while draining or if Mongo is
unreachable). Both unauthenticated and mounted ahead of the rate limiters.

## Testing

- `npm test` → `node --test "tests/unit/*.test.js"` (Node's built-in runner, zero deps). About a
  minute, and OFFLINE: config.js does not load .env under the runner, and since 2026-09-16 no
  provider loads it either. A test that needs a value sets it itself. (It took ten minutes and made
  live LLM and provider calls until four providers' own dotenv.config() calls were removed — §7.)
- Only files under `tests/unit/` matching `*.test.js` run. The `tests/*.js` manual harnesses are
  hand-run probes that connect to live broker/Mongo — they are deliberately excluded.
- Favor unit tests on **pure** functions (utils, parsers, builders). Modules that hit Mongo/providers
  aren't unit-tested here; verify those via the import-smoke pattern or a running stack.
- Some tests are repo-wide CHECKS, not unit tests — they exist because a one-off sweep was found
  to be a memory, not a guard: `jsdocAttachment` (a JSDoc block stranded above the wrong function),
  `agentToolComments` (a tool comment naming a tool the desk does not declare), and
  `npm run check:archive` (the archive still loads after an export is deleted). Add to this list
  rather than re-running the grep.
