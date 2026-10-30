# Stock playbook — how to trade THIS stock

**STATUS: DESIGN ONLY (2026-10-30).** Nothing built. Branch `feat/stock-playbook` (from main). Supersedes the
one-ticker pattern test in [future-projects.md §5](../future-projects.md#5-test-a-pattern-on-one-tickers-history--with-the-lab-we-built)
— Roy restarted the question from scratch ("forget what we discussed until now").

Roy (2026-10-30): "I want a learning system that will get to know the stocks the user points at — and will say: this is
the way to trade this stock."

## What it is

**An agent that gives inputs to a calculation system, gets the outputs back, and gives the verdict** — plus a memory per
stock and a grading loop, which is what makes it LEARN.

1. **The agent** (Mentor, through tools) turns the user's ask into inputs: the stock, what to test.
2. **The calculation system** measures the stock and tests trading styles on its history — and judges the result by
   FIXED RULES, not by the agent's reading.
3. **The memory** keeps a file per stock: profile, playbook, verdict, evidence, date, and every past version with why it
   changed.
4. **The grading** checks every verdict and every current read against what happened next; the result goes back into the
   file and into a scorecard.
5. **The agent** explains it — and says "don't trade it" or "too little history" when that is the answer.

**Is it ML? Mostly no.** The profile is measurement and the playbook is backtesting. One stock has 30–100 examples of a
setup — an ML model fitted on that finds chance. Every "which stock goes up" model in the lab scored a coin flip held out
([screener-lab.md](screener-lab.md) §10, §18, the run-up meta-label); plain tested rules did better. ML is a LATER layer,
only across many stocks (stocks with this profile trade like that; families of similar stocks; regime-change detection),
and only if it passes a declared bar. The language model is the voice: it never computes or estimates a number.

## What "how to trade this stock" means — two layers

### Layer 1 — the playbook (how it trades, in general; changes when its character changes)

1. **Timeframe** — day / swing / long term. DECIDED BY THE VERDICT (Roy): the playbook says which timeframe the stock
   suits, not the user up front.
2. **Direction** — long, short or both (Roy: both are tested); and which, under which conditions.
3. **Entry style** — the setups with an edge on this name, and the ones that FAIL on it.
4. **When to trade it, when to stay away** — the conditions that make a setup work or fail.
5. **Stop** — from how far its winners went against the entry first; gap risk.
6. **Exit** — how far and how long its good moves ran; fixed target, trail, or time exit.
7. **Size** — from its volatility and the stop distance.
8. **Early failure** — its usual path after entry ("not up by day 4 → it usually doesn't work").

Every answer carries its evidence (examples, result, range, luck check) and a confidence — "not enough history" is an
answer.

### Layer 2 — the current read (what to do now; changes daily)

The playbook applied to today: in the entry zone / wait for X / stay away (earnings Tuesday) / a condition changed
(shorts +30%).

Roy: **both layers.** The playbook comes first; the current read depends on it.

## Inputs — "anything we can fetch" (Roy), options left out for now

To be TESTED, a factor needs its history stamped with the date it became KNOWN, or the backtest uses what nobody had.

| Source | Have | History to test |
|---|---|---|
| Prices, daily + intraday | FMP, Massive, Yahoo | daily from 2012; intraday shorter |
| Earnings (dates, surprise, reaction) | FMP | yes |
| Analysts (grades, targets) | FMP | from 2023 |
| Insiders | FMP / SEC | yes |
| Shorts (interest, daily short volume) | FINRA (`finra.provider`) | yes |
| Dark pool (ATS weekly) | FINRA | yes, published with a lag |
| Big funds (13F) | aether `fund_holdings` | yes — the CUSIP map bug (MSTR missing, commons on preferreds) must be fixed first |
| News | FMP news, GNews | headlines yes; a tested reaction needs an archive with event types |
| Sector / market regime | prices + `spyRegimes` | yes |
| ~~Options~~ | Yahoo snapshot only | **left out for now (Roy, 2026-10-30)** |

## Decisions so far (Roy, 2026-10-30)

- **Both layers**; the playbook first.
- **Timeframe** comes out of layer 1's verdict.
- **Long and short.**
- **Inputs:** technicals, news, shorts, big funds, anything fetchable — **options left for now**.
- **Runs on the laptop for now.** The deployed app and its db are a separate discussion.
- **A tool for Mentor**, not a new desk.
- New work branches from main.

## The trade rules — no setups, price areas (Roy, 2026-10-30)

Roy's approach: the daily chart, fundamentals and news say buy / sell / none; the STOP says when the stock becomes a sell;
the risk limit, the stop and the target then give the entry prices. No setup menu — a price area, and strength.
Described for longs; shorts are the mirror.

**The stop — below the professionals' stops.** When a sell phase ends the professionals buy first, then a gradient of
less informed money higher up, each with stops under it. The stop goes under the deepest layer that still means "the
turn is alive": below the BASE that followed the last sell phase (its low, and any spring — a brief break below the range
that closes back inside), plus a buffer learned per stock (how far this stock usually pokes through a level before it
reverses). A price not visited for a while; price there means the professionals stopped defending — the stock is "too
cheap", a sell. Prior art: Wyckoff accumulation (selling climax → base → spring), change of character, supply/demand
zones, Weinstein's stage base, Minervini's base low.
- **One stop** to start, and test it (Roy). No separate hard stop yet.
- Measured on: the low of the last sell phase (heavy volume); the base after it and its low; the professionals' cost
  (the base's volume profile / an anchored VWAP from the low); signs the buying was real (heavy-volume days that hold,
  dark-pool volume rising, funds adding, shorts covering).

