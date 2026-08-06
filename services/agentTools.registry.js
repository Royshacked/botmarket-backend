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
            "sector": {
                "type": "string",
                "description": "optional — narrow to one sector, e.g. Technology"
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
                    "enum": ["call", "setup", "portfolio", "coverage", "scan"]
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
    web_search: { server: "web_search_20250305" },
    get_market_brief: {
        "type": "object",
        "properties": {
            "refresh": {
                "type": "boolean",
                "description": "true to rewrite the brief instead of reading the recent one. Only when the user explicitly asks for an update."
            }
        }
    },
    // ── strategy desk (Pythia) + Axl's read of its output ────────────────────
    // All argument-free: each answers ONE question about the world or about our own book, and
    // giving them parameters would only invite the model to narrow a read that is cheap whole.
    get_priced_in: {
        "type": "object",
        "properties": {}
    },
    get_coverage_by_sector: {
        "type": "object",
        "properties": {}
    },
    get_sector_view: {
        "type": "object",
        "properties": {}
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
