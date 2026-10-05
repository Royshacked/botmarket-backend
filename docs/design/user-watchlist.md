# The user's own list — the user picks the names, the app picks the moment

**Status: DESIGN ONLY, nothing built.** Discussed 2026-10-04. The trigger set (what "a good entry"
is made of) is deliberately not decided; this doc fixes the shape so it can be decided later
without a migration. Name not decided.

Relates to: `docs/desks/argus-scans.md` (the scan list this extends), `services/watchlist.service.js`
(the cross-kind "what am I watching" read), `docs/design/architecture-vision.md` (house vs per-user),
`docs/design/talos-per-candle.md` (the cost lesson), the payments memo on the trading-signals edge.

---

## The one line

**An entry-timing desk: the user chooses WHAT, the app tells them WHEN — and "go" means Mentor.**

Today Argus *discovers* names. Here the user brings them. Argus's job turns from picking to intake.

---

## 1. The flow

1. **Build** — the user hands Argus a list: names, a horizon, a direction.
2. **Enrich** — Argus validates each ticker and attaches a fundamentals snapshot and the expected
   catalysts (earnings, FDA dates, product events, filings). It annotates misfits ("short on a
   2-week horizon, but earnings land on day 3") and does **not** add or drop names — it is the
   user's list.
3. **Watch** — each name is monitored by rules derived from its horizon and direction.
4. **Alert** — "now is the entry window for X, because…". One tap hands the name to Mentor with the
   context pre-filled (the same seed path a scan pick uses today, `scanSeed.util`).

## 2. Shape

The existing scan list already is `{ period, thesis, direction, style, candidates[] }`. This is the
same document with a different source:

- `source: 'user'` beside the existing `'aether'`.
- **Horizon and direction per name**, the list's value as the default — traders mix ("long these
  three, short these two").
- **Horizon optional** — a scan goes stale by date; a user's "my semis" may be meant to stay.
- A `watch: []` slot per name (`{ type, params }`) — empty at launch, each trigger type plugs in.
- Per-name state: `alertedAt` (see §4) and the last enrichment.

Workspace: binds to no account, so like scans it is **shared across live / paper / manual**.

## 3. Watching — what "best time to enter" means

Horizon and direction decide what counts:

| | long | short |
|---|---|---|
| **short horizon** | pullback into a level, breakout on volume, catalyst near | failed rally, breakdown, catalyst near |
| **long horizon** | price / valuation zone, thesis firming, catalyst approaching | the mirror |

Two tiers, the Talos lesson:

- **Cheap data triggers** (price crosses, volume, a filing lands, news count spikes) run always.
- **An LLM judges only when one fires** — "is this the entry for THIS user's horizon and direction?"

The judgment of timing fits Mentor better than Argus. Argus builds the list; Mentor owns entries.

## 4. Alerts

- **Positive** — the entry window. Carries the reason and the hand-off to Mentor.
- **Ignored** — the name keeps a visible "alerted" mark (`alertedAt`) rather than vanishing or
  re-firing every tick.
- **Negative** — the catalyst passed or the thesis broke. The user decides whether to drop the name.

Transport: every alert goes through `postCard` (and push / email under it), each card built by its
own desk — the shared-pipe rule.

## 5. Centralised monitoring

User 1 lists a, b, c. User 2 lists a, d, e.

- **The data layer is house**: each ticker is watched ONCE however many users hold it. Cost scales
  with unique tickers, not users.
- **The judgment is per user**: the same move on `a` is an entry for a 1-week long and noise for a
  6-month short. The house layer emits events; each user's horizon and direction decide what they mean.
- **Cross-offer**: the house sees `d` hit an entry that fits user 1's usual horizon and direction →
  offer it to user 1, though it is not on their list. Nobody else does "a name you don't hold just
  hit an entry that fits your style."

Guards on the cross-offer:

- **Privacy** — never reveal that someone else watches the name. "Fits your 2-week long style",
  never "others are watching".
- **Regulatory** — an unsolicited "trade this" is the trading-signals edge from the payments notes.
  Frame as research ("this matches your criteria — take a look"), not "enter now".
- **Fit** — only on a match to that user's habitual horizon and direction, or it is spam.

## 6. Prior art

- **TradingView** — alerts sit on symbols, not lists; every rule written by hand.
- **Koyfin / Bloomberg monitors** — a list drives a news feed and calendar; news filtered to your
  names is most of the value.
- **Seeking Alpha** — a daily digest per list; cheap and liked.
- **TipRanks / Zacks** — list plus catalyst calendar, no entry timing.
- **Trade Ideas ("Holly")** — AI entry signals, but on its own names.
- **TrendSpider smart watchlists** — rule-maintained lists; the opposite direction.

The gap: the user's names + the app's catalysts + AI entry timing.

## 7. Open

- **Trigger set** — which data triggers per horizon type. Deliberately undecided.
- **List size cap** — monitoring cost grows with names; ties into tiers and payments.
- **Re-arm** — after an ignored alert, when (if ever) does the name fire again?
- **Who judges** — a Mentor-owned evaluator, or a new monitor that hands off to Mentor.
- **Cross-offer cadence** — how often, and whether the user can turn it off.