**The target.**
- Selling overhead: the mirror — just under where the professionals' last DISTRIBUTION began (the base before the last
  fall), before the crowd's sell orders.
- At its highs (nothing overhead): a MEASURED MOVE — the current range's height added to the range's high (Roy; the
  classic range projection).

**The entry — all three:**
- A. Entry → stop within the risk limit.
- B. The verdict is buy and the chart shows strength (after a pullback, strength first — no falling knives; already in
  the area → enter now).
- C. Reward to risk ≥ 1.5 (an example value).

What C does with a measured-move target: base low L, high H, height h, buffer b — target H + h, stop L − b. R:R ≥ 1.5
holds only for an entry ≤ (H + h + 1.5(L − b)) / 2.5 — with b = 0.1h, the lower ~74% of the range. Buying the top of the
range or the breakout fails C (risk ≈ h + b, reward ≈ h): the rules buy in the range, near the professionals' cost.

**Exit:** the stop; the target; or the verdict turns to sell while the trade is not working ("not working" to define).
**Management:** a tool to cut risk or raise R:R — averaging only inside a fixed total risk to the stop, planned ahead.

**Learned per stock:** the buffer; how often price broke the base low and still rallied (the stop was wrong) vs broke
down for real; how often the target came before the stop (at 1.5, a hit rate above 40% just breaks even).

## Pieces to build

1. **Calculation engine** — the profile per timeframe; the playbook tester (a fixed menu of setups, long and short, per
   timeframe, against the stock's ordinary days and the market, with the luck check and a minimum count); conditions;
   stop / exit / size from the evidence; the fixed verdict rules. The lab's `screenerLab.service.js` (indicators,
   setups, cost model, `trade`, `spyRegimes`) is the start — built to scan all stocks, to be reshaped around one.
2. **Memory** — one document per stock, versioned.
3. **Current read** — on demand, or daily for the stocks with a file.
4. **Grading** — every verdict and read logged and graded; a scorecard per stock and overall.
5. **Mentor's tools** — e.g. `get_stock_playbook`, `test_setup`, `get_current_read`; the prompt keeps him from
   overriding the numbers.
6. **The view** — the stock's file, playbook, evidence, today's read.

Suggested order: (1) profile + playbook on prices and earnings, one stock end to end, with Mentor's tool; (2) shorts,
insiders, funds, analysts as conditions; (3) the current read; (4) grading; (5) news, then options once their data is
solved.

## Open — next to discuss

- The setup menu: which setups, which settings, per timeframe and side.
- The verdict rules: the bar a setup must clear (vs ordinary days, vs the market, the luck check, minimum examples).
- The profile's exact measures.
- What the file looks like and how a version changes.
- How Mentor uses it inside a trade plan.
