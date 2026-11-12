# Proteus — the technical analysis desk (design, 2026-11-12)

Part of the desk rework (`docs/design/argus-rework.md` §1: Proteus = what this stock obeys technically, per horizon;
not picking, not levels). Branch `feat/desk-architecture`. Roy's talk of 2026-11-12; decisions in §8, history depth in §9.

## 1. The job

Given a name, Proteus says **how its price behaves**, per timeframe:

| | Question |
|---|---|
| A | Which indicators it reacts to, if any — moving averages, RSI, MACD, VWAP, volume |
| B | Which price patterns it plays out, if any — flags, cup and handle, head and shoulders… |
| C | Does it false-break levels before choosing a direction |
| D | Does it respect order blocks |
| E | Its ATR (and its typical gap) |
| F | Is it a day-trade name, a swing name, both, or neither |

"Nothing" is a valid answer and an honest one: most names obey nothing in particular on most timeframes.

## 2. Two halves, side by side (Roy, 2026-11-12: "both")

**The measured profile — code.** Counted from candles, no model:

- **A. Indicators:** every touch of the 20/50/200 MA (and VWAP intraday) — how often price held / reversed vs how
  often it held at a **random level** of the same distance (the baseline). RSI extremes and MACD crosses scored by
  what followed (N bars later, in ATRs). Volume: do moves on high relative volume follow through more than ordinary
  ones.
- **C. False breaks:** breaks of prior swing highs/lows (`smc.engine` `detectLiquidity` / `swings`) — the share that
  closed back inside, and how many bars until a direction was chosen.
- **D. Order blocks:** zones from `smc.engine` `detectOrderBlocks` — of those retested, the share that held.
- **E. ATR:** `swingStructure.atr` / `priceStats.atr`, as % of price; the typical overnight gap.
- **F. Day vs swing:** from E, the volume, and how clean A/C/D come out per timeframe.

Every number carries its **sample size**, the **baseline**, and an **out-of-sample check** (argus-rework §5.2): the
rule is found in the older part of the history and must still hold in the recent part, or it is reported as not
holding. A hit rate on 6 touches is said to be 6 touches.

**The visual read — the model.** Proteus looks at the chart now (`get_chart`, `get_orderblocks`,
`get_false_breaks`): **B (patterns)** forming or just completed, and the current picture of C/D. It claims no hit
rate for a pattern — that would need a coded pattern detector (later, if wanted).

Proteus writes the read: the profile's numbers interpreted in plain words, with the visual read beside them, and
which is which said out loud.

## 3. Timeframes

| View | Timeframes | Feeds |
|---|---|---|
| Day trade | 5-minute, 1-hour (+ VWAP) | intraday |
| Swing | daily, weekly | short term swing, swing, long term |

## 4. Who asks (Roy, 2026-11-12: all four)

1. **Mentor, before a trade** — argus-rework §2 step 3: pick → Prometheus → **Proteus** → Mentor. Chain code, the
   same wait-in-line and Generate gate as Prometheus's read (`mentorReads.service`).
2. **The user, in chat** — Proteus is a desk you can talk to: "how does TSLA behave?"
3. **Axl hands off** — "how does TSLA behave" routes to Proteus, as research questions route to Prometheus.
4. **The day boards, automatically** — every board name at 09:20 / 10:30 / 14:30 (the measured profile; see §8.2).
5. **The Pythia chain, nightly** — Argus's house-chain picks.
6. **Daedalus** — when it exists.

## 5. The read is shared and cached

The read binds to no account (like coverage): one per name per view, the house's. Re-read **weekly** (argus-rework
§2), so a name already read this week costs nothing whoever asks. The measured profile is recomputed in code on the
same clock (cheap); the written read only when the profile changed or the week rolled.

Mentor uses the read for levels (argus-rework §2: respects the daily 20 MA → the swing stop weighs the 20 MA next to
the swing lows). Argus's when (§3.4) reads it beside Prometheus's.

## 6. Tools

Proteus gets every chart tool there is: `get_candles`, `get_indicators`, `get_price_action`, `get_chart`,
`get_orderblocks`, `get_false_breaks`, `get_cycle_analysis`, the SMC tools (`get_fvg`, `get_structure`,
`get_liquidity`, `get_key_levels`), plus a new **`get_behaviour_profile`** (§2's measured profile). Argus's chart
tools move here once Argus is fully defined (argus-rework §4).

## 7. Model and face

- **Model:** the house chat model (`houseModels.service` `chatModel`), like every desk. Per-user model choice was
  removed 2026-09-21 (one selector, the admin's); bringing it back would be a decision for all desks, not Proteus.
- **Glyph:** his own SVG in the agent set (frontend `AgentGlyphs` / `agentMeta`), a hue, an intro line.

## 8. Decided (Roy, 2026-11-12)

1. **Board names:** the MEASURED profile on every board name, automatically (code, free); the WRITTEN read only when
   a name is opened (Mentor, chat, Axl). A written read on every board name would be ~8–25 names × 3 boards a day.
2. **Where it shows:** a **badge** on the Hotlist rows — what the name obeys, in a word or two (e.g. "20 MA",
   "sweeps lows", "nothing") — opening the read.
3. **Long only, for now** — like the rest of the app. The profile counts the long side: holds at support (an MA,
   VWAP, a bullish order block), sweeps of lows that turn back up, follow-through on up-moves. The short side is a
   later switch, not a redesign.

## 9. History depth (checked live, FMP, TSLA, 2026-11-12)

- **5-minute:** goes back at least a year (Nov 2025 served), but one call returns ~9 sessions (~550 bars). Three
  months of 5-minute bars = ~10 calls per name.
- **1-hour:** one call returns ~3 months (~440 bars); a year = ~4 calls.
- **Daily / weekly:** years, one call.

So the depth is there; the cost is calls. The intraday bars are **kept and topped up** (the first profile pages
back ~3 months, each weekly re-read fetches only the new week) — otherwise ~25 board names × 10 calls would run
into the provider's rate limit every week. Where they are kept (a collection, its size against the 512 MB Atlas
quota) is a build decision.
