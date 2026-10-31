# Run-up reads — Prometheus asks the rule's two questions

**Status: BUILT + CODE-REVIEWED 2026-10-31 (§8), branch `feat/runup-reads` (both repos), committed, not merged or pushed.** Unit-tested both
repos; the 11 names of `hb_2026-11-02_week` re-read through the real pipeline on axl_dev (9 confirmed, all exits; LINE and
SGI not worth it — NOI down / guidance cut under the beats; $0.30); This week driven in a browser
(`scripts/drive-hotlist-runup-reads.mjs`, 6/6). Open (§7). Roy: "in hotlist - week run up - why no names?"
→ the rule listed 11 names for 2026-11-02 (9 for 10-30) and Prometheus passed on every one, so This week's confirmed
list was empty. Roy: "Prometheus should confirm (a) this company had good reports — worth going into the run-up,
(b) is it worth to stay in the report", and on (b): "hold — and the target and grading running through earnings".

## 1. Why he passed everything

The 20 reads on the 10-30 and 11-02 boards: 9 `already_ran`, 8 `unclear`, 3 `no_target` — every one a pass.

1. **The wrong question.** The catalyst-read prompt asks a run-up read about the STOCK'S OWN run-up history
   (`get_runup_history`, ~11 reports). Eleven samples of a five-session move are noise around zero (OXY −0.56%, HRB
   −0.17%), so "the record is mixed — no defensible target". The rule's +0.39% a session (screener-lab.md §6–§7) is a
   POPULATION edge; no single name's record was ever its test.
2. **A veto the lab never had.** `runupSpent` (runup.tools) compares the five sessions BEFORE the entry with the stock's
   median ten-session run-up; when they match, the tool tells him "verdict priced_in" and `buildCatalystRead` drops the
   target whatever he writes. The median is often under 1% (CEG 0.79%, ELAN 0.47%), so an ordinary up week trips it.
   The rule buys five sessions out whatever the week before did.
3. **The reports themselves were never asked about.** Nothing asks how good the beats were — their size, revenue,
   guidance, the estimates since — which is what (a) is.
4. **A target was required.** No target of his = a pass (`no_target`), and on a run-up the only yardstick he had was
   (1).

## 2. The new read on a rule name (`context.rule`)

Two answers, in the `<catalyst_read>` block beside what is there today:

- **`run_up: { worth: true | false, why }`** — (a). Were the last reports GOOD — not just a beat on a lowered bar:
  the size of the beats, revenue with them, guidance raised or held, estimates rising since — and can the company carry
  it (`company`, unchanged: `broken` still kills it). The stock's own run-up record and this cycle's move are CONTEXT he
  may cite (a news spike that already took the move is a reason), never a code veto.
