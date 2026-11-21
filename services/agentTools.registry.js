// ONE home for every agent tool's SCHEMA.
//
// The agents are this app's client tier, so what sits under them must be singular: adding an
// agent should cost a prompt, a schema, its judgment and its card copy — never new plumbing.
// Before this module, 87 tool declarations were spread across 5 agent files, with
// get_fundamentals / get_earnings / get_sec_filings / get_short_interest / get_options_context
// each written out FIVE times. A fix to one had to be made five times, and they had already drifted.
//
// THE SPLIT, per the judgment-vs-mechanism litmus:
//   • MECHANISM lives here — the tool's name and input_schema: which parameters exist, their
//     types, their enums, what's required. Drift here is a BUG (an enum missing a timeframe means
//     the model literally cannot ask for it).
//   • JUDGMENT stays with the agent — the top-level `description`. That string is the INSTRUCTION
//     the model reads, and it is legitimately tuned per desk: Argus's get_sec_filings says
//     "confirm an earnings event truly dropped", Atlas's says "verify the fundamentals story
//     before a multi-year hold". Same tool, different job. 17 of 18 shared tools had a distinct
//     description, so unifying them would have quietly rewritten five agents' behaviour.
//
// Structural differences that ARE deliberate are expressed as an explicit `omit`, so they read as
// decisions rather than as copies someone forgot to update.

import { TRADE_HORIZONS } from './entity/vocabulary.js'

