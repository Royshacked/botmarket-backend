# Axl, one voice — a company question answered by Axl, from our work and the web

Decided with Roy 2026-11-21. Extends [modes-and-builders.md](modes-and-builders.md): the BUILDERS keep their modes
exactly as they are; what changes is how a QUESTION about a company is answered in General mode.

**Why.** A user who does not know how the agents are organised cannot follow a chat where the floor and the voice move
between roles (Roy: "a user who doesn't know the way agents exist and operate here will have difficulty to understand the
conversation with Axl"). Since 2026-11-20 the specialists answered "as written, under their role" (M2/M16): three voices in
one chat, and "how is NVDA for investment" became the analyst's reply plus Axl's one line. Axl should act like any LLM chat —
one voice — that happens to have something a regular LLM does not: our coverage, our technical analysis and our event maps.

## 1. Decisions (Roy, 2026-11-21)

| | Decision |
|---|---|
| V1 | **The user always speaks to Axl, in General mode.** No jumping from role to role mid-chat. Axl answers in his own voice. |
| V2 | **Axl's sources:** browsing, the news, general knowledge — AND, for a company, the house's work: the analyst's **coverage**, the technical analyst's **profile**, and the **events** the event analyst mapped that reach the company. |
| V3 | **Valid work is used; missing or invalid work is built or revised in the background — automatically.** A new coverage is the house's, shared with every user: the next person asking draws on it, nothing is built again. |
| V4 | **Axl picks his sources by the question.** "What's wrong with NVDA?" / "why is it down?" → the news and the web. "Is NVDA a good investment now?" → the broad context: news, web, coverage, technicals, events. |
| V5 | **The event analyst works the same way**: his maps are Axl's material, and a company question checks whether a mapped event reaches it. |
| V6 | **Modes stay as they are** — Trader / Portfolio manager / Analyst build, with their cards, the building line and the summary. |

## 2. What Axl does with a company question

1. **The news-type question** (what happened, why it moved): `get_news`, `web_search` — as today. No house tool.
2. **The view-type question** (buy? long term? risks? valuation? how it trades?): one tool, `get_company_view(symbol)`, then the
   news and the web for what is new. The tool returns three parts, each with a verdict code decided — never the model:

| Part | Source | Valid when | Not valid → |
|---|---|---|---|
| Coverage | `coverage` (api/analyst/coverage.service.js) | status `active`; a standing target the latest revision did not withdraw; no re-model due (see §3) | **none**: initiate in the background · **stale / withdrawn**: re-model in the background |
| Technical profile | `proteus_profiles` (behaviourProfile.service.js) | `computed_at` within 7 days and the current `PROFILE_VERSION` (the existing rule) | computed **inline** — `profileFor`, code only, seconds; nothing in the background |
| Events | `echo_events` — house events scored/checked/watching whose `scores.links` hold the ticker, and the user's own | the event's own status (expired ones are left out) | nothing to build: no event reaching it is an answer ("no mapped event reaches it") |

3. **Axl answers in one voice, with attribution kept**: "our analyst rates it buy, target $X (revised Nov 20) because…",
   "our technical read: it respects the 50-day, ATR ~3%…", "an event we mapped — the TSMC capacity cut — reaches it as a
   customer…", and separately "the Street / the news / the web says…". The house view and a headline must never blur.
4. **While a coverage builds** (a new name takes ~5–9 min): Axl answers now from the technicals, events, news and web, says
   the analyst's coverage is being built, and when it lands **one line from Axl** in that session: "The analyst's coverage on
   X is ready — buy, target $Y. Ask me about it." A re-model in flight is said the same way ("the thesis is being re-modelled;
   until then, the last view was…").

## 3. Validity — the coverage, precisely

From the monitor's own rules (monitoring/coverage.remodel.js), so the chat and the monitor agree on "due":

- **none** — no document, or status `retired`.
- **withdrawn** — the latest revision is a `remodel_pass` newer than `price_target.set_at` (NVDA today: "I withdraw the prior
  target", headline still strong buy $332.50 from Sep 3). Axl says the analyst could not stand behind a target on <date>, and
  why — never the old target as standing.
- **stale** — a re-model is due by the monitor's rule: a dated catalyst (earnings) passed since `monitor.last_remodel_at`, the
  verdict in `REVISE_STATES`, or 90 days since the last model.
- **valid** — otherwise.

**No loop on a pass.** A `remodel_pass` inside the monitor's cooldown (3 days) is not re-run on a question: the pass is the
answer until then. (NVDA has passed twice on a price-data mismatch — $173.73 one day, $134.08 another; re-running it on every
question would cost a full re-model each time and pass again.)

## 4. The background builds — existing pipes, one claim each

- **Initiate** — `researchQueueService.enqueue({ symbol, source: 'axl', requestedBy, context: { sessionId } })` then
  `researchRunService.startRun` — the path `mentorReads.requestRead` already uses. Dedupe is the queue's: a symbol `queued` /
  `in_research` is not enqueued twice; `already_covered` is skipped. Saves directly (no Confirm — it is the house's).
- **Re-model** — `coverageService.claimRemodel` (the monitor's compare-and-swap) THEN `refreshCoverage`. The claim is what
  stops two re-models of one name (two users asking, or the monitor at the same tick); a lost claim = one is already running.
- **The "ready" line** — the run's completion posts to the requesting session (`context.sessionId`), through the session
  store, as Axl. Only the session that asked; other users simply find it valid next time.

Cost: one full analyst run per NEW name, once, for everyone; a re-model only when the monitor's rule says due.

## 5. The specialists become material

- `ask_specialist` stays as the pipe (services/desks/subagent.js), but the specialist's reply is **returned to Axl, not shown**
  as its own row: it is kept hidden in the specialist's segment (follow-ups keep their thread), and Axl writes the answer.
- The analyst's ANSWER mode (prompts/analyst_mode_answer.md, 2026-11-21) is the deep read Axl asks for when the stored thesis
  does not cover the question (a margin trend, a valuation argument) — material, not a reply.
- The event analyst: a NEW event the user names ("GTA 6 is out — who benefits?") is still his map (`map_event`, 2–3 min);
  Axl gets the result and answers. Stored maps reaching a company come through `get_company_view`.
- The technical analyst: the stored profile answers most of it; a chart-specific question can still ask him — as material.

## 6. The user's own trades and books — the monitors' view (Roy, 2026-11-21)

"How is my NVDA trade doing?", "why hasn't my AMD setup entered?", "is my book OK?", "what's waiting for me?" — Axl answers
these in the same one voice, with the MONITORS' judgment, not only the list.

What Axl has today (unchanged): `get_trading_context` (broker positions, balances, live P&L), `get_watched_items` (setups,
books and queued actions with status and levels, workspace-scoped), `get_performance` (closed trades).

What he lacks — the monitors' read — is already stored, read-only, no model call needed:

| Monitor | What it keeps | Where |
|---|---|---|
| Talos (setups) | one row per read: what it looked at, the verdict, its own sentence (`note`), the conditions checked, what it is **waiting for**, the next check, warnings, a management proposal; plus the code-written events (fill, close, invalidation, entry) | `journal` (services/journal.service.js `listJournal(entityId)`, newest first — monitoring/monitorJournal.js row shape) |
| Talos (live order state) | awaiting your confirm / awaiting the market / awaiting a manual fill, the pending order plan | the setup document (`orderState`, `pendingOrder`, `position_state`) |
| Themis + the portfolio manager (books) | last checked, the triggers it flagged, the review cadence and when the next is due, a review waiting on the user | the book document (`themis.*`, `nextReviewAt`, `notifiedAt`, `reviewCadence`) |

- **One new read tool, `get_item_status(id)`** — for ONE setup or book (the id `get_watched_items` already prints): the latest
  few monitor rows in plain words, the live order state, and for a book the flagged triggers and the review state. Axl says it
  as the monitor's, with the time: "the monitor's last read, at the 14:00 close: still waiting for a close above 182; the
  thesis holds".
- **No fresh read on demand** (Roy, 2026-11-21: "check my trade — give the last read"): the last read is at most one candle
  old, and a forced read is a paid model call.
- Workspace scoping stays as `get_watched_items` has it.
- To find in step 7: where the portfolio manager's last REVIEW outcome is kept (Themis writes no journal rows), so "is my
  book OK?" can say what the last review concluded.

## 7. Industries and the market — the industry strategist's view (Roy, 2026-11-21)

"How are semis?", "is it a good time for banks?", "what's driving the market?", "how does the tariff news hit autos?" —
Axl answers in the same one voice, from the house's industry work beside the news and the web.

What Axl has today: `get_industry_views` (Pythia's three answers per GICS sub-industry, her near-term and long-term verdicts,
the HYPE flag, the summary) and `get_market_brief` (today's facts). What Pythia keeps and Axl cannot reach — her own READ
tools, shared as they are (one pipe, services/agents/strategy.agent.service.js): `get_theme` / `list_themes` (the themes she
tracks), `get_geopolitics`, `get_industry_money` (money flows into an industry), `get_industry_moves`, `get_capex_leaders`.

- **Axl gets those read tools** (appended after his current ones). Industry questions draw on the view AND what is behind it;
  market questions on the brief, the themes and geopolitics, plus the news and the web.
- **The prompt's old line "you have no view of your own — do not fill the gap" changes** to the one-voice rule: the house's
  view is said as the house's, and Axl's own reading (the web, general knowledge) is said as his, never blurred into it.
- **A `pending` industry is NOT built on a question.** Unlike a company's coverage, industry views are the house chain's
  scheduled, admin-run work (Pythia → the industry chain); Axl says it has no house answer yet and gives the news/web picture,
  labelled — answered from browsing (Roy, 2026-11-21).
- Changing an industry view stays Pythia's desk (admin), as today.

## 8. Steps

1. **Events by company** — `echoEvents.eventsFor(ticker, userId)` (the private `otherEvents` query in echoScore.service.js made
   public: house scored/checked/watching + the user's own) and an index on `scores.links.ticker`. Tests.
2. **`companyView` service** — gathers the three parts with their verdicts (§2, §3); pure verdict functions, tested on fixtures
   (NVDA's withdrawn case among them).
3. **Background triggers** — initiate / re-model per §4, with the claim and the cooldown; the "ready" line to the asking
   session. Tests on memDb.
4. **Axl's tool + prompt** — `get_company_view` (appended last — the snapshot and caching rule); the question-type rule (V4),
   attribution, what to say while a build runs. Remove Axl's "turn it to the analyst" rule of this morning.
5. **Specialists as material** — subagent replies hidden, returned to Axl; FE shows only Axl's reply (the role rows go).
6. **The monitors' view** — `get_item_status(id)` (§6): the journal rows, the order state, the book's review state; find where the
   last portfolio review's outcome is kept. Tests on fixtures.
7. **The industry strategist's reads** — Pythia's read tools on Axl (§7), the prompt's "no view of your own" rule rewritten to
   the one-voice rule. Snapshot + tests.
8. **Drive** — "how are semis?" (the view + themes + news); "how is my trade doing?" on a paper setup with reads; "is NVDA a good investment now?" (withdrawn coverage → said, a re-model NOT re-run inside the cooldown),
   "what's wrong with NVDA?" (news only), a name with no coverage (the answer now, the build, the ready line later).

## 9. Open

- Whether a `remodel_pass` should also mark the headline withdrawn in the document itself (today only the trail says it).
  §3 reads it right either way; the Coverage screen would still show the old target.
- The NVDA price mismatch behind its passes — a data-feed check, separate from this design.
