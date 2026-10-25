# Hotlist — archive the day columns, rebuild This week on the run-up rule

**Status: BUILT 2026-10-25 — steps 1–3 done (the overnight week builder, the hand-off and the read side, the archive),
unit-tested both repos, driven in a browser against the dev server (`scripts/drive-hotlist-week.mjs`); NOT committed.** Roy: "I am thinking about archiving the short term part
of hotlist" → the day columns only; This week rebuilt on the run-up rule; Swing / Long term kept.

## 1. Why

The screener lab (screener-lab.md) replayed every short-term idea against SPY, each session once, three years with the
last held out. The day columns lost to their own pools (30 sessions: open −0.74%, tomorrow −1.98%); This week's base + RS
rule matched SPY (+0.24% a week against +0.23%). One rule held: the RUN-UP into a report — bought 5 sessions before it,
the last three reports beat, SPY over its 200-day, out at the close before the report (+0.39% a session over SPY,
4,639 trades; before +0.37%, held out +0.45%; blocks +0.31%, −0.10 … +0.72 — modest, just at the edge of the range).
Argus, replayed blind on 48 weeks with headlines and technicals, picked no better than he avoided (§9).

## 2. What goes, what stays

| | Today | After |
|---|---|---|
| Day columns (open, mid, eod, tomorrow) | Graded at 08:00 / 09:20 / 10:30 / 14:30 / 15:30, Argus reads each board | **Archived** |
| The five checkpoints | `dailyScreener.checkpoint.js` CHECKPOINTS, quotes + movers + news + Argus | **Archived** (the machinery) |
| This week | A passenger on the 08:00 / 09:20 boards: base + RS gates, extended-hours price, Argus's picks | **Rebuilt overnight** on the run-up rule (§3) |
| Swing / Long term | `houseBook.service.js` from the nightly stats | **Unchanged** |
| The nightly stats | `daily_screener_stats` | **Unchanged** (the producer of everything) |

## 3. The new This week — built once, overnight

After `runNightly` writes the stats, one pass (no live quotes — the rule needs none):

1. **The market gate:** SPY over its 200-day. Under it, the board is written EMPTY with the reason ("the run-up loses
   when SPY is under its 200-day") — never silently missing.
2. **The window:** names whose next report falls on the 6th session from tomorrow (bought at tomorrow's open, out at
   the close of the 5th — the lab's `runup(5)`), from the stats' `next_earnings` (the nightly calendar, 21 days).
3. **The streak:** the last three reports all beat (FMP `/earnings?symbol=`, one read per window name — ~20–80 a night).
4. **The gates:** price ≥ $5, 20-day dollar volume ≥ $5M (the lab's; the old week gate was $20M — kept as an option).
5. **Equal weight:** every qualifying name is listed; the edge is per session, a fixed daily budget split across them,
   not a ranking (screener-lab §7). The row carries its report date, the exit date, the streak, ATR %, the sparkline.
6. **Flags, not filters** (unproven, shown as cautions): days to cover 7+ (§14), a 20%+ week behind it, a gap up at the
   open (the user sees it at 09:30). **NOT BUILT** — the board writes no flags yet.

Board id `hb_<day>_week`, `columns: ['week']`, `checkpoint: 'overnight'` — the API's BOARD_ID regex already accepts it.
Outcomes: the existing week scoring (entry at the board day's OPEN — today it is the 09:20 mid — out at `exit_before`).

## 4. The archive (the Kairos pattern — archive/README.md)

**As built (2026-10-25), narrower than planned below:** moved whole — the checkpoint pass, the day replay and its script,
the news labeller (after the code review), their tests. NOT split: `hotlist.columns.js`, `hotlist.outcomes.js`,
`hotlist.argus.js` stayed live and whole (pure, or still needed: the boards in Mongo age out over 10–168 days, the lab's
Argus replay calls argusRead). The frontend's day views stayed live too, shown only on a past day that has day names —
nothing moved to the frontend's `archive/`. The plan as written follows.

- **Moved whole** to `archive/`: `hotlistBacktest.day.js`, `scripts/replay-hotlist-day.mjs`, `tests/unit/hotlistBacktestDay.test.js`.
- **Split** (the day parts to `archive/`, the shared and week parts stay live): `dailyScreener.checkpoint.js` (CHECKPOINTS,
  the session branch of `boardRow`, movers, the pool's day sources), `hotlist.columns.js` (the open/mid/eod/tomorrow
  cases of `inPlay`, `relativeVolume`), `hotlist.outcomes.js` (the intraday windows, 5-minute reads), `hotlist.argus.js`
  (the day prompt), `hotlist.tools.js` (Axl's text: "08:00 … 15:30").
- **Kept for old data:** the column ids in the label maps (COLUMN_WORDS, COLUMN_LABEL, COLUMN_HORIZON, scanSeed's
  HOTLIST_COLUMNS) so the stored boards (10 days) and outcomes (168 days) still render and the record stays readable.
- **Re-pointed:** `hotlistResearch.service.js` (reads `hb_<day>_preopen` today → `hb_<day>_week`), `todayHotlist`
  (five boards a day → one), the monitor's tick (runCheckpoint → the overnight week pass).
- **Frontend:** the Boards view and its checkpoint tabs, the day horizon buttons, the RVol / pre-market cells, the day
  Info paragraphs → `archive/` (the FE's own); This week shows the run-up list; Info rewritten from the lab's numbers.
- **Docs:** daily-names.md (status line + the day sections marked archived), horizon-chains.md, CODE_MAP, README.

## 5. Decided (Roy, 2026-10-25)

1. **Argus is DROPPED from the week board** — the replay found no judgment; every run-up name is listed equally.
2. **Prometheus reads EVERY run-up name** (the catalyst read, as Argus's picks are read today — ~5–15 a night, within
   HOTLIST_RESEARCH_MAX_NAMES / _MAX_USD).

## 6. Order

1. The overnight week builder + its tests (live beside the old boards — compare a few nights).
2. Re-point research, the read side, the monitor; the frontend's week view.
3. Move the day code to `archive/`, `npm run check:archive`, the suite, a browser drive of the Hotlist.
4. Docs; the QA / CR cycle; commit when Roy says.

## 7. The code review (2026-10-25) — applied

Eleven findings and the bug hunt's two, all applied (Roy: "all of them"; the caps kept at 20 names / $2):
1 the research queue's window opened at the board day's UTC midnight — the board is built the evening before, so
Prometheus read nothing (now the previous weekday's midnight; a test whose fake honours `since`); 2 Prometheus was told
"Argus picked it" (`context.rule`, its own opening, the mode prompt); 3 an empty night hid Swing / Long term; 4 a failed
earnings read dropped a name for good (counted, the board partial, rebuilt hourly) and a failed calendar looked like a
quiet week (`calendar_failed`, said); 5 the week's record mixed the Argus era (`rule` group); 6 an unknown SPY gate was
silent; 7 the All view of a run-up day kept the day columns; 8 the panel missed the board landing after the run (a few
more looks); 9 a failed evening hand-off waited for midnight (resume checks the next board); 10 `hotlist.news.js`
archived, comments; 11 the docs. B1 the boards pruned at 30 days.