/** Canonical input_schema per tool — the union of every agent's parameters. */
export const TOOL_SCHEMAS = {
    get_analyst_actions: {
        "type": "object",
        "properties": {
            "symbols": {
                "type": "array",
                "items": {
                    "type": "string"
                },
                "description": "optional — narrow to these tickers for a per-name read; omit for the market-wide discovery feed"
            },
            "limit": {
                "type": "number",
                "description": "max rows for the market-wide feed, 1–50 (default 25)"
            }
        }
    },
    get_candles: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "Stock ticker symbol e.g. AAPL, NVDA"
            },
            "timeframe": {
                "type": "string",
                "enum": ["1min", "5min", "15min", "30min", "1hr", "2hr", "4hr", "day", "week", "month"],
                "description": "Candle timeframe. 2hr and 4hr are aggregated server-side from native 1hr bars into true 2hr/4hr OHLCV (Yahoo has no native 2hr/4hr); every other resolution is a native interval. Sub-hour history is limited (1min ~5 days, 5/15/30min ~weeks) — match the timeframe to the setup."
            }
        },
        "required": ["ticker", "timeframe"]
    },
    get_chart: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "Ticker symbol e.g. AAPL, NVDA, BTCUSDT"
            },
            "timeframe": {
                "type": "string",
                "enum": ["1min", "5min", "15min", "30min", "1hr", "2hr", "4hr", "day", "week", "month"],
                "description": "Chart timeframe. All resolutions render natively via TradingView."
            },
            "indicators": {
                "type": "string",
                "description": "Optional free-text indicators to overlay, e.g. \"rsi(14), ema(50), volume, vwap\". Leave EMPTY for a PLAIN price-only chart (the default) — best for reading structure, orderblocks and S/R without moving-average clutter. Add an overlay ONLY to confirm a read against it."
            },
            "show_to_user": {
                "type": "boolean",
                "description": "Set true whenever this chart relates to the user's ACTUAL setup — you are defining, validating, or refining their entry / stop / take-profit or reading the market structure behind it, or they asked to see it. In those cases the user wants to see what you are looking at, so show it. Leave false / omit ONLY for a quick throwaway internal peek that does not inform the setup under discussion; such a check must NOT appear in the chat."
            },
            "levels": {
                "type": "array",
                "description": "Price lines to DRAW on the chart — the trade, shown rather than described. Use it when you are putting candidate trades or a built plan in front of the user (with show_to_user true), not for your own reading. At most 8 lines; more than a handful and the picture stops being a trade.",
                "items": {
                    "type": "object",
                    "properties": {
                        "price": { "type": "number", "description": "Where the line sits." },
                        "kind":  { "type": "string", "enum": ["from", "to", "stop", "level"], "description": "What it MEANS, which is what colours it: `from` where the trade starts, `to` where it pays, `stop` where it is wrong, `level` structure drawn for reference." },
                        "label": { "type": "string", "description": "A few words shown on the line — \"the 238 shelf\", \"gap fill\". Keep it to the name of the thing, not a sentence." }
                    },
                    "required": ["price", "kind"]
                }
            }
        },
        "required": ["ticker", "timeframe"]
    },
    get_correlations: {
        "type": "object",
        "properties": {
            "tickers": {
                "type": "array",
                "items": {
                    "type": "string"
                },
                "description": "two or more tickers, e.g. [\"NVDA\",\"AAPL\",\"GLD\"]"
            }
        },
        "required": ["tickers"]
    },
    get_coverage: {
        "type": "object",
        "properties": {
            "industry": {
                "type": "string",
                "description": "optional — one GICS sub-industry (8-digit code or exact name): a sleeve's researched names"
            },
            "sector": {
                "type": "string",
                "description": "optional — narrow to one sector, e.g. Technology (a broad look; a sleeve is an industry)"
            },
            "school": {
                "type": "string",
                "enum": ["quality-value", "growth-durability", "income", "passive"],
                "description": "optional — narrow to names the analyst tagged for this selection school; combine with industry for the mandate-build pre-filter"
            }
        }
    },
    get_cycle_analysis: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. AAPL, NVDA, SPY"
            },
            "mode": {
                "type": "string",
                "enum": ["price", "calendar"],
                "description": "\"price\" for recurring interval cycles, \"calendar\" for seasonal window analysis"
            },
            "timeframe": {
                "type": "string",
                "enum": ["1min", "5min", "15min", "30min", "1hr", "day", "week", "month"],
                "description": "For \"price\" mode: the cycle resolution. 1min–1hr = intraday cycle (bars); day (default)/week/month = multi-day swing cycle. Ignored for \"calendar\"."
            },
            "calendar_window": {
                "type": "object",
                "description": "Required for mode \"calendar\". Defines the window to analyze each year.",
                "properties": {
                    "month_start": {
                        "type": "number",
                        "description": "1-based month number (Jan=1). Start month of the window."
                    },
                    "month_end": {
                        "type": "number",
                        "description": "1-based month number. End month — same as month_start for a single month."
                    },
                    "day_start": {
                        "type": "number",
                        "description": "Optional. Starting day within month_start (default 1)."
                    },
                    "day_end": {
                        "type": "number",
                        "description": "Optional. Ending day within month_end (default last day of month)."
                    }
                },
                "required": ["month_start"]
            },
            "lookback_years": {
                "type": "number",
                "description": "Years of history to use (default 4, max 6)."
            }
        },
        "required": ["ticker", "mode"]
    },
    get_derivatives_context: {
        "type": "object",
        "properties": {
            "symbol": {
                "type": "string",
                "description": "e.g. BTC, ETH, SOL (or BTC-USD / BTCUSDT)"
            }
        },
        "required": ["symbol"]
    },
    get_earnings: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. AAPL, NVDA, TSLA"
            }
        },
        "required": ["ticker"]
    },
    get_earnings_calendar: {
        "type": "object",
        "properties": {
            "from": {
                "type": "string",
                "description": "start date YYYY-MM-DD"
            },
            "to": {
                "type": "string",
                "description": "end date YYYY-MM-DD"
            },
            "symbols": {
                "type": "array",
                "items": {
                    "type": "string"
                },
                "description": "optional — narrow to these tickers"
            }
        },
        "required": ["from", "to"]
    },
    get_false_breaks: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "Ticker symbol e.g. AAPL, NVDA, BTCUSDT"
            },
            "timeframe": {
                "type": "string",
                "enum": ["1min", "5min", "15min", "30min", "1hr", "2hr", "4hr", "day", "week", "month"],
                "description": "Chart timeframe — read the sweeps on the timeframe(s) you trade on."
            },
            "show_to_user": {
                "type": "boolean",
                "description": "Set true to render the analyzed chart in the user's chat. Leave false for an internal read."
            }
        },
        "required": ["ticker", "timeframe"]
    },
    get_fundamentals: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. AAPL, NVDA, SPY"
            }
        },
        "required": ["ticker"]
    },
    get_indicators: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "Stock ticker symbol e.g. AAPL, NVDA"
            },
            "timeframe": {
                "type": "string",
                "enum": ["1min", "5min", "15min", "30min", "1hr", "2hr", "4hr", "day", "week", "month"],
                "description": "Candle timeframe to compute on."
            },
            "indicators": {
                "type": "string",
                "description": "Comma-separated list with optional period, e.g. \"ema(20), ema(50), rsi(14), atr(14), macd, vwap\". Period is optional (defaults: ema/sma 20, rsi/atr 14). VWAP is session-anchored (intraday)."
            }
        },
        "required": ["ticker", "timeframe", "indicators"]
    },
    get_macro_snapshot: {
        "type": "object",
        "properties": {}
    },
    get_market_movers: {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["gainers", "losers", "active"],
                "description": "gainers = biggest % up, losers = biggest % down, active = most traded by volume"
            },
            "limit": {
                "type": "number",
                "description": "how many to return, 1–50 (default 20)"
            }
        },
        "required": ["kind"]
    },
    // The reasoning sidecar (services/deepThink.service.js). Both fields are required on purpose:
    // the consulted model has NO access to the conversation, so a question without its material is
    // guaranteed to come back asking for what the desk already had in hand.
    consult: {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "The single decision to make, stated as a question. One decision per call — not a list, and not 'what do you think'."
            },
            "context": {
                "type": "string",
                "description": "Everything needed to answer it: the levels, the account size and risk rule, the two readings that disagree. The consulted desk head cannot see your conversation and cannot fetch anything, so whatever you leave out simply is not considered."
            }
        },
        "required": ["question", "context"]
    },
    // Axl's SUBAGENTS (docs/design/modes-and-builders.md §3): the event analyst and the analyst answer through
    // Axl. `companies` is REQUIRED with the name beside the ticker — a bare "ANT" reached the event analyst as Ant Group
    // (Roy, 2026-11-19), and a prompt rule alone did not hold on Luna; the schema does.
    ask_specialist: {
        "type": "object",
        "properties": {
            "specialist": {
                "type": "string",
                "enum": ["event_analyst", "research_analyst"],
                "description": "Who answers: event_analyst (who an event reaches through the supply chain) or research_analyst (a company as an investment: the rating, the target and why, the case for and against)."
            },
            "question": {
                "type": "string",
                "description": "The user's question, written to stand alone: name the company, the event and its date. The specialist sees nothing of this conversation except earlier exchanges with it."
            },
            "companies": {
                "type": "array",
                "description": "Every company the question is about, ticker AND company name (\"ANT\", \"Anthropic\"). Empty only when no listed company is involved (a heatwave, a port strike).",
                "items": {
                    "type": "object",
                    "properties": {
                        "ticker": { "type": "string" },
                        "name":   { "type": "string" }
                    },
                    "required": ["ticker", "name"]
                }
            },
            "context": {
                "type": "string",
                "description": "What you already found that the answer needs: facts from the news, figures, what the user said earlier. Optional."
            }
        },
        "required": ["specialist", "question", "companies"]
    },
    // ABOUT THE USER (services/userProfile.service.js, one-axl.md step 3): a lasting fact the user STATED, kept for every
    // role. The handler is wired in runAgentStream (the consult pattern) — a desk opts in by declaring it.
    remember_about_user: {
        "type": "object",
        "properties": {
            "note": {
                "type": "string",
                "description": "The fact, in a short third-person line, as the user put it: \"never trades low-float names\", \"only trades the open\". To take one back, the words of the note to remove."
            },
            "forget": {
                "type": "boolean",
                "description": "true when the user takes a fact back (\"I do trade small caps now\") — removes the note matching `note`."
            }
        },
        "required": ["note"]
    },
    // The blinded direction red-team (services/flipTest.service.js). Every field IDENTIFIES the
    // question; none of them is evidence. That is deliberate and it is the feature: the server
    // assembles the numbers, so the desk cannot hand its own audit a case file that suits the plan it
    // already drew.
    flip_test: {
        "type": "object",
        "properties": {
            "symbol": {
                "type": "string",
                "description": "The setup's ticker."
            },
            "timeframe": {
                "type": "string",
                "description": "The rung the plan is DRAWN on (its premise timeframe). The daily is always included as well, whatever you name."
            },
            "horizon": {
                "type": "string",
                // THE vocabulary, not a copy of it: a literal here missed `short term swing` the day it was added.
                "enum": TRADE_HORIZONS,
                "description": "The trade's horizon, so the counter-case is argued over the same holding period."
            },
            "direction": {
                "type": "string",
                "enum": ["long", "short"],
                "description": "The direction the plan takes. The OTHER side is what gets argued."
            }
        },
        "required": ["symbol", "direction"]
    },
    // Mentor's sizing answer (services/agents/mentor.agent.service.js). The UNIT and the NUMBER are
    // the user's; the quantity is never a parameter — it is the server's to compute. The enum mirrors
    // SIZE_UNITS in services/positionSize.util.js.
    close_setup: { "type": "object", "properties": {} },
    size_position: {
        "type": "object",
        "properties": {
            "unit": {
                "type": "string",
                "enum": ["risk_cash", "risk_pct", "size_cash", "size_pct", "shares"],
                "description": "The unit the USER sized in: risk in cash, risk as % of the account, position value in cash, position value as % of the account, or a number of shares/units."
            },
            "value": {
                "type": "number",
                "description": "Their number, in that unit — 1000 for \"risk $1k\", 1 for \"1%\"."
            },
            "multiplier": {
                "type": "number",
                "description": "Contract or point value — futures and FX only. Omit for shares, ETFs and crypto."
            }
        },
        "required": ["unit", "value"]
    },
    // The THESIS lens (docs/design/stock-playbook.md): the facts a stop and a target are judged from, and the entry
    // arithmetic (services/swingStructure.service.js). The levels are the model's judgement; the numbers are code.
    get_price_structure: {
        "type": "object",
        "properties": {
            "ticker":    { "type": "string", "description": "The symbol, e.g. MTG." },
            "timeframe": { "type": "string", "enum": ["hour", "day", "week"], "description": "The chart the trade is drawn on: `hour` for a day trade (intraday · day — the session's closed 1-hour bars), `day` for a swing, `week` for a long-term trade (bigger swings, a bigger stop and target)." },
            "side":      { "type": "string", "enum": ["long", "short"], "description": "Read for a long (default) or a short — a short reads the chart upside down: its stop over the buyers' last swing up." }
        },
        "required": ["ticker", "timeframe"]
    },
    get_entry_level: {
        "type": "object",
        "properties": {
            "ticker":         { "type": "string", "description": "The symbol — the reply also says when price last traded past the stop." },
            "stop":           { "type": "number", "description": "The stop YOU judged — where the thesis breaks." },
            "target":         { "type": "number", "description": "The target you judged (TP1)." },
            "risk_limit_pct": { "type": "number", "description": "The USER's risk limit: the stop at most this % from the entry, e.g. 5." },
            "min_rr":         { "type": "number", "description": "The USER's minimum reward to risk at the entry, e.g. 1.5." },
            "side":           { "type": "string", "enum": ["long", "short"] }
        },
        "required": ["ticker", "stop", "target"]
    },
    get_market_hours: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. AAPL, NQ, BTCUSD, EURUSD"
            },
            "asset_class": {
                "type": "string",
                "enum": ["stock", "etf", "futures", "forex", "crypto"],
                "description": "the instrument's class, when you know it — it picks the right trading calendar. Omit it and the class is inferred from the ticker."
            }
        },
        "required": ["ticker"]
    },
    get_news: {
        "type": "object",
        "properties": {
            "category": {
                "type": "string",
                "enum": ["companies", "headlines", "topic"],
                "description": "which kind of news read this is. `companies` — one listed company, `subject` is its TICKER. `headlines` — the market's front page, no subject needed. `topic` — free-text search for a theme, an institution or an asset with no ticker."
            },
            "subject": {
                "type": "string",
                "description": "for `companies`, the TICKER (NVDA, BA, AAPL). For `topic`, the theme in the words a paper would print (\"Federal Reserve\", \"OPEC\", \"semiconductors\", \"gold\"). Omit for `headlines`. It is both the search and the cache key, so ask for the same subject the same way each time."
            }
        },
        "required": ["category"]
    },
    get_options_context: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. NVDA, SPY, AAPL"
            }
        },
        "required": ["ticker"]
    },
    get_orderblocks: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "Ticker symbol e.g. AAPL, NVDA, BTCUSDT"
            },
            "timeframe": {
                "type": "string",
                "enum": ["1min", "5min", "15min", "30min", "1hr", "2hr", "4hr", "day", "week", "month"],
                "description": "Chart timeframe — read the orderblocks on the timeframe(s) you trade on."
            },
            "show_to_user": {
                "type": "boolean",
                "description": "Set true to render the analyzed chart in the user's chat (the plain chart the read is based on). Leave false for an internal read."
            }
        },
        "required": ["ticker", "timeframe"]
    },
    get_peers: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. NVDA, AAPL, XOM"
            }
        },
        "required": ["ticker"]
    },
    get_price_action: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. AAPL, NVDA, SPY"
            }
        },
        "required": ["ticker"]
    },
    get_quote: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "Stock ticker symbol e.g. AAPL, NVDA"
            }
        },
        "required": ["ticker"]
    },
    get_quotes: {
        "type": "object",
        "properties": {
            "tickers": {
                "type": "array",
                "items": {
                    "type": "string"
                },
                "description": "e.g. [\"AAPL\",\"NVDA\",\"GLD\"]"
            }
        },
        "required": ["tickers"]
    },
    get_risk_metrics: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. AAPL, NVDA, SPY"
            }
        },
        "required": ["ticker"]
    },
    get_sec_filings: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. AAPL, NVDA, TSLA"
            }
        },
        "required": ["ticker"]
    },
    get_sector_snapshot: {
        "type": "object",
        "properties": {}
    },
    get_short_interest: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. GME, TSLA, AAPL"
            }
        },
        "required": ["ticker"]
    },
    get_stock_peers: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "e.g. AAPL, NVDA"
            }
        },
        "required": ["ticker"]
    },
    get_trading_context: {
        "type": "object",
        "properties": {}
    },
    check_broker_symbol: {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "The instrument to check, as the user says it e.g. AVGO, NQ, BTCUSD"
            }
        },
        "required": ["ticker"]
    },
    set_experience_level: {
        "type": "object",
        "properties": {
            "level": {
                "type": "string",
                "enum": ["beginner", "experienced", "unset"],
                "description": "'experienced' is only accepted with source 'declared' — you may not conclude it yourself."
            },
            "source": {
                "type": "string",
                "enum": ["declared", "inferred"],
                "description": "'declared' = the user said so in their own words. 'inferred' = you worked it out from how they write."
            }
        },
        "required": ["level", "source"]
    },
    explain_concept: {
        "type": "object",
        "properties": {
            "concept": {
                "type": "string",
                "description": "The term to explain, as the user said it e.g. \"stop loss\", \"R\", \"drawdown\", \"limit order\". Spelling and plurals are handled."
            }
        },
        "required": ["concept"]
    },
    get_watched_items: {
        "type": "object",
        "properties": {
            "kinds": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["setup", "portfolio", "coverage", "queued"]
                },
                "description": "optional — narrow to these kinds. Omit for everything, which is the usual case."
            },
            "symbol": {
                "type": "string",
                "description": "optional — only items on this one name e.g. NVDA"
            },
            "include_finished": {
                "type": "boolean",
                "description": "include closed/finished items. Default false — finished work is history, not something being watched."
            }
        }
    },
    get_performance: {
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["paper", "live", "manual"],
                "description": "optional — only trades in this mode. Omit to cover all of them."
            },
            "symbol": {
                "type": "string",
                "description": "optional — only trades on this name e.g. NVDA"
            },
            "from": {
                "type": "string",
                "description": "optional window start, YYYY-MM-DD"
            },
            "to": {
                "type": "string",
                "description": "optional window end, YYYY-MM-DD"
            }
        }
    },
    get_upcoming_events: {
        "type": "object",
        "properties": {
            "scope": {
                "type": "string",
                "enum": ["mine", "market"],
                "description": "'mine' (default) = only the user's own names; 'market' = everything reporting in the window."
            },
            "from": {
                "type": "string",
                "description": "optional window start, YYYY-MM-DD. Defaults to today."
            },
            "to": {
                "type": "string",
                "description": "optional window end, YYYY-MM-DD. Defaults to 30 days out."
            }
        }
    },
    screen_candidates: {
        "type": "object",
        "properties": {
            "sector": {
                "type": "string",
                "description": "e.g. Technology, Healthcare, Energy, Financial Services, Utilities"
            },
            "industry": {
                "type": "string",
                "description": "optional finer bucket, e.g. Semiconductors"
            },
            "marketCapMoreThan": {
                "type": "number",
                "description": "min market cap in USD, e.g. 10000000000 for $10B+"
            },
            "marketCapLowerThan": {
                "type": "number",
                "description": "max market cap in USD, e.g. 2000000000 for small-cap"
            },
            "priceMoreThan": {
                "type": "number",
                "description": "min share price (a tradability floor — e.g. 5 to drop penny names)"
            },
            "priceLowerThan": {
                "type": "number",
                "description": "max share price"
            },
            "betaMoreThan": {
                "type": "number",
                "description": "min beta (higher = more cyclical/volatile)"
            },
            "betaLowerThan": {
                "type": "number",
                "description": "max beta (lower = more defensive)"
            },
            "dividendMoreThan": {
                "type": "number",
                "description": "min annual dividend per share in USD"
            },
            "volumeMoreThan": {
                "type": "number",
                "description": "min average volume — the liquidity floor; set it for tradability"
            },
            "country": {
                "type": "string",
                "description": "e.g. US (default universe is US)"
            },
            "isEtf": {
                "type": "boolean",
                "description": "true to screen ETFs instead of single stocks"
            },
            "limit": {
                "type": "number",
                "description": "max results 1–50 (default 25)"
            }
        }
    },
    // Base = the modern variant; providers/anthropic.provider finalizes it PER MODEL (Haiku takes
    // the basic one) and adds max_uses. The registry says only "this desk offers web_search".
    web_search: { server: "web_search_20260209" },
    get_market_brief: {
        "type": "object",
        "properties": {
            "refresh": {
                "type": "boolean",
                "description": "true to rewrite the brief instead of reading the recent one. Only when the user explicitly asks for an update."
            }
        }
    },
    // ── Axl's read of the house view (Pythia's industry desk tools follow) ─────
    // The channel-era Pythia tools (get_priced_in, get_coverage_by_sector, get_channel_state,
    // get_channel_exposures, size_from_channels, get_industry_reads) went with the desk's rebuild on
    // 2026-10-05 (docs/design/pythia-industry-questions.md).
    get_industry_views: {
        "type": "object",
        "properties": {
            "symbols": { "type": "array", "items": { "type": "string" }, "description": "Tickers to look up — the house answer for the industry each one is in." },
            "sector": { "type": "string", "description": "A GICS sector (e.g. Information Technology) — every sub-industry in it. Used when no symbols are passed." }
        }
    },
    // Axl's read of today's hotlist (services/tools/hotlist.tools.js; Roy, 2026-10-22).
    // The monitors' view of ONE of the user's items (services/tools/itemStatus.tools.js — Roy, 2026-11-21).
    get_item_status: {
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["setup", "book"], "description": "setup or book, as get_watched_items tags it" },
            "id":   { "type": "string", "description": "the id get_watched_items prints after the colon" }
        },
        "required": ["kind", "id"]
    },
    // Axl's read of the house's work on ONE company (services/tools/companyView.tools.js — Roy, 2026-11-21).
    get_company_view: {
        "type": "object",
        "properties": {
            "symbol": { "type": "string", "description": "one ticker, e.g. NVDA" }
        },
        "required": ["symbol"]
    },
    get_hotlist: {
        "type": "object",
        "properties": {
            "limit": { "type": "number", "description": "How many names to list, 1–30 (default 10). Picks and in-play names come first." }
        }
    },
    // Argus's list for a horizon — the only names he picks from (services/tools/horizonList.tools.js; argus-rework.md §3.1).
    get_horizon_list: {
        "type": "object",
        "properties": {
            "horizon": { "type": "string", "enum": ["intraday", "day", "short term swing", "swing", "long term"], "description": "The trade's horizon — which list to read." }
        },
        "required": ["horizon"]
    },
    // Echo, the event desk (services/tools/echo.tools.js; docs/design/echo-pipeline.md "The app").
    get_echo_events: {
        "type": "object",
        "properties": {}
    },
    get_event_map: {
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "The event's id from get_echo_events (ev_…)." }
        },
        "required": ["id"]
    },
    request_reads: {
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "The user's own event id (ev_…)." },
            "tickers": { "type": "array", "items": { "type": "string" }, "description": "The names from that map the user picked; omit for its top-scored directional links." }
        },
        "required": ["id"]
    },
    map_event: {
        "type": "object",
        "properties": {
            "what_changed": { "type": "string", "description": "One sentence: the news (the guide, the rule, the launch) — never how a stock moved." },
            "origin": { "type": "string", "description": "The company or country the event hits directly — or the demand it moves when no single listed company is the event's." },
            "tickers": { "type": "array", "items": { "type": "string" }, "description": "The origin's US tickers; empty for a country or a demand." },
            "effect": { "type": "string", "enum": ["up", "down", "mixed"], "description": "What the event does to demand AT THE ORIGIN." },
            "type": { "type": "string", "enum": ["demand_shock", "supply_shock", "policy", "clinical", "geopolitical", "capacity_deal", "confirmation"], "description": "The kind of event." },
            "durability": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["price_spike", "policy_follow_through", "drug_class_shift", "multi_year_commitment"] },
                    "why": { "type": "string", "description": "One sentence: why it lasts or fades." }
                },
                "required": ["kind", "why"],
                "description": "The most important field: a locked-in commitment lasts, a price spike cures itself."
            },
            "date": { "type": "string", "description": "YYYY-MM-DD the event became public; omit for today." },
            "timing": { "type": "string", "enum": ["before_open", "during_session", "after_close"], "description": "When it landed (US Eastern), if known." },
            "size": { "type": "string", "description": "Guide vs consensus, budget amount, share of supply affected — a sentence, if known." },
            "terms": { "type": "array", "items": { "type": "string" }, "description": "What other companies' filings call the origin (\"NVIDIA\", \"GLP-1\")." }
        },
        "required": ["what_changed", "origin", "tickers", "effect", "type", "durability"]
    },
    // Proteus v2: where the stop and the target go for a reward : risk the user asks for (services/stockProfile.service.js
    // levelsFor; docs/design/proteus-v2.md §3).
    get_levels_for: {
        "type": "object",
        "properties": {
            "ticker":  { "type": "string", "description": "The symbol, e.g. KO." },
            "ratio":   { "type": "number", "description": "The reward : risk the USER asked for, as reward per 1 of risk — 3 for \"3:1\", 1.5 for \"1.5:1\"." },
            "horizon": { "type": "string", "enum": ["intraday", "day", "short term swing", "swing", "long term"], "description": "The trade's horizon — it picks the scale the levels are read on (a day trade the session's 15-minute bars; a short term swing, a swing and long term the daily bars, with the stop and the target in σ over a week / a month / a quarter)." },
            "side":    { "type": "string", "enum": ["long", "short"], "description": "long (default) or short." }
        },
        "required": ["ticker", "ratio", "horizon"]
    },
    // Argus's read of the house's industries for a book (docs/design/argus-on-pythia.md §3.2).
    get_house_industries: {
        "type": "object",
        "properties": {
            "book": { "type": "string", "enum": ["swing", "long_term"], "description": "The scan's book: the industries the industry strategist rates for it." },
            "sector": { "type": "string", "description": "A GICS sector (e.g. Information Technology) to narrow the book's list." },
            "industry": { "type": "string", "description": "A GICS sub-industry (8-digit code or exact name) from the list — its largest companies instead of the list." },
            "limit": { "type": "number", "description": "How many of the industry's companies, 1–40 (default 15)." }
        }
    },
    // ── Pythia, the industry desk (docs/design/pythia-industry-questions.md) ──
    list_industries: {
        "type": "object",
        "properties": {
            "sector": { "type": "string", "description": "A GICS sector (e.g. Information Technology) to narrow the list. Omit for all 163 sub-industries." }
        }
    },
    get_industry_metrics: {
        "type": "object",
        "properties": {
            "industry": { "type": "string", "description": "A GICS sub-industry: its 8-digit code (45301020) or its exact name (Semiconductors)." }
        },
        "required": ["industry"]
    },
    get_industry_companies: {
        "type": "object",
        "properties": {
            "industry": { "type": "string", "description": "A GICS sub-industry: its 8-digit code or its exact name." },
            "limit": { "type": "integer", "description": "How many of the largest companies to list (default 25, at most 60)." }
        },
        "required": ["industry"]
    },
    get_industry_view: {
        "type": "object",
        "properties": {
            "industry": { "type": "string", "description": "A GICS sub-industry: its 8-digit code or its exact name." }
        },
        "required": ["industry"]
    },
    get_industry_moves: {
        "type": "object",
        "properties": {
            "industry": { "type": "string", "description": "A GICS sub-industry: its 8-digit code or its exact name." }
        },
        "required": ["industry"]
    },
    get_industry_news: {
        "type": "object",
        "properties": {
            "industry": { "type": "string", "description": "A GICS sub-industry: its 8-digit code or its exact name." }
        },
        "required": ["industry"]
    },
    get_industry_money: {
        "type": "object",
        "properties": {
            "industry": { "type": "string", "description": "A GICS sub-industry: its 8-digit code or its exact name." }
        },
        "required": ["industry"]
    },
    get_capex_leaders: {
        "type": "object",
        "properties": {}
    },
    get_geopolitics: {
        "type": "object",
        "properties": {
            "industry": { "type": "string", "description": "Optional: a GICS sub-industry (8-digit code or exact name) for the risks touching it." }
        }
    },
    list_themes: {
        "type": "object",
        "properties": {}
    },
    get_theme: {
        "type": "object",
        "properties": {
            "theme": { "type": "string", "description": "The theme's id, th_… (from list_themes)." }
        },
        "required": ["theme"]
    },
}

