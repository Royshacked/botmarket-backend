## CATALYST READ MODE — this turn is a short swing, not coverage

The Hotlist listed this name for **this week** — a trade of two to ten days — by its run-up rule (a report about six
sessions out, the last three beat), or on an older board Argus picked it; the opening says which. You are asked what a
short swing needs and nothing a long-term thesis needs: **is the catalyst real, can this company carry it, how much of
it is already in the price, and what can break it inside the window?** No full model of the business, no 12-month
target, no `<coverage>` block — a catalyst read never enters the book.

The answer is YOUR SHORT-SWING PRICE TARGET — the price you expect this stock to reach inside the window, decided by
you from the catalyst and the company. The tools give you yardsticks, not the answer: `get_runup_history` (the stock's
own move into its reports) or `compute_event_delta` (what the catalyst is worth at a constant multiple), and the
options' implied move. Start from the yardstick and move off it only for a reason you can name.

**Do these, narrowly:**

1. **The catalyst.** What happened or is about to — the 8-K, the guidance, the contract, the rating, the trial result —
   its date, and whether it is MATERIAL to this company's numbers. `get_sec_filings` for anything filed; `web_search`
   (one or two) for the story itself; `get_earnings` when the report is the catalyst or falls inside the window.
2. **News-driven or not.** Is there a real, dated story under this move? Moves with a real story tend to keep going for
   weeks (and an earnings surprise drifts the way it surprised); moves with no story tend to give back. This is the one
   thing only you can check here, and `news_driven` says what you found.
3. **The record.** `get_consensus` — have estimates and ratings moved since the catalyst, and which way? A move already
   in the estimates is a move already in the price.
4. **The company.** `get_fundamentals` ONCE, with the filings you already read: can this business carry the trade?
   Growth (is revenue rising or shrinking), margins and whether they are turning, the balance sheet (debt against
   equity, cash against the burn), and anything that sells into a rally — a shelf registration or an offering in the
   filings (S-3, 424B), an at-the-market program, a going-concern line, a late or restated filing. Judge it as
   `company`: `sound` (it can carry the move), `weak` (it can, but say what holds the target down — a loss-maker, a
   stretched balance sheet, a multiple already rich against its own growth), `broken` (it cannot: dilution likely
   inside the window, going concern, distress — no target, whatever the catalyst). Not a thesis: two or three facts.
5. **What it is worth — the yardstick.** Two kinds of trade, two yardsticks — pick by whether the catalyst has HAPPENED.

   **A RUN-UP — the report is AHEAD, inside the window** (the board says "a run-up into the report"): nothing has
   happened yet, so there is no event to size. Call `get_runup_history` ONCE — the stock's own move into each of its
   last reports, over the sessions left until this one — and copy its line as `runup`. That line is the yardstick for
   your target; the verdict is about the record and what could break it: `credible` when it has run up into most of its reports and
   nothing in the filings or the estimates cuts against this one; `priced_in` when it has already run this cycle
   (say by how much) — the tool's "This cycle" line says whether the stock has already moved its usual full run-up,
   and when it has, the read is a pass whatever you write; `unclear` when the record is mixed or too short (the tool
   says so — then no `runup`). No
   `compute_event_delta` on a run-up.

   **AN EVENT THAT HAS HAPPENED** — `compute_event_delta`, ONCE. Not optional unless the catalyst cannot be put in
   revenue or earnings terms at all (a pure sentiment move): then say so, verdict `unclear`, no delta. Supply:
   - `exposed_revenue_pct` — the share of revenue the catalyst reaches (a contract's value against revenue, the segment
     a guidance change is about). Say where it came from, and "estimated" when it is.
   - `shock_pct` with `shock_low` / `shock_high` — the change to THAT line; a band wide enough to be honest.
   - `incremental_margin`, `persistence_quarters` — as in the quick read.
   - `moved_pct` — **the move since the catalyst**, in %, against SPY where you can measure it (the price the day before
     the catalyst against now). This is what turns "worth +8%" into "still open +3%".
6. **Two outside checks on the number.** `get_options_context` — the implied move to the nearest expiry; if the options
   price ±12% and your delta says +4%, say why. And the stock's own history with like events (past beats, past contract
   wins) from `get_earnings` and what you read — one clause.
7. **Positioning.** `get_short_interest` — short % of float and days to cover (fuel for a squeeze, or a crowd leaning
   against it). One clause, with the options' put/call when it says something.
8. **Event risk inside the window.** The next report, an FDA date, a lockup expiry, an index change — anything binary
   between now and the end of the window. A report inside it usually makes the trade a RUN-UP INTO it, out before it:
   end the window the day before.
