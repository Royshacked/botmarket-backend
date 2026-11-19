# Echo — the event desk (design, 2026-11-19)

Echo maps an event to the companies it reaches through the supply chain, and says which of them the market has not
caught up with yet. The engine already does this for earnings moves as a FORWARD TEST (aether-engine
`echo/forward.py`, README "Echo"): the model maps live events, the market grades the maps at 20 / 60 / 120 sessions,
and the pass rule — declared 2026-11-19, before any grade — reads ONCE on the first 30 events graded at 120 sessions
(about mid-2027). This desk puts that work in front of the user and lets the user bring events of their own.

## 1. Decided (Roy, 2026-11-19)

1. **Echo's names show in the HOTLIST, labelled.** An Echo section with the forward test's open events and their
   flagged names, marked "forward test — unproven" until the verdict. The backtest on filings found no edge and the
   old event board graded 46% hit; the label is what keeps these from reading like the run-up names beside them.
2. **A new desk, Echo.** Its own agent, prompt, desk and chat — not a tool on Argus or Prometheus.
3. **Any event.** Echo's detected events AND anything the user names in chat — "GTA 6 is out", a guidance cut, a
   deal, a strike, a heatwave. Not only earnings moves of the 152 names the forward test watches.
4. **A name that comes up goes through Prometheus and Proteus by horizon** — the chain Mentor already uses
   (`mentorReads.READ_OF`: swing / long term → Prometheus's coverage, short term swing → his catalyst read; Proteus's
   measured profile for every name, `proteusQueue.queueProfiles`). No new research path.
5. **Flagged names only** go through the reads on their own (§6), and **swing** is the forward test's horizon
   (Roy, 2026-11-19, both as proposed).

## 2. Two kinds of event, kept apart

| | forward-test events | user events |
|---|---|---|
| where | engine, `echo_forward` (prod db) | backend, `echo_user_events` (new) |
| who finds them | the engine's nightly rule (earnings, ≥5% vs SPY, 152 names) | the user, in chat |
| mapped by | the engine's frozen mapper (`llm_map.py`, PROMPT_VERSION 2026-11-19) | the backend's port of it (§4) |
| graded | yes — day-5 check, 20/60/120 | no verdict, ever |
| in the Hotlist | yes, labelled | no — in the user's Echo chat and desk only |

**A user event never enters the forward test.** It is chosen after the user saw the move; counting it would bias the
verdict. The backend never writes `echo_forward`; the engine never reads `echo_user_events`.

## 3. Framing a free-text event

"GTA 6 is out" names no earnings print, no date, no direction. Before mapping, Echo frames it into the same shape the
mapper takes:

- **origin** — the company the event happens to (Take-Two, TTWO), or, when there is none, the DEMAND it moves
  ("console gaming hours", "US air-conditioning load"). One or more tickers when listed.
- **effect** — `up` / `down`: what the event does to the origin's demand. GTA 6 out → up.
- **date** — when it became public (today when the user says "is out").
- **what changed** — one sentence, kept as the event's description.

Echo asks the user only what it cannot settle itself (an ambiguous origin, a direction that could go either way), once.

## 4. The mapper, ported

The backend cannot run the engine's Python on Render (separate services), so the mapper is ported to Node:
`services/echoMap.service.js`.

- **Same prompt, same schema, same model** (Opus 5.5, effort high, streamed, structured output) as `llm_map.py`
  PROMPT_VERSION 2026-11-19, with the framed event in place of the earnings line. A copy, kept in step by a test that
  compares the system prompt to the engine's file when the engine is checked out beside it.
- **Same resolution**: US listings only via the FMP profile, the origin and duplicates dropped, at most 30 links.
- **Direction by the rule, not the model** (`chains.direction_for`): suppliers and infrastructure move WITH the
  origin's demand, substitutes against it, peers and customers `unclear`. The model's own direction is kept in the note.
- **The map records** the model that served, the prompt version, the framed event.

GTA 6, for illustration: layer 2/3 — the console makers' chip suppliers (AMD), the consoles (Sony ADR, Microsoft),
retail (GameStop); substitutes — other publishers competing for play time. Directions from the rule.

## 5. The desk

- `services/agents/echo.agent.service.js`, `prompts/echo_system_prompt.md`, `services/desks/echo.desk.js`, registry
  desk `events` (name TBD at build), routed from Axl ("what does GTA 6 do to…", "ask Echo about…") — Proteus's wiring
  (c1240bc0) is the template: registry, routing.util, Axl's capture, the tool snapshot.
