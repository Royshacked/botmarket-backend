# Argus rework — the desk architecture of 2026-11

Status: **Step 1 BUILT (2026-11-11, `b74ac3c7` + `c3367bfd`); step 2 in progress; the rest is design.** Branch `feat/desk-architecture` (backend + frontend),
one branch for the whole rework (Argus first, then Proteus and Daedalus, then Mentor without lenses).

## 0. Why

Every scan rule we backtested failed to beat SPY in a way that lasted (`docs/design/screener-lab.md`,
§3–§51). What we concluded (Roy, 2026-11-11):

1. **No rule fits every ticker, and you cannot know ahead of time which names will move together**, so
   every name gets its own read of where it stands NOW, not a rule fitted to its own history.
2. **Behaviour changes over time.** The run-up worked only after 2023 and the revenue beat only from
   2024; around 2024 the market went from rewarding reversal to rewarding momentum (§43).
3. **The scanner brings names with a good story; it does not say up or down.** What we did find is that a
   scanner can predict the SIZE of a move, not its direction.

## 1. The rules — one job per desk (Roy, 2026-11-11)

| Desk | Job | Not its job |
|---|---|---|
| **Argus** | the PICKER for each horizon, and the WHEN: he interprets Prometheus's and Proteus's reads into now or wait | reading the chart or the fundamentals himself, levels |
| **Prometheus** | the FUNDAMENTALS expert | price behaviour, levels |
| **Proteus** (new) | the TECHNICAL ANALYSIS expert: what this stock obeys technically, per horizon (nothing, an indicator, patterns) | picking, levels |
| **Mentor** | the TRADER: validates with both reads, then sets the stop and the targets | picking, the reads themselves |

Unchanged around them: Atlas (portfolio manager), Pythia (industries monitor). Daedalus (new) trades the
user's OWN setup — designed separately.

## 2. A trade, step by step

```
1. PICKING     — the user, from their own mind
               — the user, from the Hotlist (clicks a name)
               — Argus, from the Hotlist (the user asked Mentor for "something <horizon>")
2. PROMETHEUS  — Mentor validates the name with Prometheus's read, for the horizon
3. PROTEUS     — Mentor validates the technicals with Proteus's read, for the horizon
4. MENTOR      — builds the trade: stop and targets
```

- **A read is run if it is missing.** Prometheus already watches his names and decides when to revise;
  Proteus re-reads weekly (for now). An existing read is used as it stands.
- **Only names the user opens with Mentor** get the reads, never every name on a board.
- **No cap** on reads per user for now; the spend is logged.
- **The checks are chain code** (`services/chain/`): whether a read exists and running the missing one is
  not an agent's decision. Mentor gets both reads in front of him.
- **Mentor uses Proteus's read for the levels.** Example: Proteus says the stock respects the 20-day MA on
  the daily. On a swing, Mentor's stop then weighs the 20 MA alongside the swing lows.

Build order inside this: Prometheus first; Proteus plugs in when it exists.

### 2.1 Behaviour — one line in, the work done (Roy, 2026-11-11)

The user can hand a desk the whole job in one line, and the desk carries it to the end. Example:
**"Axl, let's swing on TSLA"** → Axl routes to Mentor → the reads (§2) → Mentor asks ONE thing: *"Roy,
give me position size, risk in dollars and the R:R you want, and I'll take it from there"* → Mentor
builds AND GENERATES the setup himself. Generating sends nothing to a broker: the setup is monitored,
and the broker path keeps its own rules (a shut venue queues, never fires).

- **Mentor:** the line above. No walk-through, no Generate click waiting on the user.
- **Atlas:** the same — "build me a portfolio of …" → Atlas asks only what the user alone can say
  (size of the book, risk), then builds and generates it.