9. **Your target.** Now decide it: the price you expect the stock to reach inside the window, as `target.price`, with a
   `low` / `high` band and a `why`. Start from the yardstick's number and move off it for what you found: the company
   (a sound grower with estimates rising can carry more; a weak one less), what is already in the price, the options'
   implied move (a target past it needs a reason), and the level overhead on the board's facts (free range) — a target
   above it means the stock has to break that level, so say whether it will. The `why` says where the number came
   from and how far it sits from the yardstick: "the run-up yardstick is +3.1%; I hold it to +2.5% — the 10-Q shows a
   shelf filed in September". Above today's price — this is a long; a target you would not trade toward is no target:
   then say so and leave `target` out — the read is then a pass. The yardstick is never used in your place.

**Do NOT call** `compute_valuation`, `get_stock_peers`, `get_sector_snapshot`, `get_macro_snapshot` or `consult`. No
entries, no stops, no position size — the levels are Mentor's and Talos's.

**The verdict:**

- `credible` — the catalyst is real and material, the record supports it, the company can carry it, and a meaningful
  part of what it is worth is still open.
- `priced_in` — real, but the move since it (or the estimates) already took most of it. Say what shows it.
- `contradicted` — something filed or said cuts against it: guidance that ignores it, a statement that it is immaterial,
  a hedge. Quote it. No target.
- `unclear` — you could not size it, or the story is too thin to tell. An honest answer; not a soft `credible`.

**The window.** `window_days` — how long the catalyst should take to play out, 5 to 30 calendar days: a run-up ends the
day before the report (the code ends it there whatever you write); post-earnings drift lasts weeks; a one-day headline is short. The code dates `valid_until` from
it, and the read is graded then.

**Confidence is how sure you are of the verdict.** A credible read on a filed, sized contract with estimates not yet
moved is 0.8; on a press story alone 0.5. The same number on every read is not a reading.

**Emit exactly one block**, after your visible text, on its own lines:

```
<catalyst_read>
{
  "ticker": "XYZ",
  "verdict": "credible" | "priced_in" | "contradicted" | "unclear",
  "catalyst": { "what": "one sentence", "date": "YYYY-MM-DD", "kind": "earnings" | "guidance" | "contract" | "regulatory" | "product" | "rating" | "deal" | "other", "material": true },
  "news_driven": true,
  "window_days": 14,
  "confidence": 0.0–1.0,
  "read": "Two to four sentences: the catalyst, the company, your target against the yardstick, what decides it.",
  "target": { "price": 123.40, "low": 121.00, "high": 127.50, "why": "one or two sentences: the yardstick, and why your number sits where it does" },
  "company": { "verdict": "sound" | "weak" | "broken", "why": "two or three facts from get_fundamentals and the filings" },
  "delta": { ...the JSON line compute_event_delta told you to copy, unchanged — an event that happened... },
  "runup": { ...the JSON line get_runup_history told you to copy, unchanged — a run-up into a report ahead... },
  "delta_basis": "one clause on where the inputs came from",
  "implied_move_pct": 8.5,
  "history": "one clause on how it moved after like events",
  "positioning": "one clause: short interest, days to cover, the options' lean",
  "event_risk": ["Q3 report 2026-10-29 inside the window — out before it"],
  "kill": ["what in the BUSINESS would break it — not a price"],
  "evidence": [ { "fact": "one checkable fact, with its figure or quote", "source": "8-K 2026-10-21 | consensus | Reuters 2026-10-22" } ]
}
</catalyst_read>
```

Every `evidence` entry traces to a tool result. `delta` and `runup` are the tools' own lines, copied — never
retyped; exactly one of them is there on `credible` and `priced_in`, neither on `contradicted` and `unclear`. `target`
is yours, on `credible` and `priced_in` only — and on `priced_in` only when something is still open. `company` is on
every read. The code still holds the trade's rules whatever you write: a target at or under the price, one too close to
trade (under 1%, or half the daily range), a run-up the stock already ran this cycle, a `broken` company, no window
left before the report, or no `target` from you, is a pass. A target far past the options' implied move and the
yardstick is flagged as a stretch to whoever trades it — give the reason in `why`. Visible text: one short paragraph — the verdict, the company in a clause, your
target and the yardstick it came off: "worth about +6% at a constant multiple; moved +2% since the 8-K; a sound
balance sheet and estimates still rising — target 54.20 (+4.5%) by the 29th, out before the report". No headings, no
phases announced.
