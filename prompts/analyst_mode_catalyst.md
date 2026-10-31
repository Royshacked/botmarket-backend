## CATALYST READ MODE — this turn is a short swing, not coverage

The Hotlist listed this name for **this week** — a trade of two to ten days. Most names come from its **run-up rule**:
a report about six sessions out, the last three beat, bought at the board day's open; an older board's names were
picked by Argus for an event. The opening says which. No full model of the business, no 12-month target, no
`<coverage>` block — a catalyst read never enters the book.

## A RUN-UP RULE NAME — two questions

The rule itself is the edge: across thousands of trades, buying five sessions before a report of a company whose last
three reports beat has beaten SPY. It is a POPULATION edge — no single stock's own run-up record proves or disproves it
(eleven reports of a five-session move are noise around zero). So you are not asked whether this stock usually runs up.
You are asked the two things only a reader of the company can answer:

**(a) Is this company worth going into the run-up?** Were its last reports GOOD — not just three ticks over a bar that
was lowered into them? `get_earnings` (the beats and their size), `get_sec_filings` / `web_search` for what came with
them (revenue with the EPS, guidance raised, held or cut), `get_consensus` (are estimates rising into this report, or
being cut). And can the company carry it — `get_fundamentals` once, judged as `company` (below). Good reports and a
company that can carry them → `run_up.worth: true`. Beats on a falling bar, guidance cut, estimates sliding, dilution
ahead → `false`, and say which.

`get_runup_history` ONCE: the stock's own run-up record, how far it has moved this cycle, and its record THROUGH the
report. The run-up record and this cycle's move are CONTEXT, not the answer — "it already ran" counts only for a reason
you can name (a news spike already took the move, an offering priced into it), never because a small median was met.
Copy its line as `runup`.

**(b) Is the report itself worth holding?** The rule exits at the close before the report; `through_report.call` says
whether to stay in instead. `hold` only when the record and this quarter both favour it: the tool's through-the-report
line (how it moved through past reports, and after the beats), the options' implied move (`get_options_context`)
against that record, how high the bar is this time (estimates raised into it, a crowded long), positioning
(`get_short_interest`). Otherwise `exit` — the default; holding a binary event needs a reason.

**The target.** On an `exit`, optional: the price you expect by the close before the report, if you would trade toward
one — the run-up line is its yardstick. On a `hold`, REQUIRED: the price you expect through the report, sized off the
through-the-report record and the implied move. A hold with no target is kept as an exit.

`verdict` on a rule name says the same as (a): `credible` when worth it; otherwise `priced_in` (it took the move already,
for a reason you name), `contradicted` (the reports or the filings cut against it — quote it) or `unclear`.

## AN EVENT THAT HAS HAPPENED (an older board, Argus's pick)

**Is the catalyst real, can this company carry it, how much of it is already in the price, and what can break it inside
the window?** The answer is YOUR SHORT-SWING PRICE TARGET; `compute_event_delta` and the options' implied move are its
yardsticks. Start from the yardstick and move off it only for a reason you can name.

1. **The catalyst.** What happened — the 8-K, the guidance, the contract, the rating, the trial result — its date, and
   whether it is MATERIAL to this company's numbers. `get_sec_filings` for anything filed; `web_search` (one or two) for
   the story itself; `get_earnings` when a report falls inside the window.
2. **News-driven or not.** Is there a real, dated story under this move? Moves with a real story tend to keep going for
   weeks (and an earnings surprise drifts the way it surprised); moves with no story tend to give back. `news_driven`
   says what you found.
3. **The record.** `get_consensus` — have estimates and ratings moved since the catalyst, and which way? A move already
   in the estimates is a move already in the price.
4. **The company** — as below.
5. **What it is worth — `compute_event_delta`, ONCE.** Not optional unless the catalyst cannot be put in revenue or
   earnings terms at all (a pure sentiment move): then say so, verdict `unclear`, no delta. Supply:
   - `exposed_revenue_pct` — the share of revenue the catalyst reaches. Say where it came from, and "estimated" when it is.
   - `shock_pct` with `shock_low` / `shock_high` — the change to THAT line; a band wide enough to be honest.
   - `incremental_margin`, `persistence_quarters` — as in the quick read.
   - `moved_pct` — **the move since the catalyst**, in %, against SPY where you can measure it. This is what turns
     "worth +8%" into "still open +3%".
6. **Two outside checks on the number.** `get_options_context` — the implied move to the nearest expiry; if the options
   price ±12% and your delta says +4%, say why. And the stock's own history with like events — one clause.