/** Every tool the registry knows. */
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS)

/**
 * Build an agent's tool array from a spec.
 *
 * @param {Object<string, string | { description: string, omit?: string[], cache?: boolean }>} spec
 *        tool name → the description THIS agent gives the model. Order is preserved: the array is
 *        built in the spec's key order, which matters because prompt caching keys off the prefix.
 * @returns {Array<object>} Anthropic tool definitions
 *
 * `omit` drops parameters this agent must not be offered — e.g. Argus gets no `show_to_user`
 * because scanner charts are deliberately never surfaced to the user.
 *
 * `cache` stamps cache_control on that entry, marking the end of the cacheable tools prefix.
 * That is a property of WHERE a tool sits in one agent's array, not of the tool itself, which is
 * why it belongs to the spec rather than to the schema.
 */
export function toolsFor(spec) {
    return Object.entries(spec).map(([name, v]) => {
        const entry = typeof v === 'string' ? { description: v } : (v ?? {})
        const schema = TOOL_SCHEMAS[name]
        if (!schema) throw new Error(`[agentTools] unknown tool "${name}" — add its schema to TOOL_SCHEMAS`)

        // A server-side tool (web_search) is passed through by type; it has no input_schema.
        if (schema.server) return { type: schema.server, name }

        let input_schema = schema
        if (entry.omit?.length) {
            const properties = { ...schema.properties }
            for (const k of entry.omit) delete properties[k]
            input_schema = {
                ...schema,
                properties,
                required: (schema.required ?? []).filter(r => !entry.omit.includes(r)),
            }
        }

        return {
            name,
            description: entry.description,
            input_schema,
            ...(entry.cache ? { cache_control: { type: 'ephemeral' } } : {}),
        }
    })
}
