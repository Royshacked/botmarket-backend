# Invalidation — design spec

Status: **v1 BUILT 2026-06-30** (backend + frontend, frontend build green; not yet live-verified).
v2 (auto-analysis proposal) and the portfolio slow-cadence taxonomy remain deferred.
Supersedes the "thesis" concept.

## v1 build — what shipped (as-built)

Backend:
- `tradeIdeas.service.js` — idea fields `thesis*` → `invalidation { range:{lower,upper,lowerAnchor,upperAnchor}, conditions:[] }` + `invalidation_status` ('fired'|null) + `invalidation_reason` + `invalidation_edge` ('lower'|'upper'). `_normalizeInvalidation` (`conditions:[]` reserved, stored not monitored).
- `monitoring/invalidation.monitor.js` (replaced `thesis.monitor.js`) — `checkInvalidation(db, idea, symbolMap, {inPosition})`: one structured candle-close leaf per edge via `evaluateTree`, deterministic, fires on close outside range. Fire-once latch on `invalidation_status`. Drops the old `_aiEval` judge.
- `monitoring/monitor.service.js` — calls `checkInvalidation` pre-entry (looking, in `_checkEntry`) AND in-position (long/short, after `checkPosition`, reusing the entry-tf `aeCandles`).
- `trade_assistant_system_prompt.md` — `<trade_idea>` + `<state>` schemas carry `invalidation.range`; authoring rules: derive both edges from chart, cite the anchor, never a round number, range null until a structured entry exists.

Frontend (build green):
- `event-bus.service.js` `THESIS_EDIT_IDEA`→`INVALIDATION_EDIT_IDEA`; `ChatWindow.jsx` `invalidation_alert` bubble; `SocialChat.scss` classes; `MainPage.jsx` `isInvalidationReview` + dismiss/re-arm clears `invalidation_status/reason/edge`; `ChatPanel.jsx` review labels; `IdeaPage.jsx` `DevInvalidationPanel` renders the range + fired edge/reason.
- **Fixed a pre-existing gap:** `deriveBuildingIdea` never forwarded the old `thesis` (why it was invisible) — now forwards `invalidation` on create + update; edit-seed restores `pending_trade.invalidation` from the idea.

Reused the existing alert→edit→dismiss/re-arm flow wholesale (renamed). The dismiss = clear status (re-arm); edit = user adjusts then save re-arms.

## Why this exists / what it replaces

The word **thesis** was overloaded into three incompatible meanings (a structured
object on ideas, a string label on scans, `thesisAgeDays` on portfolio holdings)
and its one real surface was a self-hiding `[DEV]` panel. We are renaming and
re-grounding the idea concept as **Invalidation**.

We are not defining the thesis — we are defining **what would break it**.
"Invalidation" describes the breaker, not the belief. It is the trading term
("where's my invalidation"), and it slots in as the idea's fourth condition
concept alongside **entry / stop / tp**.