- **Tools**: `get_echo_events` (the forward test's open and graded events, the track record so far),
  `get_event_map` (one event's links, flags and grades, either kind), `map_event` (frame + map a user event; writes
  `echo_user_events`), and the hand-off of a name to the reads chain (§6).
- **What Echo says about a forward-test event is the record**, not a fresh opinion: the frozen map and the frozen
  check. It may discuss and explain; it does not re-map them.
- Echo does not pick the trade or set levels — that stays Mentor's. From a name, the user goes on to Mentor as with
  any other.

## 6. Names through Prometheus and Proteus

- **Which names**: a forward-test event's FLAGGED links (the ones the thesis is about — the market has not caught up),
  once the day-5 check is frozen; a user event's directional links (suppliers / infrastructure / substitutes) when the
  user asks — not every one of up to 30 links.
- **Horizon: swing** for forward-test names — the test grades at 60 and 120 sessions (3–6 months), which is
  Prometheus's swing coverage window. A user event takes the horizon the user says; swing when unsaid.
- **How**: Prometheus's read through the research queue as the house (source `echo`, waits in line on the one run,
  as Mentor's reads do); Proteus's profile through `queueProfiles(symbols, { source: 'echo' })`.
- **Whose money** (CR 2026-11-19): the weekly budget (ECHO_RESEARCH_MAX_USD, $2 ≈ 20 names at ~$0.10 each, measured in
  the Cisco rehearsal) is the HOUSE's — only rows `requestedBy: 'house'` count against it. A user's ask is outside it
  and capped by count instead: 5 names at a time, 10 a week per user (`MAX_USER_WEEK`). On resume a user's waiting
  names run first; the house's run on the next tick.
- **A user's words are quoted** (CR 2026-11-19): the event, its origin and the map's reason reach Prometheus's opening
  in quotes, as a claim to check and never an instruction — the coverage and target he writes are every user's.
- **Once, but only when settled** (CR 2026-11-19): `echo_handoffs` is written only when every name reached a final
  answer; a read that could not be checked or a row that could not be written leaves the event for the next tick.
- **In the Hotlist row**: the name, its relation and direction, why it was flagged, Prometheus's read and Proteus's
  badge when they land, and the event's grades as they come in.

## 7. Build order

All built 2026-11-19 (BE ea4e141f · d47cd7d0 · ab3302d3 · step 5; FE 1f0719f · bc9ba29), not pushed:

1. **Read side** — `echo.service` reads `echo_forward`; `GET /api/hotlist/echo`, `GET /api/hotlist/echo/:id` (under the
   Hotlist's routes, where it is shown). Laptop `axl_dev` has no forward-test rows — the drives answer these from prod
   in process (`AETHER_DB=test`, read only).
2. **Hotlist Echo tab** (FE) — "Echo · test", last: the label first, the record so far, events, an opened event's
   lagging links (all a click away). `scripts/drive-hotlist-echo.mjs`.
3. **The mapper port** + framing — `echoMap.service`, `echo_user_events`; provider `callAnthropicStructured`.
4. **The desk** — `echo` / desk `events` / role "event analyst", routed from Axl; FE agent + "Map an event" desk +
   Info flow; "Ask about this event" on the tab. `scripts/drive-echo-desk.mjs`.
5. **The reads hand-off** — `echoReads.service` + the `echoReads` loop (6 h): a checked event's lagging names to
   Prometheus (swing coverage, source `echo`, ECHO_RESEARCH_MAX_USD a week, default $2) and Proteus, once per event;
   `request_reads` for a user's event (≤ 5 names at a time, 10 a week).
6. Tests at every step; live drives; the QA/CR/docs cycle — DONE 2026-11-19 (two independent reviews; fixed: user
   words quoted to the house analyst, the house budget counts the house's names only + a weekly cap per user, a
   hand-off recorded only when settled and each event in its own try, the origin's listing checked before the paid
   map call and an all-dropped map not saved, the journal's (at, id) cursor; FE: the event row's keyboard toggle, the
   Echo tab's scoped style, the detail held to a phone's width, the journal hook reset per setup). Left: Echo's
   `sendNames` repeats `mentorReads.requestRead`'s readFor → enqueue → run — fold them into one when either changes.

## 8. Open

- Cost: a user map is one Opus 5.5 high call — MEASURED 2026-11-19 on "GTA 6 is out": 37 s, 1,579 tokens in, 3,126 out,
  ≈ $0.07, 21 links kept (Sony, Microsoft, AMD, TSMC, Micron, SanDisk, Seagate, accessories; Roblox, Netflix, AppLovin as
  substitutes), EA and WBD dropped (FMP: no longer active listings). Prometheus's reads ~$0.04 a name
  (house-research-chain, measured 2026-10-23).
- A user event's market check (the day-5 numbers) is the engine's Python; not in v1.
