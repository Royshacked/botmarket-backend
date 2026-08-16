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

## Directory map

```
server.js                 app wiring, route mounts, background-service boot
api/
  trade-ideas/            idea CRUD + order placement /api/trade-ideas/*
    tradeIdeas.service.js     save/get/update/delete, broker forking; getTicker-resolved
                              brokerSymbol + fork-time basisOffset per child; venue gate
                              (no broker + no paper → reject, reason:'no_venue')
    ideaExecution.service.js  placeOrdersForIdea / placeRestingEntryForIdea / triggerEntryNow ("Buy now")
    exitOrders.service.js     in-position exit (re)arming (basisReferenceQuote now a neutralised no-op)
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
    coverage.service.js       `coverage` collection = living per-name thesis (one doc per user+symbol):
                              variant-perception + our PT vs Street (the gap) + monitorable kill-criteria +
                              append-only revisions[]. normalizeCoverage + CRUD (initiate/update-w-revision/
                              retire). Own collection — NOT the execution-tier entities (P1 of the Analyst)
  broker/                 broker connections/orders/positions  /api/broker/*
    adapters/
      broker.interface.js     BrokerAdapter base class — THE contract every broker fulfils
                              (incl. getCandles + capabilities().ohlcv, resolveSymbol "getTicker", getSpot)
      ctrader.adapter.js      + ctrader.execution.js (ProtoOA→BrokerExecution translator).
                              getCandles now serves trendbars (ohlcv:true); resolveSymbol via symbol list
      paper.adapter.js        virtual venue (resolveSymbol = identity; ohlcv:false → app feed)
      ibkr.adapter.js         data-only, in progress — see APP_SPEC / do not extend casually
      normalize.js
    broker.factory.js         getBrokerAdapter(type); SUPPORTED_BROKERS registry
    broker.service.js         broker-agnostic entry point used everywhere (getCandles/resolveSymbol/getSpot)
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
                          never reconnected and its unread badge silently froze); sendBotMessage funnel,
                          BOT_IDS = axl·portfolio·scanner·kairos·mentor·analyst·strategy (one notify
                          bot per agent) + botForKind (kind → sender) and RETIRED_BOT_IDS (`idea`:
                          feed gone, thread hidden, its orphan cards fall back to Axl).
                          listCardRecipientsSince(type, since) = the shared dedupe read for any
                          fan-out notifier ("who already got today's?"), conversation→user join
  market/ calendar/ user/ authentication/ transcribe/
  _shared/                cross-controller helpers:
      sse.util.js             startSseStream() — SSE headers + heartbeat + abort wiring
      parse.util.js           parseChatMessages / parseIdeaAccounts
      chatState.util.js       makeGetChatState / makeDeleteChatState factories
      reason.util.js          THE reason→HTTP map (in_position=409, forbidden=403 …) + sendReason();
                              route-owned reasons are passed in as `overrides`, never re-mapped locally
      entityController.util.js  makeEntityController() — list/get/patch/delete for any owner-scoped
                              kind (the HTTP twin of services/entity/entityCrud); `envelope` carries
                              the legacy `{idea}/{ideas}` body shape, everything else answers bare
services/
  agents/                 the 7 LLM desks (analyst · axl · kairos · mentor · portfolio · scanner ·
                          strategy). KAIROS IS ASLEEP — Mentor took the trading over; the module
                          stays because calls in flight still run and still reopen for edit, but
                          nothing new is authored there (docs/desks/trade-pipeline.md).
                          Six of the seven append LANGUAGE_RULE + VENUE_RULE to their base prompt;
                          `strategy` (and marketBrief) do not — a broadcast has no user whose venue
                          could be read. Moved out of the flat services/ root 2026-08-07 — they are a
                          distinct KIND of module (a desk, not a service), and they were the
                          largest single group making an 80-file directory hard to read. Their
                          prompts live in `prompts/` (`join(__dirname, '../../prompts/x.md')`)
  tools/                  the 12 agent-facing tool modules (*.tools.js) — the handlers + LLM-ready
                          formatters an agent is wired with. Schemas stay in agentTools.registry
  portfolio.agent.service.js  scanner.agent.service.js
                          Atlas tools: screen_candidates + get_macro_snapshot + enriched get_fundamentals
                          (FMP Starter); review-state block renders benchmark-relative perf + regime delta
                          (_formatReviewDelta) from the fingerprint, and in REVIEW ONLY the holding's
                          `[itemId]` before each ticker — a review's output names which holding each
                          action acts on, and the ids used to appear only in the CLIENT-supplied EDIT
                          MODE block, so an empty list left Atlas inventing them and every accepted
                          change came back not_found
                          Argus (scanner) systematic-discovery funnel: Phase-2 grounded sources
                          screen_candidates + get_market_movers + get_sector_snapshot + get_analyst_actions
                          (no memory-recall); Phase-3 get_candles/get_indicators baseline + get_chart/
                          get_orderblocks/get_false_breaks vision (KLineCharts, onChart:null = model-only)
  portfolioState.service.js listPortfolioItems = THE query for a book's rows and the one place
                            ownership is enforced on them; every caller comes through it, with its
                            own projection (computePortfolioState takes a narrow slice, a client
                            opening the book takes whole documents). computePortfolioState = actual
                            weights, drift, unrealized P&L, thesis age, earnings — 5-min TTL snapshot
                            so review follow-ups reuse one prompt-cacheable block. listPortfolios =
                            the cheap book enumeration (also the watchlist's)
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
  suggestions.service.js  follow-up CHIPS — the shared pipe for "what might I ask next". Owns the
                          `<suggest>` tag, the capture, the cleaning and the cap of 3; one line
                          (makeSuggestionCapture) wires any desk in and the client renders one
                          thing. Costs no extra latency: they ride out inside the reply already
                          streaming, not a second model call. WHAT to suggest is NOT here — that is
                          judgment and lives in each desk's prompt (a shared generator would be the
                          cross-desk unifier the house rule forbids). Axl only, so far, and never on
                          a routing turn (see APP_SPEC §2)
  modelRouter.service.js  resolveModel(); REASONING_EFFORT enum
  conditionTree.service.js  resolve/collect/normalize condition trees
  orderPlan.service.js  protectionPlan.service.js
  price.service.js  timeframe.service.js  brokerSymbol.service.js
  market.service.js       THE market-hours engine: one class-aware gate (isAssetOpen), one status
                          read (getMarketStatus → open/nextOpenMs/session/phase), sessionPhase +
                          sessionStartMs. Four calendars — crypto 24/7 · forex 24/5 · CME index
                          futures near-24/5 · US equity RTH. sessionFor is the ONE classifier
                          (explicit asset_class first, symbol heuristic second). NO holidays or
                          half-days, and no non-US exchange
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
  format.util.js  http.util.js  ttlCache.util.js  priceStats.util.js  cycleAnalysis.service.js
  logger.service.js  tokenUsage.service.js
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
  chartImgCache.service.js  cachedChartImage(symbol,timeframe,studies) — 60s shared chart-PNG cache.
                            FALLBACK-FIRST: own KLineCharts render first (OWN_CHART_RENDER, default on),
                            chart-img (TradingView) on any error/timeout. base64-PNG contract unchanged.
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
  watchlist.service.js      listWatchedItems — "what am I watching?" across ALL kinds in ONE read
                            (calls · setups · books · coverage · scans), SCOPED to the workspace the
                            user is standing in: WORKSPACE_SCOPED_KINDS (call · setup · portfolio)
                            bind to an account and belong to one book; scans + coverage are research,
                            bind to none, and are shared across all three. COMPOSES the owning services
                            rather than querying Mongo, and settles them independently: one desk's
                            read failing is REPORTED in `unavailable`, never reported as zero.
                            Returns structured rows only — see entity/toWatchRow.js for the projectors
  userData.tools.js         the ADAPTER over it (+ performance / upcomingEvents): rows → the compact
                            text a model reads. Every watch line leads with `[kind:id]`, and that id
                            is load-bearing: it is the handle Axl quotes back in `<edit>` to reopen
                            that exact item. Formatting is judgment, the read is a pipe, and the pipe
                            is shared — a future card or route renders the same fields
  eventRisk.service.js      buildEventRisk({asset,assetClass}) — scheduled catalysts FROZEN onto a Kairos
                            call at build: earnings (Finnhub, equities) + Fed/macro (FRED), low-impact
                            dropped, 10d horizon. Never throws. Hermes reads it to hold off pre-event entry
  tradeCapture.service.js   append-only `trades` history (captureOpen / captureOpenBare / captureClose)
  manualNotify.service.js   broker-less entry/exit FillCards → social chat (embedded price/qty confirm)
  tradeNotify.service.js    notify+route cards → social chat: entry_confirm (paper/live idea + Kairos
                            ready call) + call_expiry (Kairos thesis edit/expired) + queue_ready (the
                            market-open nudge, from Axl) + setup_invalidation / setup_manage (Talos,
                            from Mentor). Pure builders + thin sendBotMessage wrappers;
                            card is the alert, existing UI is the destination.
                            entry_confirm carries a `note` (passed_earlier | off_hours | null) for scheduled entries
                            A card WITHOUT `actions` is a statement, not a request (ran_away /
                            invalidated_fyi / let_run) — no buttons, no pending lifecycle
  positionManage.service.js THE HANDS of in-position management, shared by every desk: resolve the
                            broker links, fan the accepted action across ALL accounts (amend stop/TP,
                            partial/full close), write position_state once. Kind-BLIND — the caller
                            passes `entity` (owns position_state) + `holder` (owns brokerOrders); for a
                            setup they are the same doc, for a call the holder is its materialized idea.
                            Execution contract: move_stop{new_stop} take_partial{size_pct}
                            let_run{new_tp|cancel_tp} exit_now{}. Each desk translates its own dialect in
  talos.handoff.service.js  Mentor's half: POST /api/setups/:id/action → accept (move_stop|take_partial|
                            exit_now) or dismiss. Translates Talos's {stop,why}/{fraction} into the
                            contract above. `add_leg` → `confirm_order` (it is a parked ORDER, not a
                            manage action — accepting here would place the size twice)
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
  anthropic.provider.js         LLM chat/streaming (OpenAI SDK is used directly, transcribe only)
  yahoofinance / massive / finnhub / fmp / fred / sec / gnews / binance
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
  ibkr.provider.js (retired) / ibkr.gateway.provider.js
  mongodb.provider.js       getDb(), stripId/stripIds
monitoring/
  minos.monitor.service.js  the `idea` condition-tree loop. Its POLL is not started (see server.js)
                            — but the module is NOT dead, and deleting it breaks the arm path:
                            tradeIdeas.service calls resetIdea (6 sites — the arm/re-arm floor) and
                            preflightEntry (the arm-time already-satisfied check behind the Buy now
                            / Edit / Reset prompt). A helper with a dormant loop, not a tombstone
  monitor.orchestrator.js   evaluateTree / evaluateConditions → _evalOne (opts: stateLevel, requireHeld)
  evaluators/               touch · structured · indicator · time · volume · news · chart
  execution.reconciler.js   broker-authoritative fill/close → idea status
  invalidation.monitor.js   entry-range watcher (advisory, never executes)
  marketOpen.monitor.js     the market-open sweep — the ONE drain for everything parked while a
                            venue was shut. KIND-BLIND by design: three paths park orders at
                            `awaiting_market` (_attachImmediatePlan for the ticket AND a portfolio
                            add, triggerEntryNow, Talos on a setup), so a sweep that understands one
                            kind is the bug. TWO SOURCES since 2026-08-07: entities at
                            awaiting_market (claimIf → awaiting_confirm) AND queued actions
                            (pending_actions, transition from QUEUED — both guards are what make it
                            exactly-once). Then ONE `queue_ready` card per USER, from Axl, pointing
                            at the queued list — replacing the per-desk per-kind fan-out, which
                            posted two cards in the same second for one open. Places nothing.
                            It is its OWN loop for a reason: it used to ride inside minos.monitor,
                            so switching that loop off stranded every deferred order in the app.
                            A sweep tied to one desk's lifecycle dies with that desk
  hermes.monitor.service.js Hermes — the Kairos-call readiness loop (own tick, `kairos_calls`). THREE-TIER
                            out-of-zone cascade (all cheapest-first): (1) arithmetic zone gate; (1.5) proximity
                            polling (_proximityGapMin: poll faster the nearer price is to a zone) + a momentum-
                            pulse filter (_shouldPulse: a material, throttled move AWAY from every zone —
                            pulse_anchor_px/last_pulse_at) → (2) one full visual read that can RE-MAP via
                            edit/edit_proposal (closes the "blind outside mapped zones" gap). In-zone/expiry →
                            the LLM assessment → verdict. Runs under hermesModel + hermesReasoning prefs;
                            card hook (_defaultOnCard) posts entry_confirm / call_expiry via tradeNotify
                            (enter→ready, edit→expiring, let_expire→expired). At a STOP-out (_isStopOut, not
                            tp/manual) _maybeOfferReentry runs a one-shot thesis check → intact fires a
                            call_reentry card ([Re-enter]=reviveCall → waiting / [Close]=declineReentry)
  hermes.assess.js          the four-axis assessment (readiness + position mgmt) + the momentum-pulse and
                            re-entry reads. Fact-sources every axis: live chart+candles, company news
                            (newsService 1h cache), frozen event_risk, a LIVE broad-market read gated by the
                            call's market_sensitivity (getQuotes SPY/QQQ/VIX + drivers), and a SESSION-OF-DAY
                            phase (market.service sessionPhase, asset-class-aware; crypto/FX=24h) weighted as a
                            lens. A tentative ENTER on a market-sensitive call gets a web_search browse-confirm
                            2nd pass (downgrades enter→wait, fail-open)
  talos.monitor.service.js  Talos — the Mentor-setup loop (own tick, kind:'setup'). TWO BRAINS, ONE LOOP:
                            pre-entry readiness, past-entry management (_managePosition). Pre-entry
                            cascade, cheapest-first: (1) the arithmetic SCENARIO gate — which PREMISE
                            price reached, not merely which zone; then out-of-zone, (1.5) the validity
                            gate (close, not touch — it can only KILL: broke/drifting) and the
                            MOMENTUM PULSE (shouldPulse: a material, throttled move away from every
                            live zone — monitor_state.pulse_anchor_px/last_pulse_at, measured in
                            nearestZoneWidth, throttled by the setup's OWN cadence.max); (3) the full
                            read. A pulse may only `edit` (re-map) or wait — never enter, because
                            outside every zone nothing is armed: no zone id, no leg size, no fill
                            anchor. Every real look re-anchors. Talos NEVER executes — every verdict
                            is a card the user confirms
  talos.assess.js           the setup read (readiness + in-position). Conditions are PROSE with a
                            weight/mode, graded one entry per declared id — the model goes and checks
                            them with the shared assessTools kit rather than being pre-fetched at.
                            TIMEFRAME IS THE MODEL'S CHOICE: it returns `next_timeframe` (clamped to
                            the setup's ladder, stored on monitor_state.timeframe) and the next read
                            OPENS there — openingRung. There is no next_check_min: the rung IS the
                            pace (_nextCheckAt derives the gap from it, then clamps to cadence), so
                            the two can never contradict each other. Ladder floors at 5min (1min is
                            402 off-plan at FMP)
  positionMonitor.js  portfolio.monitor.js   (portfolio.monitor: due-review NOTIFY-only; runs the non-LLM
                            pre-check computeReviewSignals → enriches the bubble + payload with triggers[])
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
                            tiltNotify.notifyTiltReviewDue posts a `tilt_review` card to every user,
                            and the confirm runs the review at PYTHIA'S DESK — a re-author supersedes
                            the view everyone reads, so it takes a confirm. Both clocks anchor on
                            reviewAnchorMs (last publish/reauthor off the revision trail), NEVER on
                            updated_at — the loop's own maturity write moves that
  paperFill.service.js  paperEquity.service.js
  exitOrders.util.js        buildExitOrder (applies +basisOffset → broker price space) / exitOrderRecord / closeSide / orderSymbol
  monitorUtils.js           candleMs, parseYesNo, round, remainingForAccount, timeframe resolvers;
                            brokerCandleCtx + fetchCandles/buildVolumeCtx broker-candle routing
                            (primary instrument → broker candles shifted −basisOffset into authored space;
                            cross-assets/paper/no-broker → app feed)
  parsers/                  condition.parser.js, indicators.parser.js
tests/
  unit/                     node:test unit tests — run by `npm test`
  test.*.js                 MANUAL harnesses (hit live broker/DB) — NOT run by npm test
scripts/                    free-port, migrations, seeds
prompts/                    every prompt loaded at RUNTIME (7 desks + Kairos's 3 modes + Argus's
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
- **Consumers branch on capabilities/flags, never on broker name** (only exception: the paper/live
  `mode` tag in tradeCapture).
- **Error handling:** the global handler in `server.js` formats every error as
  `res.status(err.status || 500).json({ error: err.message })`. Two controller styles exist and are
  both fine because they yield the *same* `{ error }` shape:
  - **Preferred (new controllers):** let the service throw a typed error (`Object.assign(new Error(msg), { status })`)
    and `catch (err) { next(err) }` — no per-handler status/message duplication (see `user`/`chat`/`authentication`).
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
| New broker | `providers/<b>.provider.js` + `adapters/<b>.adapter.js` (extend `BrokerAdapter`) + one line in `broker.factory.js`; add aliases in `brokerSymbol.service.js` only if it renames instruments |
| New aliased index future (broker basis) | add to `brokerSymbol.service.ALIASES` + `brokerPrice.service` REAL_TICKER/CASH_INDEX maps; offset auto-measured at fork, candle-shifted in monitor |
| New evaluator / leaf type | `evaluators/<type>.evaluator.js` + wire into `monitor.orchestrator._evalOne` + `condition.parser` |
| New pure utility | add a `tests/unit/<name>.test.js` (that's the "write tests after a feature" rule in practice) |
| New Axl tool | APPEND to `TOOLS` in `axl.agent.service.js` (never insert — the snapshot compares by index and the prompt cache keys off the array prefix) + append the built entry to the `axl` array in `tests/fixtures/agentTools.snapshot.json` in the same commit |
| New agent tool that is a FACT about the venue/instrument | ride it on `get_quote` (`makeQuoteHandler`) as well as giving it a tool — a desk cannot then be unaware of it |
| New notification card | build it through `postCard` (notifyCard.js), give it `actions` only if it's actionable, add a bubble + a `msg.type` branch in the FE `ChatWindow.jsx`; a recurring fan-out dedupes via `listCardRecipientsSince` |
| New emit tag (any agent) | add the name to `ALL_EMIT_TAGS` (llmStream.util.js) BEFORE anything else — unlisted tags leak into the chat and are never captured — then `buildTagCaptures({ tag })` in the agent + `stripEmitTags` on the return value |
| Follow-up chips on another desk | `makeSuggestionCapture()` (suggestions.service.js) → wire `suggest:` into that agent's `buildTagCaptures` + add `'suggest'` to its `stripEmitTags` list + return `suggestions`. The plumbing is done; write the desk's OWN "what is worth asking next" section in its prompt |
| New off-hours-queueable action | ask `executionGate.deferIfClosed` before the order, and register the origin's `execute` + `cancel` in `originRegistry.ORIGINS` — the gate REFUSES to queue an unregistered origin. Cancel must reach back into the deciding desk |
| New Axl `<edit>` kind | one row in `EDIT_KIND_DESKS` (axl.agent.service.js) + `EDIT_KINDS` (axl.controller.js) + a `case` in the FE `openForEdit` (MainPage.jsx) pointing at that kind's EXISTING pencil handler + the tag in the prompt. The prompt-vs-gate test fails if the prompt teaches a kind the gate drops |
| New kind that can be REOPENED (card / pencil / Axl hand-off) | give it `GET /:id` (`makeEntityController.get` over `crud.getOwnedStripped`) + a getter on its FE service + one line in `GETTERS` (frontend `services/entityResolve.js`). Every doorway then READS it by id through the full pipe. NEVER resolve an entity out of a client list and never fall back to a stale row: a card can arrive before its list has loaded, and the empty list is indistinguishable from a failed read — that is how a portfolio review came to be authored against no holdings, invent its item ids, and fail on Accept with `not_found` |

## Deployment shape

ONE process. `server.js` starts eleven background loops unconditionally and there is no leader
election, and a handful of module-level `Map`s are load-bearing rather than caches — the exit-order
lock in `execution.reconciler` and the WebSocket registry in `chatWs` most of all. A second instance
corrupts the first and breaks the second, mostly in silence. Before changing an instance count read
[docs/architecture/single-instance.md](docs/architecture/single-instance.md), which lists what is
already claimed through Mongo, what is not, and the order to fix it in.

## Testing

- `npm test` → `node --test "tests/unit/*.test.js"` (Node's built-in runner, zero deps).
- Only files under `tests/unit/` matching `*.test.js` run. The `tests/*.js` manual harnesses are
  hand-run probes that connect to live broker/Mongo — they are deliberately excluded.
- Favor unit tests on **pure** functions (utils, parsers, builders). Modules that hit Mongo/providers
  aren't unit-tested here; verify those via the import-smoke pattern or a running stack.