- **Daedalus (the user WITH a setup):** the same — the user states the method once ("SMC, buy the
  sweep of the Asian low on 15m"), Daedalus asks only for size, risk and R:R, then builds and generates.
  Designed with Daedalus.

Questions only for what the user alone can say; everything else from the reads and the user's settings,
stated in the result so the user can change it.

### 2.2 One answer, then built, generated (and armed) — the design (Roy, 2026-11-12)

Built BEFORE Proteus step 4 (Roy). Today nothing generates without the user's press, and Mentor needs ~six answers
after the name (opening confirm, spans/entries, A/B, size, how long it waits, the runaway answer).

**Mentor asks ONE question**, once the name and horizon are settled: *position size, risk, and R:R.* Asked every time
— nothing is saved as a default (Roy). Everything else is his, stated in the result so the user can change it:

| Gap | Mentor's default (Roy, 2026-11-12) |
|---|---|
| Scenarios | **A + B** (both) |
| How long the entry waits (`valid_until`) | **Mentor decides** — from the horizon and the structure, said in the result |
| Price runs away unfilled (`on_away`) | **redraw** (`revise`) |
| The spans / entries gates | Mentor places them himself (the delegated path) |

**He answers "worth it?" with the MAX ENTRY PRICE.** From the three numbers and his stop and target: the highest
entry where the risk fits the size and the R:R is met (`get_entry_level` / `entryLevel` — position size and risk
give the risk %, R:R the minimum reward to risk; the lower ceiling wins).
- Price at or under the max entry → worth it now; the setup's entry is there.
- Price above it → **generated anyway, with its entry at the max entry and below**: it waits for price to come to it.
- No price can meet the R:R (the target too close to the stop) → **no setup**; he says why.
The three numbers are KEPT on Mentor's working state (not left in the chat), so a redraw or a later turn reads them.

**Then he generates AND ARMS it himself** (Roy: "also arm it automatically"). Arming starts the monitoring only:
nothing reaches a broker from a generate or an arm — an entry that fires still comes to the user as a card to
confirm (the existing entry path), and a shut venue queues, never fires. The session ends as any commit does (Roy,
2026-10-18): back at Axl, *"✓ TSLA setup — saved and armed, watching."*

**Atlas asks for his MANDATE** — objective, horizon, risk tolerance, and the book's capital (Generate needs it) —
once, then builds straight through: no architecture sign-off stop, names the house rates AVOID left out (no ask),
the architecture and every choice stated in the result. He generates the book (legs saved waiting); **activating it
stays the user's press** (activation fires the legs at market).

**Mechanism (code, not the prompt, holds it):**
- The model says it is done with a tag (Mentor `<go/>`, Atlas `<go/>`); CODE decides whether it may: Mentor — the
  draft's readiness lit, the three numbers on the state, no read pending (Prometheus's; Proteus's later); Atlas — the
  plan sized, the mandate complete. A `<go/>` that fails a gate is dropped and the reason said under the reply.
- A read still pending holds the go: when it lands (readSettled → Mentor's turn) Mentor builds on it and says go
  again — or, if the read is AGAINST the trade, asks the user once (unchanged, step 3).
- The go runs in the chain runner's `afterTurn`, which already holds the session lock — so it calls the desk's
  action through a lock-free entry of the act pipe (`act` split into the locked press and the held body), never
  `act` itself (the lock is not re-entrant). New desk actions: Mentor `generateArmed` (commit, then arm; an arm the
  gate refuses leaves the setup generated and says why), Atlas `generate` as today.
- Accounts: the ones the user's screen marked for the turn (already sent per turn) ride on the state for the go;
  none marked → no go, Mentor asks which account in one line (paper needs none).
- The user can still press Generate / Arm by hand at any point — the go is a shortcut, not the only way.

**Not changed:** Arm's gate, the fill confirmation, the venue rules, Prometheus's read before a build.

**BUILT 2026-11-12 (not committed at writing):** `<go>` (Mentor: `_parseGo`, the three numbers kept as `risk_plan`;
Atlas: a bare `<go>{}</go>` on a new book), the runner's `deskGo` (`GO` table: Mentor `generateArmed` with the marked
accounts or the held `go_pending`, Atlas `generate`), `act.actHeld` (the held entry; the lock is the turn's), Mentor's
`generateArmed` (save, then arm; an arm refused leaves it saved), the session's closing line "saved and armed …
watching". Mentor's prompt: § ONE QUESTION (risk-based builds; the user's own setup keeps its flow until Daedalus) and
the lens steps 4/5/7/8/9 rewired; the per-turn facts no longer ask for limits, A/B or the runaway answer. Atlas's
prompt: the mandate once with capital, one gate, AVOID left out, `<go>`. Live drive (`drive-desk-architecture.mjs
oneq`): EQPT swing — one question, A+B built, saved and armed after Prometheus's read (184 s), on_away revise.
Not yet driven: Atlas's go. Open: a redraw still asks the limits from the chat — it can read `risk_plan`.

### 2.3 Mentor, one way — the experts decide the trade, the user decides how much (Roy, 2026-11-12)

Builds on §2.2. Three changes:

**1. No lens, no modes.** There is one way Mentor builds, so the word "lens" and the modes go — from his words, his
prompt, the code that switches them, and the pane (no "Thesis" tag, no "Direction · Horizon · Lens — right?" card, no
span / entry tables with "You choose", no starter chips about shorting or "my own setup"). Mentor never says
"risk-based" or "thesis".
- The user's own LEVELS ("long at 238, stop 234") are discussed with Mentor: he uses them where the chart supports them
  and says where he differs.
- The user's own SETUP / METHOD ("SMC: buy the sweep of the Asian low on 15m") is Daedalus's. Until Daedalus is built,
  Mentor says that is Daedalus's job, coming soon, and offers to build it his own way meanwhile.

**2. "Let's trade TSLA" — the experts decide direction and horizon.** No direction or horizon asked of the user:
- CODE reads both experts before Mentor answers, and each posts one dated line in the chat:
  - **Prometheus** — his coverage (rating, target and date, his swing and long-term views, thesis). Researched first when
    there is none; **re-read first when his research is older than 30 days or a report has come out since** (Roy). Mentor
    says it is being read and waits, as today.
  - **Proteus** — the measured profile (what holds, if anything; false breaks and sweep depth; ATR; day trade / swing
    fit). At most a week old by construction; computed in seconds when missing.
- Mentor then says whether the name is worth trading, **long only for now** (shorts later), and on **which horizon**,
  from the two reads: Prometheus's book and target horizon (long term / swing), a dated catalyst (short term swing),
  Proteus's fit (day trade / swing) and the chart. "Not a long now" is an answer, with why.
- The user may overrule the direction or horizon; Mentor takes it.

**3. Then the three numbers, then their choice.** Mentor asks position size, risk and R:R (as §2.2). With the answer he
checks the account carries it (`size_position` — fits, or the largest that does) and asks ONE thing: **"Want me to take
it all the way, or go through it step by step?"**
- **All the way** — §2.2: built, generated and armed, every choice stated.
- **Step by step** — the levels in plain words (stop, target(s), A + B, the entry from their numbers, the wait, runaway =
  redraw), the user adjusting any of them; then generated and armed on their OK. No tables, no gate buttons.

**4. The work pane shows the entity being built — on every desk (Roy, 2026-11-12).** Mentor's setup, Atlas's book,
Prometheus's coverage, Pythia's view: the pane is the thing itself, filling in live as the conversation builds it. No
chips, no gate cards, no choice buttons — only the commit actions: **Generate · Dismiss · I'll do it later · Update**
(whichever apply). Everything else is said in the chat.

**Later (Roy):** Mentor recommends from the experts' data how much the trade is worth — the size and the risk — instead of
only asking.

**Build order:** (a) the reads before the first answer (point 2), (b) the flow after the numbers (point 3), (c) the lens /
mode removal across prompt, code and pane (point 1) — done with (a)/(b) where they touch the same prompt sections,
(d) every desk's work pane down to the entity and its commit actions (point 4).

## 3. Argus — the picker

### 3.1 Where he picks from, per horizon

| Horizon | List |
|---|---|
| intraday | the day boards (§3.3), the latest one |
| short term swing | This week (the run-up rule, `hotlist.week.js`) |
| swing | Swing (Prometheus's coverage, 3–6 month targets, `houseBook.service`) |
| long term | Long term (12–24 month targets) |

- He picks from the list, never from the whole market.
- **No name because the market regime is short** (e.g. This week is empty while SPY is under its
  200-day): he says so, and that we do not short yet, and gives no pick.
- A name the user brings does not go to Argus: step 1 is already done.

### 3.2 Swing / Long term: Argus picks from Pythia — unchanged

The house research chain (Pythia's industries → Argus best 5 → Prometheus, `houseScan.argus.js`) is
Argus's picking for these horizons, and stays as it is. Its survivors are the Swing and Long term lists.

### 3.3 The day boards — revived from the archive

The archived checkpoint pass (`archive/services/dailyScreener.checkpoint.js`, design `daily-names.md`),
cut to **three boards**:

| Board | ET | Archived checkpoint |
|---|---|---|
| Session open | 09:20 | `preopen` (open column) |
| Middle | 10:30 | `mid` |
| Session close | 14:30 | `eod` (into the close) |

Dropped: 08:00 `premarket` (a duplicate of the open) and 15:30 `tomorrow` (an overnight hold).

**Back:** the pool (fresh news, reported earnings, rating changes, movers), the hard gates (dollar volume,
price, spread, ATR — `daily-names.md` §2.1) and the in-play numbers (relative volume, gap or range
expansion, fresh catalyst by timestamp). These say a name WILL MOVE.

**Not back:** the A/B/C grades and their ranking — the part the replay showed losing (`archive/README.md`).

From a board, the user clicks a name → Mentor (§2), or asks Mentor for "something intraday" → Mentor asks
Argus, who picks ONE from the latest board.

**The 09:20 board has no spread gate (Roy, 2026-11-12).** Its first live run quoted 189 names and listed none: the
open column's 0.05% spread gate, applied to FMP's pre-market book (thin odd-lot quotes — TSLA 0.064%, CRWV 50.44/59.05),
rejected almost everything. The pre-market spread is not what a trade after the open pays; the gate is off on the
extended book only (`hotlist.day boardRow`), the spread still stored on the row. Price, dollar volume and ATR gate as
before; 10:30 and 14:30 never had one (the session quote carries no bid/ask).

## 4. What is cut from Argus

- **The prompt.** `scanner_system_prompt.md` (223 lines) is still the archived list-builder: five-field
  scan thesis, the 8–15 → 4–8 funnel, the four-axis scorecard, the phase gates, `<scan_list>`. And
  `scanner_mode_handoff.md` (129 lines) rides every turn only to override it. Both are replaced by ONE
  short prompt for §3.1.
- **Market-wide discovery tools:** `screen_candidates`, `get_market_movers`, `get_analyst_actions`,
  `get_sector_snapshot` — the Hotlist is his universe now.
- **The validate-a-name branch** of the hand-off — a user-brought name goes straight to §2.
- **Kept for now:** the chart tools (`get_chart`, `get_orderblocks`, `get_false_breaks`,
  `get_cycle_analysis`), until Argus is fully defined; they likely move to Proteus.
- Leftovers to check while cutting: the grounding ledger (it only stamps the pick's provenance now),
  phase tags 1–4, the `<ticker>` capture.

### 3.4 The WHEN — Argus interprets, the two experts decide (Roy, 2026-11-11)

Per name and per horizon, **Prometheus's read and Proteus's read together decide when**; Argus
interprets the pair into **now**, or **wait** (for a price or a dated event), and what would make that
wrong. He adds no chart or fundamental judgment of his own: that is what keeps the rules in §1 clean
(and why his chart tools end up with Proteus).

- **Swing / Long term:** Book Timing (`bookTiming.service.js`) stays as this read, its inputs changed
  from the overnight chart stats to the two reads. Re-read weekly, or when either read changes.
- **Day boards:** the same read on every board name at each checkpoint, valid until the next one.
- If this ever blurs into Proteus's job, the when moves to an agent of its own (Roy's fallback).

## 5. Open

1. ~~Short term swing (This week)~~ — decided (Roy, 2026-11-11): the run-up rule lists the names (as
   today, `hotlist.week.js`); **Prometheus AND Proteus** read every one (today only Prometheus's catalyst
   read, `hotlistResearch.service.js`; Argus's old picks there are archived-board only). Argus's when
   (§3.4) on top, like every horizon.
2. ~~**Proteus's design**~~ — talked 2026-11-12: `docs/design/proteus.md`; §2 step 3 reads it. Caution: "obeys the 20 MA"
   found in one ticker's history needs a check that it held in a later period, or it is luck.

## 6. Build order (after Roy's check)

1. Argus's prompt + tools cut (§4), picking from the Hotlist by horizon (§3.1). Tests. **BUILT 2026-11-11:**
   - `get_horizon_list` (`services/tools/horizonList.tools.js`) is his only source: This week for short term swing,
     the house's Swing / Long term Buys (Prometheus's target + the timing read) for swing / long term; intraday and
     day say the boards are not running yet (step 2) and list nothing.
   - **The pick gate is code:** a pick not shown this turn gets a second look at the house's lists today
     (`houseListNames` — a chat's history keeps no tool results, so "another one" on a later turn would otherwise
     lose its button); still off them → dropped, with a line under the reply saying to give Mentor the name. The
     second look takes ANY house list, not only the horizon's (the horizon is not kept in the session) — tighten if
     it ever matters.
   - Cut: the list-building spine and `scanner_mode_handoff.md` (one short prompt), the market-wide discovery tools,
     the grounding ledger (`archive/services/scanner.grounding.js`) and Argus's house-industries words (Atlas keeps
     the tool). The chart tools stay (§4). Mentor's hand-off `<open>` names the horizon.
   - FE: the status label "Reading the house list…" — the `public/` bundle is NOT rebuilt (feature branch).
2. The day boards (§3.3) back in the monitor's tick, three checkpoints, no grades; the FE's day views.
   **Backend BUILT 2026-11-11** (`services/hotlist.day.js`; Roy's calls the same day):
   - **Own collection** `hotlist_day_boards` — never `hotlist_boards`, whose boards of a day merge into This week's
     `day_list` (Argus, Axl and the Floor read it as the run-up list).
   - **Catalyst by timestamp only:** a name's latest 3 headlines since the last close with their ET times, and
     reported-earnings / rating-change flags. No labeller (no model call); a fresh catalyst stands in for the
     labeller's "material" in the open column's fresh-news path.
   - **Not scored:** nothing goes to the outcome log; a move-size record can come later.
   - A row: price, gap, relative volume (or pre-market volume), where it sits in the day's range, ATR, why in play,
     the catalyst, the quote time. Order: a fresh catalyst, then the biggest move, then volume — not a ranking.
   - **The in-play rules are long-side** (a gap up, above the open, the top of the range): the board lists names
     moving UP so far, and says it predicts nothing about where they go next.
   - Argus's intraday / day list reads today's latest board; the pick gate's second look takes every board of today.
     `GET /api/hotlist/day?day=` for the FE.
   - Open: a board name → Mentor (today's hand-off needs a graded cell — step 3's chain flow).
   **Frontend BUILT 2026-11-11** (FE `691b5be`): the Hotlist's Intraday tab (first in the horizon row), one board at a
   time on the latest, the in-play numbers, why and the freshest headline; no grade, room or result.
3. **Step 3 decisions (Roy, 2026-11-11):**
   - **Which read, by horizon:** swing / long term → Prometheus's FULL COVERAGE (it is the 3–6 / 12–24 month target);
     short term swing → his CATALYST read (the one This week already runs); intraday → NO Prometheus read (a 10:30 move
     has nothing for him to judge; the day board's catalyst is the read).
   - **Waiting:** Mentor says Prometheus is reading the name, the chat shows it, and Mentor builds when the read lands —
     one flow, no extra click.
   - **A read against the trade** (a sell / hold, or priced in): Mentor states the verdict plainly and asks ONCE whether
     to build anyway — the user's call. He does not refuse.
   - **Scheduling:** a user's read waits in line on the ONE shared research run (no priority, no second lane) — and
     Mentor says so, with how many names are ahead. Slow at busy hours (a house batch is ~4 min a name); revisit if
     it bites.
   - **Mechanism:** the sleeve pattern — the read is queued on the research queue and the house's run started (as
     the house, not the user); `onRunSettled` → the runner posts Prometheus's line and hands Mentor the read, whose
     turn then builds. Code decides whether a read exists and runs the missing one; Mentor never asks for it.
   **Prometheus's half BUILT 2026-11-11** (`services/mentorReads.service.js`, the runner's `askRead` / `readSettled`,
   Mentor's `_buildReadSection`). The trigger is the active name's SETTLED horizon on Mentor's ledger (a claimed one is a
   guess). A pass is an answer (not asked again: 5 days for a catalyst read, 30 for coverage); a read the run made
   nothing of is told as failed and held a day. After the bug hunt (Roy's calls):
   - **Accepted:** every swing / long-term name a user opens becomes house coverage (Covered companies, auto-revised).
   - **Generate is held in CODE** while the read runs: readiness goes dark and the press is refused (`read_pending`).
     A read that is in — for or against — failed, or could not be checked holds nothing: the user decides.
   - Runs are started BY SYMBOL, so a name another chain already queued is run for the user too.
   - A landed read never takes over another desk's running chain (the line is posted; Mentor reads it next turn).
   - The session rides on the queue row; `resumePending` at boot hands a read on after a restart.
   - Known: a user-asked catalyst read lands in `catalyst_reads`, so it shows in the Hotlist's reads and counts in
     Prometheus's scorecard. Proteus plugs in beside it when it exists.
   - **TWO TARGETS, ONE PER HORIZON (Roy, 2026-11-11, after the CR found a swing build validated against a 12-month
     target).** A company has a swing answer and a long-term answer; each needs its own rating and target. **Stage 1
     (decided):** coverage keeps its `price_target` as the MAIN one — the book, the monitor, the scorecard and a
     trade's `research_basis` are untouched — and gains an optional view for the OTHER horizon
     (`{ rating, target, by, why }`). Mentor reads the view matching his build's horizon. **Written lazily:** only
     when a build needs it — a swing build on a name with only a long-term target is the read the chain asks
     Prometheus for (the same wait-in-line flow), and he adds the view to the existing coverage rather than
     re-researching it. **STAGE 1 BUILT 2026-11-11:** `coverage.horizon_views.<book>` (`setHorizonView` — one field and a
     `horizon_view` revision; the rating is the house's band over the view's horizon; the horizon forced to the book's,
     3m/6m or 12m–24m). Prometheus's `horizon` mode (`prompts/analyst_mode_horizon.md`, `<horizon_view>`, its own ledger
     key) runs from a `mentor` queue row with `context.view`, against his coverage read as EXISTING COVERAGE; no block is
     his pass. `mentorReads.readFor`: the main target when its book is the build's, else a view under 30 days, else ask
     (`need: 'view'`). Retired / `watchlist` coverage is no longer a read: it is re-researched (`need: 'reinit'`, saved by
     `updateCoverage` live again — the CR's #3). **Stage 2 (later, only if stage 1's second targets prove good):** the view gets its own life —
     both lists, graded on the scorecard, watched by the monitor.
3. The chain flow (§2): Mentor opens → missing reads → Mentor validates and builds. Prometheus first,
   Proteus later.
4. QA / CR / docs cycle (APP_SPEC, CODE_MAP, `docs/desks/`).