- **`through_report: { call: 'hold' | 'exit', why }`** — (b). Is the report itself worth holding: how the stock moved
  through its past reports (new: the tool's through-the-report record, §3), the options' implied move against it, how
  high this quarter's bar is (estimates raised into it, whisper), positioning.

**Confirmed** = `run_up.worth` and a company that is not `broken`, with a window left before the report. The target is
**optional** on an `exit` (Roy: "(a) yes, target optional"); a confirmed read with no target is `active` and graded on
its window's return (§4).

**A `hold` needs a target** — a trade through earnings can only be graded against one. A hold with no target, or one
too close to trade (`minOpenPct`), is kept as an `exit` and says so (`through_report.dropped: 'no_target'`).

Not worth it → a pass, `pass_reason: 'not_worth'`. A read with no `run_up` (an old-shaped answer) falls back to the
verdict: `credible` is worth it.

`verdict` stays (the scorecard and the cards read it): he still writes it, and on a rule read it says the same as (a).

## 3. The tool: the record THROUGH the report

`get_runup_history` adds the stock's move through each past report: the close of the last session BEFORE the report to
the close of the first session AFTER it — the reaction whether the report came before the open or after the close —
with the median, quartiles and up share, and the same over the reports that beat. Copied into the `runup` line as
`through_*`. The "already ran" line stays, worded as context ("say whether that changes your call").

## 4. Window, grade, record

| | exit (the run-up) | hold (through the report) |
|---|---|---|
| `valid_until` | the close before the report (as today) | the close of the first session after the report |
| `exit_before` | the report | null; `through_report.report` = the report |
| target | optional | required |
| graded | with a target: hit / expired as today. Without: at the window's end, `closed` with its return vs SPY | hit / expired against the target over the window, report included |

- **`closed`** is new: a confirmed read with no target, settled on its window (`outcome.basis: 'window'`, `hit: null`).
  It is marked by `markWindows` like the others.
- **The rule's own record is unchanged**: the board's outcome scoring (hotlist.outcomes) still measures the run-up as
  tested, out before the report. Prometheus's reads keep their own record (prometheusCalls `catalystRecord`): backed now
  counts `closed` too, the hit rate is over the reads that had a target, and holds and exits are split so his
  hold calls can be judged against the plain exit.

## 5. Hand-offs and the row

- **Mentor** (`readFacts`, `hotlistSeed`): a confirmed read without a target is still handed on ("confirmed for the
  run-up, no target of his — out before the report"); a HOLD says so and replaces the board's "the setup must be out
  before it" — the decision Mentor's prompt already asks for (out before it, or hold through it) arrives made.
- **The row** (FE): confirmed = not a pass. The earnings chip reads "E 11-09 · hold through" on a hold. The read line
  shows (a) and (b) with their reasons. `PASS_WHY.not_worth`.
- **The opening** (`researchOpening`, both repos' copies) asks the two questions for a rule name.

## 7. Open

- **A rubber stamp?** 9 of 11 confirmed on the first board — every rule name already has three beats. The scorecard
  (backed vs passed, each to its window's end) is what says whether (a) adds anything; watch it before tightening.
- **The options' implied move can miss the report.** `get_options_context` reads the nearest expiry, which can end
  before the report (CEG, 11-06 vs a 11-09 report) — then (b) has no implied move for the event. The fix is an expiry
  after the report; not built.
- **Two sessions through a pre-market report.** The through-the-report record has no report time, so a report before
  the open counts its day and the next.

## 6. Not in scope

The run-up rule itself (the board) — unchanged. Argus — not in the week. Holding through earnings as a NEW tested rule —
his hold calls are graded so that question can be asked later, with numbers.

## 8. Code review (2026-10-31)

Ten findings, all applied; suite 4760/0, FE 231 + 43, drive 6/6.

1. **A weekend read saw a window that no session could trade.** `readValidUntil` ended the exit at 21:00Z on the
   calendar day before the report — a Sunday for a Monday report — so a Saturday read was confirmed. It now ends at the
   close of the last SESSION before it (`hotlist.outcomes lastSessionBefore`). This also moves event reads' windows
   (Friday, not Sunday); their grades read the same bars. The reads stored before the fix keep their Sunday end.
2. **The hold never showed.** The list rebuilds the Earn cell from its own pieces, so "hold through" did not reach the
   screen. The cell now reads "11-09 hold", and the row page shows the hold line.
3. **`by_call` mixed in event reads** as exits. Only reads that made the call are counted now.
4. **`worth: true` beside a contradicted or priced-in verdict was confirmed.** (a) and the verdict must now agree:
   confirmed needs `credible`, and the read is stored as not worth it.
5. **"Through the report" could be priced off today's unfinished bar.** Today's bar is now dropped, as `soFarPct` does.
6. **A rule read with no report date was confirmed for 30 days.** It is now a pass, `no_report`.
7. **The drive picked reads its own way**, so it could fail a correct page. It now imports the FE's `readsBySymbol` /
   `isConfirmedRead`.
8. **A pass showed "The report: out before it".** That line is shown only on a confirmed read now.
9. **A second weekday walk.** `_nextWeekday` was replaced by `hotlist.outcomes sessionsAfter` — one calendar.
10. **A wasted quote every hour for each read with no target.** It is skipped.
