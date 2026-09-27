# Argus — the `scan`

The discovery desk: **Argus** turns "what should I be looking at this week" into a ranked, grounded
list of candidates — and hands the one the user picks to the desk that builds on it. Written
2026-09-19 from the code, the three prompts and APP_SPEC §4 (which holds the contract — the list
shape, the CRUD, the hand-offs). This doc is the reasoning. Argus has **no monitor**: a scan is a
period-bound list that goes stale by date, not a position that needs watching.

The one line: **names come from the tape, never from memory — and the code enforces it.**

## What a scan IS

A watchlist, not a set of ideas: `{ period, thesis, direction, style, candidates[] }` with each
candidate carrying `ticker · direction · thesis · analysis · signals · conviction · sources · score`
(`api/scanner/scan.service.js`). Identified by its **period** (resolved dates) and **thesis** — a
different period or thesis is a different list. Owner-scoped like every user list, but **bound to no
account**, so scans are shared across all three workspaces (APP_SPEC §8): research has nothing to
scope by. A list whose end date has passed is **stale** — derived on read, never stored, so the UI can
badge it and the user keeps it until they delete it.

The `analysis` field is written to be self-contained ("2–4 sentences: the setup, the catalyst, what
would confirm or invalidate it") because it is what the receiving desk reads when the candidate is
handed on — the receiver cannot see Argus's chat.

## Three shapes of one desk

Argus has one spine — the funnel below — and three things it can be asked to converge on. They are
profiles and a mode, not separate agents, because everything about *how* to screen is shared and only
the target and the emit differ (`services/agents/scanner.agent.service.js`, P4a):

| | Converges on | Emits | Goes to |
|---|---|---|---|
| **Trading profile** (default) | a ranked list of 4–8 tradeable setups for a period | `<scan_list>` | the user; a picked name → Mentor |
| **Investing profile** | a shortlist of businesses worth researching under a mandate — fundamental/quality lens, no technical kit | `<scan_list>` with a `lens` (the selection school) | Prometheus, top N by the app's button or one by click |
| **Hand-off mode** (trading) | ONE ticker to build a single trade on | `<kairos_pick>` | Mentor |
| **Radar cut mode** (trading) | a given universe — Aether's event board — cut to 8–12 | `<scan_list>` with `source: 'aether'` | Prometheus's batch read, then the user's Scans |

The hand-off used to sit *inside* the trading prompt, where a list-building turn read fifty lines of
"find ONE ticker, do not emit a scan_list" that did not apply, and a hand-off turn read the list
machinery it had to override. It is now its own module (`scanner_mode_handoff.md`), injected as its
own cached block only on a hand-off turn, with the destination named in the volatile tail rather than
the module — interpolating a desk name into a cached block would give every destination its own
cache entry. The tag is literally `<kairos_pick>`: it kept the name of the desk it was written for,
and renaming a tag both repos parse is a migration, not a docs fix. Read it as "the single pick"; it
goes to Mentor ([trade-pipeline.md](trade-pipeline.md)).

## Radar cut mode — the board Aether hands over

`prompts/scanner_mode_radar.md`, the second module, injected as its own cached block. It replaces the
DISCOVERY half of the spine where hand-off replaces the list half, and the two are mutually exclusive —
one ends in a pick, the other in a list — which is what keeps the system prompt inside its
two-cached-block budget. The board itself rides in the **volatile tail**, rebuilt every turn: not
`editList`, which would tell Argus it is refining a list and to keep untouched names (the opposite of a
cut), and not the seeded opening message, which is rendered as the user's own chat bubble.

**The universe** is `services/aetherScanUniverse.service.js` — every name thirty days of events reached,
folded to one row per ticker, minus the names a previous radar list already took. The exclusion is keyed
on `run_id` and never on a timestamp: a run id is `subject:published-date` and the engine never rewrites
it, where `created_at` is stamped with `now` whenever a candidate is stored without one, so re-verifying
an event would make every name it reached look newly discovered and flood back onto a worked list. A
name Argus **rejected** is not excluded tomorrow ("no catalyst this week" is a verdict about this week);
a name it **kept** is.

**Every row arrives dated**, and that is a bug fix with a history. The mode used to open with two batch
calls — `get_earnings_calendar` and `get_quotes`, both over the whole board, mid-stream, on the user's
clock. On 2026-09-27 the calendar lost that race four times out of five (a 10s budget against a fetch of
the entire market's calendar, competing with its own 116-wide quote fan-out), the model had no dates for
anything, and the mode's own rule — *"without a date, a name does not belong here"* — cut a 116-name
board down to **one** name. Both facts are now attached server-side before the prompt is built: the next
print (one cached call through the shared `earningsWindow`), the claim's grading deadline, the engine's
own last price, and the move since the event vs SPY. A **missing** `earnings` key means "the calendar
could not be read" where **null** means "nothing scheduled" — the pair survives the JSON round trip to
the browser and back, which a sentinel string would not, and the distinction is the difference between
a fact about the company and a fact about the fetch.

**Three passes, and the order is the whole design.** The catalyst question used to run first, with
per-name tools forbidden until after it — so a strong chart could never rescue a name, because no chart
was ever read.

1. **Triage** the board for free, on evidence and the unmade move, down to ~20 worth a chart. Explicitly
   *not* the cut, and explicitly barred from filtering on the earnings calendar: mid-quarter almost
   nothing on the board reports.
2. **The tape** makes the cut — `get_quotes` once for liquidity, then price action and indicators. A
   name dies here for no setup, having already run, or being untradeable. The module states the real
   tool budget (**ten rounds**, `DEFAULT_MAX_CONTINUATIONS`) and tells Argus to batch per-name calls in
   one round, because twenty names one at a time is the budget gone before a chart is read.
3. **Is the event still tradeable**, on survivors only — and the point is that it is not a hunt. The
   event each name arrived on IS its catalyst: dated, mechanism-verified against the company's filings,
   and carrying the date the claim is graded on. What is different about this board is that the event
   has already HAPPENED, so the trade is "get in while the market is still repricing it", and the three
   questions are whether the claim is still live, whether the move is already made, and whether the
   deadline is near enough to matter — all three answerable off the row. An earnings or macro date is an
   ACCELERANT, never a requirement: the claim's deadline bounds how long you will be wrong, a scheduled
   print bounds when you find out, and only the first is always there. This took two goes — the first
   version demanded a catalyst inside the coming week (mid-quarter that means earnings, and the board
   collapsed to its one off-cycle reporter), the second offered "four things that count" of which two
   were just the event read properly, so a list of equivalent options still read as "go find one".

**Direction is deliberately not passed.** Aether's `side` is a claim about ONE event, and nine of the
twenty-one recurring tickers carry conflicting sides, so the sides ride in the thesis line as
information and Argus is asked a direction-blind question. The direction is settled downstream.

**Then Prometheus, by itself.** The list Argus emits is read against the record before it is saved —
`services/aetherBatchRead.service.js`, fired automatically from the panel (`_settleScan`), not from a
button: `contradicted` and `priced_in` are out, `unclear` and unread ship flagged, and the longs cut on
the read's `net` where it has one and Aether's `side` where it does not. Three reads at once
(`READ_CONCURRENCY`), capped at twelve names (`BATCH_MAX`) with the overflow returned unread rather than
refused — which is why the module aims at eight to twelve. The user can leave without waiting ("Save
without the read"), and a read that lands after they did is discarded rather than applied.

A fourth shape has **no agent at all**: the **house scan** (`services/houseScan.service.js`), fired
after Pythia publishes a tilt. For each overweight sector it runs the FMP screener with a neutral
composite filter and enqueues the hits for Prometheus, with `active_bp` setting breadth and queue
order. The regime and the stance's `basis` travel on the queue row rather than being compiled into
filters — the screener has no valuation or revision predicate, and faking one with a proxy would
substitute a guess for Pythia's stated reason. Turning the basis into real factor selection needs the
Argus *agent* in that loop, not a wider filter list. The sleeve hop Atlas uses
(`sleeveSource.service`) is the same screen with the school as its coarse filter
([atlas-themis.md](atlas-themis.md)).

## The funnel

`prompts/scanner_system_prompt.md`. Four phases, a confirm gate between each — "cheapest, broadest
filter first; the expensive per-name tools touch only the survivors":

1. **Scan thesis** — five things before any tool: period, angle, direction, trade style, cap. Extracted
   from the message, never re-asked; if vague, one question at a time. The period resolves to dates.
2. **Discovery** — read the tape first (`get_quotes` on SPY/QQQ/IWM for the regime and the
   relative-strength benchmark), then cast the net from **grounded sources only**: `screen_candidates`
   (a fundamental and liquidity screen — it cannot find chart setups), `get_market_movers`,
   `get_analyst_actions`, `get_earnings_calendar`, and `web_search` — which reaches names the feeds miss
   but **is a lead, not a candidate**: a searched name must be confirmed by a per-name tool before it
   can appear. Dedupe to 20–40, coarse-triage with `get_price_action` to 8–15.
3. **Validation** — a baseline on every survivor (`get_candles` for structure, `get_indicators` for
   the exact math, the tradability gate, the relative-strength check, *name the setup*), then angle
   tools only where the trigger fits (fundamentals for anything held overnight; short interest and
   options for a squeeze; order blocks and false breaks for a structure angle; cycles; derivatives for
   crypto), and `get_chart` — a rendered candlestick the model *looks at* — reserved for the top two or
   three. **Drop discipline**: every cut is stated with its reason and the funnel counts reported;
   nothing is silently omitted. Conviction needs **two confirmed signals** — "it's in the news" alone
   is low. Target 4–8; more is not selective enough.
4. **Ranked list** — lead with the two or three worth acting on and why, then the block.

Two spine rules carry the whole thing. **Relative strength is the spine**: a name is interesting only
if it leads or lags its benchmark and sector in the direction wanted; a long that underperforms SPY on
the very move being cited is a weak long. And **"nothing clean here" is a valid answer** — narrow the
thesis rather than manufacture a list.

**The chart is model-only.** Argus's `get_chart` renders a KLineChart image the model reads and the
user never sees (decided 2026-07-22): the render is an internal vision read, not a deliverable. The
`<chart>` *tag* — the user asking to see one — is a different pipe with a different judgment.

## What the server decides, and why the model does not

Three things are taken out of the model's hands on purpose:

- **Grounding** (`services/scanner.grounding.js`). The prompt's core doctrine was enforced by nothing
  until a session ledger recorded which tickers a real, *successful* tool engaged: `sourced` — the
  symbol appears in a discovery tool's output (that output IS the tape); `validated` — a per-name tool
  ran on it. A candidate in neither set is a fabrication and is dropped at normalise. A failed call
  confers nothing, so a bogus ticker the model merely *attempted* never gets credited. A `keep: true`
  reference on an edit turn is exempt — its grounding was checked when it was first added.
- **The composite score.** The model scores four axes, 0–100, shown to the user — trading:
  `catalyst · technical · relativeStrength · liquidity`; investing: `quality · valuation · growth ·
  balance_sheet` — and **the server computes `total`**, discarding any the model emits. Trading weights
  are by trade style (intraday leads with technical 0.40 and relative strength 0.30; long term leads
  with the catalyst 0.35), because what matters at a horizon is not the model's call to make per list.
  Investing weights are by **selection school** (`investorSchools.js`): which axis leads *is* the school,
  and no lens gives the neutral blend that ranks exactly as lists did before schools existed. A partial
  card scores from the axes it has, renormalised; a bare total with no axes is never trusted. The list
  is then sorted by total regardless of emission order — so honest axis scores matter more than where
  the model put a name.
- **The build lens** (`recommended_mode`, trading only). Argus suggests which lens the pick fits —
  `discretionary` (price action + catalyst, the default), `smc` (order-block / sweep structure, needs a
  liquid, structure-rich name), `institutional` (positioning and macro). The server validates it and
  **downgrades an infeasible suggestion**: `smc` or `institutional` on a name whose `liquidity` axis is
  under the floor becomes `discretionary`. Warn-never-block — it sanitises the pre-fill, and the user can
  still pick any mode. Mentor authors `trade_mode` from it.

The reasoning sidecar (`deepThink`) has its tightest clause on this desk, stated explicitly: a scan is
dozens of names, and a desk that consults per candidate turns a cost saving into a per-scan multiplier;
the two cases it may consult are once-per-scan by construction.

## Editing a list

Reopening a saved list tells the agent exactly what it holds; untouched names come back as a bare
`{ ticker, keep: true }` reference rather than re-typed analysis (saves output, avoids regeneration
drift) and are rehydrated from the stored record. The school is inherited from the list being edited
when the turn forgets to restate it — otherwise every kept name would be re-ranked under the neutral
blend, the order silently changing while the user watches, for a school they never dropped.

## The hops

| With | Direction | Mechanism |
|---|---|---|
| **Mentor** | out | the single pick — `<kairos_pick>` → `{ ticker, direction, thesis, analysis, recommended_mode }` seeds Mentor's first turn (`scanSeed.util`); or a clicked candidate on a saved trading list |
| **Prometheus** | out | an investing list's top N by the app's button, one name by click — the research queue, house-owned; or by asking ("send NVDA to Prometheus") through the shared `<route>` hand-off |
| **Pythia** | in | the house scan runs on her publish — no Argus turn, the screener alone |
| **Atlas** | in | the sleeve hop — the same screener under the school; never Argus's chat |
| **Axl** | in / out | the user is routed here with a name; Argus can route the user on by their ask |

Nothing structured crosses on a user's ask — the `<open>` is prose written by the sender. The
automatic conveyor hops (`kairos_pick`, the sleeve) keep their artifact kinds because they carry
fields the receiver's UI needs.

## Why it is shaped this way

- **Grounding in code, because a doctrine enforced by prose is a hope.** The ledger is what made "never
  from memory" true; before it, a plausible fabrication reached the UI with a full analysis attached.
- **Server-side scoring, because a ranking the model computes is a ranking it can flatter.** The axes
  stay visible and honest; the weighting is policy — a horizon's, or a school's — and lives in one place.
- **One spine, three targets.** A separate hand-off agent would re-derive the funnel and drift from it;
  a separate investing agent would re-derive the grounding. What differs is the emit, so only the emit
  is modular.
- **No monitor, because a scan is a question about a period.** It ages out; the thing that needs
  watching is the trade built from it, and that has Talos.
- **The house scan has no agent, on purpose.** Screening a sector on a published stance is
  arithmetic on a whitelist; the judgment (does this name clear the school's real bar?) is
  Prometheus's, four minutes a name, and the queue row carries the reason so he can apply it.

## Open

- **The Argus agent in the house-scan loop** — the only way a stance's `basis` becomes real factor
  selection rather than a note on the queue row (`houseScan.service` says so).
- **Scans are the one artifact that never learns.** A stale list is kept for the user, but nothing
  scores whether its candidates went the way the thesis said. *(Inferred gap — the tilt and the
  coverage both grade; the scan does not.)*
