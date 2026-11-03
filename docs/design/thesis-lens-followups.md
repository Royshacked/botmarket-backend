# The thesis lens — the deeper stop, the break scenario, and the trade that leaves

**STATUS: BUILT (2026-11-02), not pushed, not live-driven; open questions decided the same day (§ Decided). § Built at the end.** From a walk-through of the risk-based mode with Roy on two live
names, GNRC and NXST. Builds on the thesis lens ([stock-playbook.md](stock-playbook.md); Mentor's prompt § The thesis
lens) and the two modes ([mentor-modes.md](mentor-modes.md)); the validity contract is
[../desks/mentor-talos.md](../desks/mentor-talos.md) § Validity.

Three changes, one parked:

1. **Offer the deeper stop** — under the low of the whole fall, a price the stock has not traded under in a while.
2. **Offer the break scenario** — a second, ready way in for when price breaks up instead of pulling back.
3. **The away edge on every thesis setup** — so a trade that leaves without the user says so, and Mentor redraws it.
4. *Parked:* the split stop.

## The lens today, in one paragraph

A name with no setup of the user's → Mentor settles the direction and the timeframe, JUDGES the stop (under the sellers'
last swing down) and ONE target (where sellers last took over above) from `get_price_structure`, OFFERS a second target,
asks the user for their RISK LIMIT (the stop at most X% from the entry) and their minimum REWARD TO RISK, and
`get_entry_level` computes the highest entry worth paying — the entry leg is "that level and below". Then the size (at
the level), then how long it waits (`valid_until`). Talos reads the 1h / 4h closes and proposes the entry when price at
or under the level shows strength. One scenario. No validity range.

## The two examples

### GNRC (day chart, 2026-11-02, close 206.20, ATR 10.94 = 5.3%)

Swings: lows 173.25 (Sep 16) → 193.96 → 186.08 → **181 (Oct 28)**; highs 231.89 (Sep 17) → 228.78 → 204.28 → 212.81.
Sellers in control since Oct 16; the last break (Sep 17, +18% on 8× volume) was a reversal.

- **The structure stop:** under the 181 low with noise room and under the round 180 → **~177** (the rule's
  `candidates.stop` 178.81).