- Idea thesis-object  → **Invalidation** (this doc)
- Scan `thesis` string → out of scope here (scan items aren't ideas yet; leave as-is)
- Portfolio `thesisAgeDays` → unrelated (holding age); not touched

## Core model

An idea is the atomic unit. It carries condition logic for entry, stop, tp — and
now **invalidation**. Invalidation is **a structured price RANGE** the agent
derives from candles/chart at authoring time:

- price **inside** the range  → invalidation `false` → idea valid, original plan continues, no interruption.
- price **outside** the range (either edge) → invalidation fires → Axl notifies user in social chat + deep-links into the idea in **edit mode**, where the user reviews chart + news and decides.

Invalidation is two-sided. A setup dies two ways:
- **Wrong** (lower edge): price *accepts below* the defended structure the entry relied on (e.g. the swing low a false-break must hold).
- **Gone / missed** (upper edge): price *runs past* the actionable zone so the entry can't trigger / R:R is destroyed (e.g. plan a false-break of 100, gap up to 120).

So the range is an **envelope around the actionable entry zone**, narrower than
the stop→target span. The two edges have **different derivations**:
- lower edge ← defended structure (swing low / range floor)
- upper edge ← entry reachability + R:R ("entry can't fire from here / risk is blown")

## Data shape vs monitored scope (IMPORTANT)

The invalidation **data shape carries the FULL condition-type taxonomy** from day
one — same general condition-tree shape as the entry tree (structure / news /
earnings / chart / indicator / time / volume). In **idea mode v1 we only MONITOR
the structured leaves**; the other slots exist but hold nothing.

Reason: **portfolio (swing → long-horizon) mode** will need invalidation that is
*not only range* — news, earnings, chart, indicator — evaluated on a **slow cadence
(weekly / monthly)**, not intrabar. Keeping the empty slots now means portfolio can
populate them later with **zero schema change**. So: author/store the full tree,
filter to structured leaves at monitor time for v1.

(Portfolio invalidation mechanism + cadence is a separate, later conversation.)

## Scope for v1 (monitored)

Structured (price/candle) invalidation only. Everything non-price is handled
**reactively** by the agent once the user is in edit mode (it re-reads news, chart,
checks if the setup now looks like a short, etc.). Conscious tradeoff:

- ✅ price-driven breaks → caught proactively.
- ❌ non-price breaks (war/Fed/earnings) while price stays in range → NOT proactively caught.

This blind spot is intentionally accepted because:
1. In-position drawdown from surprises is just trading; the **stop is the in-position invalidation of last resort**.
2. **Foreseeable** catalysts are handled at planning time as ordinary **entry conditions** — e.g. `time` leaf "don't enter before the Fed print" + `news` leaf "and only if it's positive." You never enter into a known landmine.
3. Real-time news monitoring is deferred until the paid websocket news APIs are in; then non-price invalidation leaves (`news`/`time`) can be OR'd into the range cheaply.

## Lifecycle / monitoring behavior

Invalidation monitoring runs **continuously — pre-entry AND in-position** — same
flow both times. Exits are **always stop-owned**; invalidation can *inform*, never
*execute*.

- **Pre-entry, range breaks** → fire → notify + edit link. Natural user action: re-arm / edit the entry.
- **In-position, price in range** → nothing; original plan continues.
- **In-position, price breaks range bottom but still above stop** → "**yellow**": the structure the trade relied on broke, but the stop (buffered below structure) hasn't. Fire → notify-only + edit link. The user reviews (hold / tighten / scale / bail); **the stop still owns the exit**. Natural user action: review, not re-arm.
- **In-position, price hits stop** → "**red**": stop executes as today. Not an invalidation concern.

The range bottom and the stop are **two deliberate lines**: range bottom = structure
(yellow, informational), stop = buffered below structure (red, executes).

**Hard guardrail:** never auto-act above the stop. The stop is the only thing that
moves money in-position.

## Division of labor

- **AI, once, at authoring:** read candles/chart → define the actionable entry range (both edges, each anchored to a cited structure). Must **state the structural reference in chat**, not emit a naked number ("invalidation = close below the 93.40 swing low the false-break must hold" — not "90"). A naked number is the unauditable "why 90 not 95" problem.
- **Monitor, continuously:** is price in or out of range → boolean. No AI in the hot path. (Drops v1's AI holding/weakening/invalidated re-eval entirely.)
- **Human, on fire:** Axl notifies → edit mode → review chart + news → decide.

## Agent authoring rules (no user help — agent derives it)

When the agent defines a **structured entry** condition it must also:
1. Call `get_chart` (often already has the data from entry/stop reasoning).
2. Identify the **actionable entry range**: lower edge from defended structure, upper edge from entry reachability / R:R.
3. Emit the invalidation as a structured range, each edge anchored to a cited pivot.
4. State the reference in chat in plain English ("inside this zone we proceed; outside it we rethink").

This mirrors how the agent already derives stops ("where is the thesis wrong",
`trade_assistant_system_prompt.md`) — same competence, different timing (pre-entry).

## Portfolio & scans

- **Portfolio:** ideas are structurally identical, so invalidation applies per-idea unchanged. (Portfolio default entry = immediate/market; condition editing blocked for now — but invalidation still watches + notifies + edit-links per idea.) Swing→long-horizon invalidation runs on a **slow cadence (weekly/monthly)** and uses the **full taxonomy** (range + news + earnings + chart + indicator), not structure-only — which is exactly why the idea-mode data shape keeps all leaf slots even though v1 monitors only structured. Mechanism + cadence = separate later conversation.
- **Scans:** excluded. Scan items aren't ideas yet; nothing to watch until one is built into an idea. (Scan→idea handoff already passes ticker + analysis summary + datetime→`time` condition.)

## Reuse / what NOT to build

The whole "thesis" problem collapses into things we mostly already have:
- **(a)** an entry-range **invalidation tree** (new, but reuses structured-leaf evaluation — see `thesis.monitor.js:52` which already wraps strings as `{type:'structured'}` leaves and ORs them).
- **(b)** **entry conditions** reused for catalyst gating (`time` + `news` leaves — existing).
- **(c)** the **stop** as in-position invalidation of last resort (existing).

Nothing new is invented for catalysts or in-position exits.

## v2 — auto-analysis proposal (NOT v1; recorded, deferred)

Same invalidation fire, richer payload. Instead of a bare alert, Axl runs the
idea-building **analysis phase** once on the user's behalf (re-reads news + chart +
candles) and returns a **summary + options card** to social chat:

- **Accept new idea** — confirm the agent's proposed setup/exit changes.
- **Dismiss the whole trade.**
- **Leave things the same** — keep the original plan.
- (optional) open edit to discuss.

**Constraints (idea mode):**
- Agent runs the re-analysis **exactly ONCE per fire/setup** — not a loop. After it
  posts the options, it does not auto-re-run; the user picks one of the three
  outcomes. Combined with the fire-once latch, the agent fires **at most once per
  setup**.
- More autonomous / recurring re-analysis lives in **portfolio mode** (weekly/monthly
  cadence), not here.

Reuses the existing **agent-proposes → user-confirms** pattern (`portfolio_update` +
`OrderConfirm`). Genuinely new pieces: (1) an autonomous, user-less agent run kicked
off by a monitor event (no user turn exists today); (2) a structured *proposal* emit
type + frontend options card (new vs old setup / exits / dismiss). Guardrail holds:
agent only **proposes**, user confirms, nothing auto-executes, exits stay stop-owned.

(Pin the exact building phase to re-enter when building this — it's in
`trade_assistant_system_prompt.md`.)

## Open implementation questions (for build phase, not design)

1. Field name/shape: `invalidation_condition_tree` mirroring `entry_condition_tree`? Range stored as two anchored structured leaves OR'd, or a dedicated `{lower, upper}` shape?
2. Fire-once latch: after firing, suppress re-fire until user acknowledges/edits (v1 used `thesis_status != null` as the latch — port that idea).
3. Notification payload: keep `thesis_alert` type or rename to `invalidation_alert`? (Frontend sync rule applies — update frontend when this contract changes.)
4. Rename pass: `thesis` / `thesis_status` / `thesis_status_reason` fields, `thesis.monitor.js`, the `[DEV] Thesis` panel, system-prompt sections.
