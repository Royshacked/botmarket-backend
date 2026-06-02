# News Feed Architecture

## Overview

There are **two separate news pipelines** that both use GNews as the sole external source. They serve different purposes and have different caching strategies.

```
GNews API  (gnews.io)
    │
    ├──► newsFeedService   ──► SSE stream  ──► frontend UI (display)
    │
    └──► newsService       ──► file cache  ──► monitoring evaluator
                                           ──► trade agent tool
```

---

## Pipeline 1 — News Feed (Display)

**Purpose:** Real-time market headlines shown in the trading dashboard and mobile monitor.

### Data flow

```
server startup
    │
    ▼
newsFeedService.start()
    │
    ├── load file cache  (news-feed/feed.json)
    │       │
    │       ├── cache fresh (< 30 min)?  →  skip fetch, schedule poll
    │       └── stale / empty?          →  _refresh() immediately
    │
    └── setInterval(_refresh, 30 min)
              │
              ▼
         fetchGNews(broad market query)
              │
              ▼
         filter new articles only (dedup by URL/key)
              │
              ▼
         filterService.filterNews()    ← OpenAI GPT-4o-mini
              │   - remove non-financial articles
              │   - add sentiment: 'bullish' | 'bearish' | 'neutral'
              │   - add confidence: 0–1
              │
              ▼
         merge + save to file cache
              │
              ▼
         _pushToClients()   ← SSE push to all open browser connections
```

### SSE transport

```
Browser                          Server
  │                                │
  │── EventSource /news-feed/stream ─►│
  │                                │  addClient(res)
  │◄── data: [...articles] ─────────│  immediate flush of current cache
  │                                │
  │◄── data: [...articles] ─────────│  on every 30-min refresh
  │                                │
  │◄── : ping ──────────────────────│  every 30s (keep-alive, Render fix)
  │                                │
  │── (tab close / unmount) ───────►│  removeClient(res)
```

### Configuration

| Constant | Value | Meaning |
|---|---|---|
| `INTERVAL_MS` | 30 min | How often backend polls GNews |
| `WINDOW_MS` | 24 h | Articles older than this are dropped from cache |
| `FETCH_MAX` | 20 | Max articles per GNews call |
| `FETCH_QUERY` | `"stock market OR earnings OR Fed…"` | Broad market query |

### Files involved

| File | Role |
|---|---|
| `api/news-feed/newsFeed.service.js` | Core service: polling, cache, SSE push |
| `api/news-feed/newsFeed.controller.js` | REST snapshot + SSE endpoint handlers |
| `api/news-feed/newsFeed.routes.js` | `GET /news-feed`, `GET /news-feed/stream` |
| `services/model.filter.service.js` | OpenAI GPT-4o-mini relevance + sentiment filter |
| `providers/gnews.provider.js` | GNews REST client + query sanitiser |
| `services/util.service.js` | `loadItemsFromFile` / `saveItemsToFile` / `isCacheFresh` |

---

## Pipeline 2 — News Service (Monitoring / Research)

**Purpose:** Per-symbol news fetched on demand for condition evaluation during trade monitoring and as a tool for the trade agent.

### Data flow

```
Caller (monitoring evaluator or trade agent)
    │
    ▼
newsService.getOrFetch({ category, subject, query })
    │
    ├── load file cache  (news/{category}/{subject}.json)
    │
    ├── cache fresh (< 1 hour)?
    │       └── YES → return sorted cached articles
    │
    └── STALE → fetchGNews(query, from: lastFetchedAt, to: now)
                    │
                    ▼
               merge + dedup with existing cache
                    │
                    ▼
               save envelope to file
                    │
                    ▼
               return merged articles (sorted newest-first)
```

### Cache layout

One file per `category/subject` combination:

```
.cache/
  news/
    companies/
      AAPL.json
      TSLA.json
    markets/
      ...
    global/
      ...
```

Envelope shape:
```json
{
  "category": "companies",
  "subject": "AAPL",
  "query": "AAPL",
  "lastFetchedAt": 1716000000000,
  "items": [ ...articles ]
}
```

### Categories

| Category | Use |
|---|---|
| `companies` | Per-ticker news (used by monitoring evaluator) |
| `markets` | Broad market news |
| `sectors` | Sector-level news |
| `global` | Macro / world news |

### Tool registration

`newsService` is also registered as a trade agent tool:

```js
NEWS_TOOLS.getOrFetch = {
    id: 'news.get_or_fetch',
    description: 'Load cached articles or fetch from GNews when stale.',
    inputSchema: { category, subject, query, refresh? }
}
```

The trade agent calls this when building a trade idea with a news/macro condition.

### Files involved

| File | Role |
|---|---|
| `services/news.service.js` | Core: getOrFetch, cache, dedup, merge |
| `monitoring/evaluators/news.evaluator.js` | Calls `getOrFetch` → feeds headlines to Claude Haiku → YES/NO |
| `providers/gnews.provider.js` | Shared with Pipeline 1 |

---

## Shared: GNews Provider

Both pipelines use the same provider. Key behaviour:

- **Query sanitiser** — wraps tokens containing special chars (`.`, `,`, `&`, etc.) in quotes to comply with GNews query syntax
- **Rate limit** — GNews free tier: 100 requests/day. Both pipelines cache aggressively to stay well within this
- **Date windowing** — `from`/`to` params narrow results so only new articles are fetched on each refresh

---

## Article Shape

```js
{
  datetime:   number,   // Unix seconds (not ms)
  headline:   string,
  summary:    string,
  url:        string,
  image:      string,
  source:     string,   // e.g. "Reuters"
  id:         string | null,

  // Added by Pipeline 1 AI filter only:
  sentiment:  'bullish' | 'bearish' | 'neutral',
  confidence: number    // 0–1
}
```

---

## Frontend

```
MainPage.jsx
  │
  ├── EventSource → /news-feed/stream
  │       state: newsArticles[], newsLoading
  │
  ├── <NewsFeed articles={newsArticles} />               (desktop, always visible)
  └── <MonitorDashboard newsArticles={newsArticles} />   (mobile only)
```

`newsArticles` is fetched once on mount via SSE and lives in `MainPage` state. Both desktop and mobile views receive the same prop — there is no separate fetch on mobile.

---

## Future: Earnings Calendar

Finnhub is already integrated as a provider but currently dormant. Planned use: earnings calendar events as a separate feed, displayed alongside the GNews feed. Will be a **third pipeline** — no changes to the existing two.