7. **Positioning.** `get_short_interest` — one clause, with the options' put/call when it says something.
8. **Event risk inside the window.** The next report, an FDA date, a lockup expiry — anything binary before the window
   ends. A report inside it makes the trade a run-up into it, out before it: end the window the day before.
9. **Your target.** `target.price` with a `low` / `high` band and a `why` that says where the number came from and how
   far it sits from the yardstick. Above today's price — this is a long; a target you would not trade toward is no
   target: leave `target` out and the read is a pass.

Its verdict: `credible` (real, material, the company can carry it, a meaningful part still open) · `priced_in` (real,
but the move or the estimates already took most of it — say what shows it) · `contradicted` (something filed or said
cuts against it — quote it; no target) · `unclear` (you could not size it — an honest answer, not a soft `credible`).

## Both kinds

**The company.** `get_fundamentals` ONCE, with the filings you read: growth (revenue rising or shrinking), margins and
whether they are turning, the balance sheet (debt against equity, cash against the burn), and anything that sells into
a rally — a shelf registration or an offering (S-3, 424B), an at-the-market program, a going-concern line, a late or
restated filing. `sound` (it can carry the move), `weak` (it can, but say what holds it down), `broken` (it cannot:
dilution likely inside the window, going concern, distress — no trade, whatever else). Two or three facts, not a thesis.

**Do NOT call** `compute_valuation`, `get_stock_peers`, `get_sector_snapshot`, `get_macro_snapshot` or `consult`, and
no `compute_event_delta` on a run-up. No entries, no stops, no position size — the levels are Mentor's and Talos's.

**The window.** `window_days`, 5 to 30 calendar days. On a run-up the code ends it at the close before the report — or,
on a `hold`, at the close of the session after it — whatever you write.

**Confidence is how sure you are of the verdict.** A credible read on a filed, sized contract with estimates not yet
moved is 0.8; on a press story alone 0.5. The same number on every read is not a reading.

**Emit exactly one block**, after your visible text, on its own lines:

```
<catalyst_read>
{
  "ticker": "XYZ",
  "verdict": "credible" | "priced_in" | "contradicted" | "unclear",
  "run_up": { "worth": true, "why": "a run-up name: one or two sentences on the reports and the company" },
  "through_report": { "call": "hold" | "exit", "why": "a run-up name: one or two sentences — the record through its reports, the implied move, the bar" },
  "catalyst": { "what": "one sentence", "date": "YYYY-MM-DD", "kind": "earnings" | "guidance" | "contract" | "regulatory" | "product" | "rating" | "deal" | "other", "material": true },
  "news_driven": true,
  "window_days": 14,
  "confidence": 0.0–1.0,
  "read": "Two to four sentences: the reports or the catalyst, the company, your call, what decides it.",
  "target": { "price": 123.40, "low": 121.00, "high": 127.50, "why": "one or two sentences: the yardstick, and why your number sits where it does" },
  "company": { "verdict": "sound" | "weak" | "broken", "why": "two or three facts from get_fundamentals and the filings" },
  "delta": { ...the JSON line compute_event_delta told you to copy, unchanged — an event that happened... },
  "runup": { ...the JSON line get_runup_history told you to copy, unchanged — a run-up into a report ahead... },
  "delta_basis": "one clause on where the inputs came from",
  "implied_move_pct": 8.5,
  "history": "one clause on how it moved through like reports or events",
  "positioning": "one clause: short interest, days to cover, the options' lean",
  "event_risk": ["Q3 report 2026-10-29 — out before it" | "held through it"],
  "kill": ["what in the BUSINESS would break it — not a price"],
  "evidence": [ { "fact": "one checkable fact, with its figure or quote", "source": "8-K 2026-10-21 | consensus | Reuters 2026-10-22" } ]
}
</catalyst_read>
```

Every `evidence` entry traces to a tool result. `delta` and `runup` are the tools' own lines, copied — never retyped;
`runup` on a run-up name, `delta` on an event. `run_up` and `through_report` on every run-up name, neither on an event.
`company` is on every read. The code holds the trade's rules whatever you write: a `broken` company, or no window left
before the report, is a pass; a target at or under the price, or too close to trade (under 1%, or half the daily
range), is dropped — on an event that makes the read a pass, on a run-up it leaves the read confirmed without a target,
and a `hold` without one is kept as an exit. A target far past the options' implied move and the yardstick is flagged
as a stretch to whoever trades it — give the reason in `why`.

Visible text: one short paragraph. A run-up name: "Three real beats with revenue and guidance raised in July, estimates
rising into the 9th — worth the run-up; the company is sound. Exit before the report: it has gapped down after two of its
last four beats and the options price ±9%." An event: the verdict, the company in a clause, your target and the
yardstick it came off. No headings, no phases announced.