- **Roy: "I want the stop at a price it hasn't visited for a while."** On this chart that means under the low of the
  whole fall — 173.25 — and under the February 5 low 169.85: GNRC last traded under 169.85 on 2026-02-05, nine months
  ago. → **~169** (the rule's `candidates.deep_stop` 171.06; deeper, to clear February too).
- What it costs, at an illustrative 8% risk limit and 1.5 minimum R:R to a 228.78 target: the entry level falls from
  **192.39** (stop 177) to **183.70** (stop 169) — a deeper pullback before the trade exists, and fewer shares for the
  same dollars at risk.

Mentor's prompt NAMES `candidates.deep_stop` and never offers it. Roy got the deeper stop only by asking. → change 1.

### NXST (setup `setup_NXST_051350ab` on axl_dev, paper)

The setup: entry **164.70 and below**, stop **153.17**, target **221.25**, R:R 4.9, 17 shares on a $200 risk budget,
`validity: null`, `valid_until` 2027-04-23. 164.70 is exactly a **7% risk limit** on the 153.17 stop — the user's limit.

The timeline, from the day bars:

| Date | Close | What happened |
|---|---|---|
| Oct 5 | 156.66 | the low of the fall from 197.60 (Aug 7): **153.17** |
| Oct 16 | 164.59 | a swing high: **169.66** |
| Oct 19 | 165.80 | a HIGHER low: **162.52** (confirmed Oct 21) |
| Oct 29 | **170.10** | the close over 169.66 — buyers take control (a reversal) |
| Oct 30 | 171.44 | **the setup is built** (saved 2026-10-31 04:14 UTC) |
| Nov 2 | 173.31 | 5.2% over the entry, moving away |

**What went wrong, in order:**

1. **The stop was the wrong one for the chart as it stood.** On Oct 30 the break had already happened; the sellers' last
   failed push was the 162.52 higher low, not the 153.17 low of the whole fall. This is the NXST case the prompt already
   cites (2026-10-31: "took the house's six-month valuation for the target and the whole fall's low for the stop"), fixed
   in the prompt since. With the right stop (161.61) and the same 7% limit the level is **173.77** — over the 171.44 close
   the day it was built. Talos would have been waiting for strength, not for a 4% fall. The trade was not missed because
   the lens is strict; it was missed because the stop was deep and nobody said what that would cost.
2. **Nothing told the user it left.** With no validity range there is no away edge, Generate never asks "and if it just
   goes?" (`missing_runaway_answer` is gated on a range existing — `setup.schema.js` readiness), and Talos never posts
   `ran_away`. The setup sits "looking" in silence until April. → change 3.
3. **Had it been built before Oct 29**, everything a second way in needed had already printed — the 169.66 break line
   and the 162.52 higher low — and the lens writes one scenario only. → change 2.

## Change 1 — offer the deeper stop

**The rule (prompt § The thesis lens, step 2), worded like the second target's:** after judging the structure stop, OFFER
the deeper one, never set it unasked — under the low of the whole fall (`candidates.deep_stop`, with room for noise), a
price the stock has not traded under since <date>. Say it as a choice with its cost, in numbers:

- the stop X% from the entry instead of Y%;
- the entry level lower (both levels, from `get_entry_level` — two calls, never computed by hand) — and if the deeper
  level sits well under today's price, say plainly that the trade may never fill (NXST);
- fewer shares for the same risk.

And what was tested: the stop's depth did not move the edge (stock-playbook.md Test 1b, `stopAt: 'low60'`). The deeper
stop buys room against a shakeout — a retest of the low — not a better trade. Taken → the stop is the deep one; declined →
the structure stop. The go-all-the-way paragraph names it as on offer, like the second target; it is never taken on the
user's behalf.

**One new fact for the tool, so Mentor never guesses a date.** `structureFacts` (`services/swingStructure.service.js`)
adds `deep_stop_last_traded`: the last date BEFORE the fall's low on which the low was under `candidates.deep_stop`
(null when the history has none — "not in the two years read"). `unmirrorFacts` carries it through on a short (where the
question is the last time price traded OVER the deep stop).

## Change 2 — offer the break scenario

**When it applies (all three, read off `get_price_structure`):**

- sellers are still in control (`control: 'sellers'`) — the break up has not happened;
- the last swing high is close enough to matter — the break line;
- a HIGHER LOW has already printed under it (a confirmed swing low above the fall's low).

**Then OFFER scenario B beside A, never set it unasked:**

| | A — the pullback (today's lens) | B — after the break |
|---|---|---|
| Arms | now | a DAY close over the last swing high (a scenario condition, judged by Talos on the close) |
| Stop | the structure stop as today (or the deep one, change 1) | under the higher low, with noise room |
| Entry | `get_entry_level` on A's stop | `get_entry_level` on B's stop — the SAME user limits, one question for both |
| Target | from the chart | from the chart — the next sellers above the break |
| Then | strength at or under the level on the 1h / 4h | the same |

Both are **alternatives** — the existing default: the first to fill takes the full size, the other is cancelled. Each is
sized on its own stop (`size_position` per premise already does this).

**B is not "buy the breakout".** It enters on the pullback to its level after the break, which is exactly the tested
trade: in Test 1b the SIGNAL is the first close over a confirmed swing high and the entry is the level within 20
sessions. Buying the break itself at market is untested and the playbook argues against it (at the top of a range the
reward is about the risk). A is the trade taken BEFORE the signal — the less-tested one of the two. Mentor says the
context of the break as the lens does today (`last_break.context`; reversal is the one with the edge).

**Where B must NOT be offered:** when no higher low has printed. B's stop would then be a level for structure that does
not exist — the prompt's own rule ("you do not author levels for structure that has not printed", § `on_away`). Change 3
covers that case.

The prompt's "Both ways armed is a different request" paragraph already allows a second scenario when the USER asks for
both; this makes the lens OFFER it in the one shape where both levels exist today.

**The NXST numbers, had it been built on Oct 28** (close 164.50): B arms on a day close over 169.66, stop 161.61 (the
rule's candidate under 162.52), target 190.49 (the Aug 14 high) → at the user's 7% limit the level is 173.77 (R:R 1.37 at
the level); with a 1.5 minimum R:R it is 173.16. The Oct 29 close of 170.10 arms it, already under the level.

## Change 3 — the away edge on every thesis setup

Every thesis scenario gets a `validity` range, and so — through the existing gate — the runaway question.

- **`approach`** (the away pivot) = the next structural high above the price at build: the last swing high when sellers
  are in control (A's away edge is B's arming line — consistent: if B exists, A running away is B arming); the recent
  high when buyers already are — always that high, however close (§ Decided 2).
- **`lower`** = at or above the stop (the existing rule: never under it); `upper` between the entry and `approach`.
  The ordering check (`stop ≤ lower < entry < upper ≤ approach`) and Generate's refusals apply unchanged.
- **`timeframe`: `day`** — a swing is killed by a day close, never an intraday wick (§ validity).
- **`on_away`**: asked once, as the prompt already words it — *"this needs price to come back to 164.70. If it just goes
  instead, want a ping to redraw it, or do you let it go?"*. `revise` → `ran_away` card → the plan reopens in Mentor;
  `pass` → `ran_away_fyi`.
- **`on_break`**: `revise` (the default) — the premise broke.

**The redraw is the lens again, on the new chart — never a chase.** The stop under the NEW higher low, the target from the
chart, the SAME user limits through `get_entry_level`. If the new level sits over today's price, Talos waits for
strength there; if the redraw fails the user's limits, Mentor says so and the honest answer is to let it go. Nothing is
pre-authored for the runaway (mentor-talos.md § Validity — unchanged).

With B in the setup, A's away edge needs no ping of its own (B is the continuation, already drawn) — `on_away: pass` for
A, and B carries its own range.

## Parked — the split stop

Roy (2026-11-02): "we will leave split stop." Half at the structure stop, half at the deep one, the same risk budget.
Recorded because the schema cannot hold it: stop legs carry no `share` (entries and targets do), and `stopEdge`
(`setup.schema.js`) sizes the whole position off the FURTHEST stop. Today it is two setups, each half the risk — with the
quirk that each gets its own entry level. Natively it needs `share` on stop legs through the schema, sizing, the summary,
the broker's stop orders and Talos's exits.

## The build, when Roy says go

| Piece | Where |
|---|---|
| Lens steps 2 and 3, the go-all-the-way paragraph, § The setup you write for Talos (validity + both scenarios) | `prompts/mentor_system_prompt.md` § The thesis lens |
| `deep_stop_last_traded` (+ the short's mirror) | `services/swingStructure.service.js` `structureFacts`, `services/tools/thesisStructure.tools.js` `unmirrorFacts` |
| B's arming condition: a day-close condition on the scenario | the scenario's `conditions` — check Talos reads a scenario condition as the gate before its level is live (`talos.assess.js`, a wake judges root ∪ the armed scenario's) |
| No new schema | `validity`, `on_away`, alternatives and per-premise sizing all exist |

**Tests:** the facts field (a fixture where the deep stop was last traded under months ago, and one where never);
prompt assertions in `tests/unit/thesisLens.test.js` (deep stop offered not set; B offered only with a printed higher
low; validity + `on_away` on a thesis setup); readiness on a thesis setup now asks the runaway question.
**Drive:** a Hotlist build on a name in each shape (sellers in control with a higher low → A + B offered; buyers already
in control → A with an away edge), and a `ran_away` card reopening the plan.

## Decided (Roy, 2026-11-02)

1. **"Close enough" for the break line (change 2): any** confirmed swing high over a confirmed higher low; Mentor judges
   whether to offer B. No ATR distance.
2. **The away pivot when buyers already control (change 3): the recent high, always** — no minimum distance, even when
   it sits just over the price and pings soon after Generate (Roy chose this over a 1-ATR floor).
3. **The live NXST setup: redrawn at the END**, after the build — as the build's first real case, not before it.

## Built (2026-11-02)

- **Prompt** (§ The thesis lens): step 2 offers the deeper stop with its cost and date; new step 4 offers the break
  scenario B; steps 5–8 per scenario (one limits question, one level per stop, one size question); new step 9 — every
  scenario's `validity` and the runaway question; the go-all-the-way paragraph names all three offers; § The setup you
  write for Talos — conditions per scenario (B's arming one `measured` + `latching`), A first.
- **`structureFacts`** — `candidates.deep_stop_last_traded` (the short's mirror reads the same field); the
  `get_price_structure` description says so (snapshot fixture updated).
- **Readiness** — a thesis premise without `validity` is missing `validity range` (`setup.schema.js`). Existing thesis
  setups without one (NXST, PENG on axl_dev) now REFUSE a re-arm (`cannot_arm_missing_validity_range`) until redrawn.
- **Found while building — `thesisGate`** (`monitoring/talos.gates.js`, wired in `_checkSetup`): the pre-entry read
  judges ONE premise — the one at an exact level or a fired guard, else `scenarios[0]`. B would never have been read.
  A thesis setup's premise on the table is now the live scenario whose level price is at or past, the nearest one when
  past several. Only `trade_mode: 'thesis'`; other lenses unchanged.
- **Tests:** swingStructure (the date, the short), thesisLens (prompt assertions, readiness, the gate both sides),
  talosMonitor (a wake under B's level reads B and fires B's leg; over every level, no hit). Suite 4811/0 (without
  talosRecorder.test.js); lint clean.

**B only when the break changes the stop (Roy, 2026-11-02, before the drive).** Found while picking drive names: when
A's structure stop is already under the higher low (NXST on Oct 28 — its last swing low WAS the 162.52 higher low;
GNRC today — 181), B has the same stop and so the same level: A plus one condition, nothing gained. Roy: "B adds value
if Mentor sees that a break up will change the stop." Step 4 now requires B's stop clearly over A's (A on the deep stop,
or under an older, lower swing). On Oct 28 NXST's structure stop alone (161.6, level 173.77 at 7%) would have filled.

**Bug-hunt fixes (same day):** a `pass` runaway card names the other scenario still armed (the ran-away one stays
live, so it is not counted); Talos's ARMED LEVEL line on a thesis setup says "at or under it — the level and below",
not "standing on it". Suite 4813/0.

**Not done:** the browser drive (needs the dev backend restarted — Roy); redrawing the live NXST setup (§ Decided 3).

## The drives, and the facts moved into code (2026-11-02/03)

Drives 1–5 tuned the prompt; Mentor still guessed the deep stop's date ("since September 8", read off 40 candles —
the bars say Feb 5) and never offered B. Prose stopped there, so the facts moved into code:

- **`get_entry_level` takes the ticker** and says when price last traded past the stop it was given (two years of
  days; `lastTradedUnder` in swingStructure.service, shared with the deep stop's own date). Commit 9ca914d.
- **`get_price_structure` carries `break_candidate`**: sellers in control, a swing low printed after the fall's low
  and still holding, a swing high over the price. "Higher low" is measured against the FALL's low, not the swing low
  before it — GNRC's lows step down 194 → 186 → 181, yet 181 is the higher low over 173.25. Commit 9ca914d.
- **The turn is told** (mentor.agent.service `_readThesisFacts`, at the ENTRIES stage of a thesis trade only): THE
  RISK READ — each stop's distance from today's close in % and in normal moves, said before the limits are asked
  (Roy, 2026-11-03: "give Mentor the read of risk before the user is asked for his limit") — and THE BREAK SCENARIO,
  whether the worksheet's stop makes B on offer this turn ("clearly over" = the stop's own noise buffer,
  STRUCTURE.buffer × ATR). Drive 8: B offered the turn the deep stop was taken.

**B's entry (Roy, 2026-11-03)** — this replaces "B is not buying the break at market" above. B arms on the day close
over the swing high; its level is `get_entry_level` on B's stop with the user's limits. At or over the swing high, the
break price is inside the limits to the new stop, so the break IS the entry; under it, B waits for a pullback to the
level after the break. Both are B. Drive 8 refused B for a level under the line, pricing it at the break with an R:R
of its own (GNRC, 8% / 1.5: level 194.36 under the 212.81 line → B = the break, then the pullback to 194.36). The
entry on the break itself is untested; Mentor says so once.

## Noted for later — more facts for the stop and the targets (Roy, 2026-11-03)

Roy asked whether Mentor reads short interest, options, dark pools or the prices institutions bought at when it judges
the stop and targets. It does not: the lens reads the chart alone (`get_price_structure`, candles, chart). Noted, to
build AFTER the B / risk-read drive, as facts Mentor judges (none was tested for edge):

1. **The implied move** — ATM implied vol from `get_options_context`, over the trade's horizon: is the target
   reachable inside the wait, is the stop inside the noise. Data already in the kit.
2. **Short interest for B** — a crowded short makes a close over the swing high likelier to run (break entry vs
   pullback). Data already in the kit (`get_short_interest`); the prompt never ties it to levels.
3. **Where big money traded** — an anchored VWAP from each heavy-volume day `get_price_structure` already lists (the
   standard proxy for big buyers' cost basis: over it they defend, under it they are trapped), and maybe a volume
   profile (the bands most volume traded at). Computed from the same day bars — no new data. Recommended first.
4. **Options walls** — open interest by strike near the target or stop. New data (the options tool has only the P/C
   ratio and ATM IV).
5. **Institutions' 13F** — `fund_holdings` (aether) holds quarter-end positions, never a purchase price; an add's cost
   is only estimable as that quarter's average price, 45 days late. Long-term (weekly) context at best, and the 13F
   CUSIP bug (project_13f_data_quality) comes first.
6. **Dark pools** — no data source (Aether mission 5, B3, deferred).
