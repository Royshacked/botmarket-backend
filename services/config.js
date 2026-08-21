/**
 * THE configuration surface. Every environment variable this backend reads is named here, once,
 * with its type, its default and what it does.
 *
 * Before this, 43 variables were read at ~70 sites as inline `Number(process.env.X) || default`
 * expressions scattered through providers and services. There was no way to answer "what configures
 * this system?" short of grepping, no validation, and the defaults for one concept could drift
 * between the two files that read it.
 *
 * ── Three decisions worth knowing ──────────────────────────────────────────────
 *
 * 1. IT OWNS dotenv. Importing this module loads `.env`, so nothing downstream depends on having
 *    been imported after something else that happened to load it. That dependency was real and it
 *    bit: monitor.claude.js built its Anthropic client at module scope and worked only because
 *    monitorUtils' import chain reached `dotenv/config` first. Swapping one import for a leaf
 *    module removed the accident and every condition parse started failing on a key that was in
 *    .env all along. A config module that does not load config is a trap.
 *
 * 2. EVERY VALUE IS A GETTER, so reads stay LIVE. Freezing at import would be tidier and wrong
 *    twice: several values are legitimately read per-call, and tests override `process.env` to
 *    exercise failure paths (ESM hoists imports above top-level statements, so a test's assignment
 *    lands after every module has loaded — only a live read sees it). Getters make this refactor
 *    behaviour-preserving, which is the whole point of a refactor.
 *
 * 3. IT VALIDATES WHAT IS ACTUALLY DETECTABLE, and does not pretend otherwise. A misspelled key is
 *    invisible to a reader — you cannot detect a name you never look for. Two things ARE detectable
 *    and both are checked by `validateConfig()`: a required value missing, and a value that is SET
 *    but malformed (`CANDLE_CACHE_INTRADAY_MS=abc` → NaN → silently the default). The typo case is
 *    covered from the other side: `unknownConfigKeys()` reports keys present in .env that no schema
 *    entry claims, which is exactly what a typo looks like.
 */

import dotenv from 'dotenv'

// NEVER under the test runner. `node --test` sets NODE_TEST_CONTEXT in each child process, and that
// is the signal used here rather than NODE_ENV, which nothing in `npm test` sets and which would
// have to be threaded through a platform-specific npm script to be reliable.
//
// This is not tidiness, it is a safety gate. The unit suite runs OFFLINE and always has — not by
// design but by accident, because .env was only ever loaded by server.js, so a test process had no
// MONGODB_URI and anything reaching for the database failed instantly. Several tests quietly depend
// on that: notifyCard.test asserts "posting a card never throws", and it passes precisely because
// the write cannot reach a database. Loading .env everywhere turned those into live connections to
// the PRODUCTION cluster that hung the runner and never exited — and this repo already knows that
// hazard from the other direction (the deployed app shares an FMP key with dev, so a test that
// reaches a real provider spends the real quota).
//
// So: real config in the real process, nothing in a test. A test that needs a value sets it itself.
const _underTest = process.env.NODE_TEST_CONTEXT !== undefined

// Load .env and KEEP what it parsed — the unknown-key check needs to distinguish "this key came
// from our .env file" from "this is one of the several hundred variables the OS sets". On a
// platform deploy (Render) there is no .env, `parsed` is empty, and the check is silently a no-op.
const _dotenvParsed = _underTest ? {} : (dotenv.config().parsed ?? {})

// ─── readers ──────────────────────────────────────────────────────────────────
// Each records what it read so validateConfig can report malformed values without re-deriving the
// parsing rules. A reader NEVER throws: a bad value falls back exactly as the inline expressions
// did, and is reported separately. Startup fails on `validateConfig`, not on an import.

const _malformed = new Map()   // key → the offending raw string

function _str(key, fallback = '') {
    const raw = process.env[key]
    return (typeof raw === 'string' && raw !== '') ? raw : fallback
}

/** A number, falling back when absent OR unparseable — and remembering which of the two it was. */
function _num(key, fallback) {
    const raw = process.env[key]
    if (raw === undefined || raw === '') { _malformed.delete(key); return fallback }
    const n = Number(raw)
    if (!Number.isFinite(n)) { _malformed.set(key, raw); return fallback }
    _malformed.delete(key)
    return n
}

/**
 * A boolean. `mode` reflects the three different spellings already in the codebase, kept rather
 * than unified because each is a live contract with someone's deployment:
 *   'off-switch'  anything but the literal 'off' is on          (MARKET_BRIEF_OFFER)
 *   'false-0'     'false' or '0' turns it off, else on          (OWN_CHART_RENDER)
 *   'opt-in'      only 'true' / '1' / 'yes' turn it ON          (USE_FMP_CANDLES)
 */
function _bool(key, mode) {
    const raw = String(process.env[key] ?? '').toLowerCase()
    if (mode === 'off-switch') return process.env[key] !== 'off'
    if (mode === 'false-0')    return raw !== 'false' && raw !== '0'
    return ['true', '1', 'yes'].includes(raw)
}

// ─── the schema ───────────────────────────────────────────────────────────────

export const config = {
    // ── core ──
    /** Mongo connection string. REQUIRED — the app cannot serve a request without it. */
    get mongoUri()  { return process.env.MONGODB_URI },
    // Which database on that cluster. UNSET is the historical behaviour — the name comes from the
    // URI path, and an `mongodb+srv://host/` with no path lands on `test`. It exists so a developer
    // can point a laptop at its OWN database on the shared cluster: sharing one meant local dev and
    // the deployed instance contended for the SAME background-loops lease, the laptop always lost,
    // and every paper fill it executed went onto an in-process executionBus with no reconciler on
    // it (2026-08-20). Leave it unset in the deployed environment.
    get dbName()    { return process.env.DB_NAME || null },
    /** Signing secret for the session JWT and the broker OAuth `state`. REQUIRED. */
    get jwtSecret() { return process.env.JWT_SECRET },
    get port()      { return _num('PORT', 3030) },
    get nodeEnv()   { return _str('NODE_ENV', 'development') },
    get isProduction() { return this.nodeEnv === 'production' },
    /** Where the browser is sent back to after a broker OAuth round trip. */
    get clientUrl() { return _str('CLIENT_URL', 'http://localhost:5173') },

    // ── LLM ──
    get anthropicApiKey() { return process.env.ANTHROPIC_API_KEY },
    get openaiApiKey()    { return process.env.OPENAI_API_KEY },        // transcription only
    /** Monthly spend per user shown as a percentage in the profile, USD — see tokenUsage.service. */
    get tokenBudgetUsd()  { return _num('TOKEN_BUDGET_USD', 20) },
    /**
     * The spend at which a user's chat DEGRADES to the cheap model, USD. 0 or unset = no ceiling,
     * which is the default ON PURPOSE: the display budget above is a placeholder nobody has ratified,
     * and enforcing a number that was never chosen would quietly change every user's model. Separate
     * key so turning enforcement on is a decision, not a side effect of the display default.
     */
    get tokenDegradeUsd() { const n = _num('TOKEN_DEGRADE_USD', 0); return n > 0 ? n : null },

    // ── market data providers ──
    get fmpApiKey()     { return process.env.FMP_API_KEY },
    get massiveApiKey() { return process.env.MASSIVE_API_KEY },
    get finnhubApiKey() { return process.env.FINNHUB_API_KEY },
    get fredApiKey()    { return process.env.FRED_API_KEY },
    get gnewsApiKey()   { return process.env.GNEWS_API_KEY },
    get chartImgApiKey() { return process.env.CHART_IMG_API_KEY },
    /** SEC demands a contactable UA string on every request or it blocks the caller. */
    get secUserAgent()  { return _str('SEC_USER_AGENT', 'ar2trade scanner roy.shacked@mail.huji.ac.il') },
    /** FMP-first candle sourcing, with Massive/Yahoo as fallback. Opt-IN. */
    get useFmpCandles() { return _bool('USE_FMP_CANDLES', 'opt-in') },
    get fmpQuoteTtlMs() { return _num('FMP_QUOTE_TTL_MS', 3_000) },

    // ── chart candles (the /api/market read surface) ──
    get candleCacheIntradayMs() { return _num('CANDLE_CACHE_INTRADAY_MS', 30_000) },
    get candleCacheDailyMs()    { return _num('CANDLE_CACHE_DAILY_MS', 300_000) },
    /** How stale a published mark may be before the chart buys its own quote. */
    get quoteFeedMaxAgeMs()     { return _num('QUOTE_FEED_MAX_AGE_MS', 4_000) },

    // ── chart rendering (headless Chromium; chart-img is the fallback) ──
    get ownChartRender()               { return _bool('OWN_CHART_RENDER', 'false-0') },
    get ownChartRenderTimeoutMs()      { return _num('OWN_CHART_RENDER_TIMEOUT_MS', 12_000) },
    get ownChartRenderPageTimeoutMs()  { return _num('OWN_CHART_RENDER_PAGE_TIMEOUT_MS', 10_000) },
    get ownChartRenderConcurrency()    { return Math.max(1, _num('OWN_CHART_RENDER_CONCURRENCY', 3)) },

    // ── paper venue ──
    get paperFillIntervalMs()     { return _num('PAPER_FILL_INTERVAL_MS', 3_000) },
    get paperMarkIntervalMs()     { return _num('PAPER_MARK_INTERVAL_MS', 3_000) },
    get paperEquitySnapshotMs()   { return _num('PAPER_EQUITY_SNAPSHOT_MS', 300_000) },
    get paperQuoteTtlMs()         { return _num('PAPER_QUOTE_TTL_MS', 5_000) },
    get paperFastQuoteTtlMs()     { return _num('PAPER_FAST_QUOTE_TTL_MS', 3_000) },

    // ── market brief ──
    get marketBriefTtlMs()       { return _num('MARKET_BRIEF_TTL_MS', 45 * 60 * 1000) },
    get marketBriefOfferHourUtc() { return _num('MARKET_BRIEF_OFFER_HOUR_UTC', 12) },
    /** The daily offer card. Set to the literal 'off' to disable the fan-out. */
    get marketBriefOffer()       { return _bool('MARKET_BRIEF_OFFER', 'off-switch') },

    // ── cTrader ──
    get ctraderClientId()  { return _str('CTRADER_CLIENTID') },
    get ctraderSecret()    { return _str('CTRADER_SECRET') },
    /** The redirect URI differs by deployment, so it is chosen by NODE_ENV rather than set twice. */
    get ctraderRedirectUri() {
        return this.isProduction ? _str('CTRADER_REDIRECT_URL_PROD') : _str('CTRADER_REDIRECT_URI')
    },

    // ── IBKR (data-only, in progress) ──
    get ibkrClientId()     { return _str('IBKR_CLIENT_ID') },
    get ibkrClientSecret() { return _str('IBKR_CLIENT_SECRET') },
    get ibkrRedirectUri()  { return _str('IBKR_REDIRECT_URI') },
    /** Gateway coords. A stored connection's own coords take precedence over these. */
    get ibkrGwHost()       { return _str('IBKR_GW_HOST', '127.0.0.1') },
    get ibkrGwPort()       { return _num('IBKR_GW_PORT', 4002) },
    get ibkrGwClientId()   { return _num('IBKR_GW_CLIENTID', 1) },
    /** Whether a gateway host was configured at all — the adapter's availability check. */
    get ibkrGwConfigured() { return Boolean(process.env.IBKR_GW_HOST) },

    // ── process / networking ──
    /**
     * DNS resolvers to force, comma-separated. EMPTY means "leave Node's resolver alone", which is
     * the only correct production answer.
     *
     * This used to be an unconditional `dns.setServers(['8.8.8.8','1.1.1.1'])` on line 5 of
     * server.js, added because a developer's router blocks the SRV queries a `mongodb+srv://` URI
     * needs. It is global — every lookup in the process — so it also overrides the resolver a
     * container or VPC hands us. The day Mongo sits behind an Atlas private endpoint, or any
     * internal hostname needs resolving, a public resolver cannot see it and the failure reads as
     * a Mongo outage rather than a DNS override nobody remembers making.
     *
     * The default keeps the dev machine working unchanged and stops shipping the override to
     * production. Set `DNS_SERVERS=` (explicitly empty) to opt a dev box out; set it to a list to
     * opt a deployment in.
     */
    get dnsServers() {
        const raw = process.env.DNS_SERVERS ?? (this.isProduction ? '' : '8.8.8.8,1.1.1.1')
        return raw.split(',').map(s => s.trim()).filter(Boolean)
    },
    /**
     * The background-loop lease (services/instanceLock.service.js). A second instance that
     * cannot win this starts NO loops. The TTL is how long the fleet stays stopped if the
     * leader dies without releasing — so it trades failover speed against how tolerant the
     * lease is of a slow renewal. 30s/10s means a crashed leader is replaced inside ~30s and a
     * renewal has three attempts to land before leadership moves.
     */
    get instanceLeaseTtlMs()   { return _num('INSTANCE_LEASE_TTL_MS', 30_000) },
    get instanceLeaseRenewMs() { return _num('INSTANCE_LEASE_RENEW_MS', 10_000) },
    /**
     * How long shutdown waits for in-flight work before forcing the process down. Sized against
     * the platform's own SIGKILL delay (Render/Heroku give 30s) — it must be COMFORTABLY under it,
     * or the backstop never runs and the platform kills us mid-write instead.
     */
    get shutdownGraceMs() { return _num('SHUTDOWN_GRACE_MS', 10_000) },
    /**
     * Whether an unhandled promise rejection takes the process down. Opt-IN, i.e. OFF by default,
     * and the reasoning is specific to this deployment rather than general Node advice.
     *
     * One process runs all eleven background loops. A rejection escaping one provider call would,
     * if fatal, stop Talos watching live stops, the reconciler watching fills, and the paper
     * engines — for a fault that is already contained: `createPollLoop` and `createDueLoop` both
     * catch per tick. Trading the whole fleet for one leaked promise is the worse failure.
     *
     * An uncaughtException is NOT covered by this and is always fatal: there the process state
     * itself is unknown, which is a different question from one promise nobody awaited.
     */
    get unhandledRejectionFatal() { return _bool('UNHANDLED_REJECTION_FATAL', 'opt-in') },
    /**
     * How many reverse proxies sit in front of us, for Express's `trust proxy`. Behind Render's
     * proxy every request otherwise reports the proxy's IP, which would make the IP-keyed rate
     * limits below one shared bucket for the entire internet. A COUNT rather than `true`: the
     * permissive form lets a caller forge `X-Forwarded-For` and mint themselves a fresh bucket
     * per request, and express-rate-limit rejects it for exactly that reason.
     */
    get trustProxyHops() { return this.isProduction ? _num('TRUST_PROXY_HOPS', 1) : 0 },

    // ── rate limiting ──
    /** Blanket ceiling per IP across /api. Generous — this is a runaway backstop, not a quota. */
    get rateLimitApiPerMin()   { return _num('RATE_LIMIT_API_PER_MIN', 300) },
    /** Sign-in / sign-up attempts per IP per 15 min. The credential-stuffing gate. */
    get rateLimitAuthPer15m()  { return _num('RATE_LIMIT_AUTH_PER_15M', 20) },
    /** Agent turns per session per 15 min. This one is a COST ceiling: every turn buys tokens. */
    get rateLimitAgentPer15m() { return _num('RATE_LIMIT_AGENT_PER_15M', 60) },
    /** Escape hatch for load testing. Opt-IN, and logged loudly at boot when it is on. */
    get rateLimitDisabled()    { return _bool('RATE_LIMIT_DISABLED', 'opt-in') },

    // ── misc ──
    /** How often the outbound-HTTP meter logs its rolling counts. */
    get httpMeterMs() { return _num('HTTP_METER_MS', 60_000) },
    /** Retries after a TRANSIENT provider failure (429 / 5xx). 0 disables. Per-call overridable. */
    get httpRetries()     { return _num('HTTP_RETRIES', 2) },
    /** Backoff base: the first wait is a jittered 0…base ms, then doubling. */
    get httpRetryBaseMs() { return _num('HTTP_RETRY_BASE_MS', 300) },
}

// ─── validation ───────────────────────────────────────────────────────────────

/** Values without which the process cannot do its job at all. */
const REQUIRED = ['MONGODB_URI', 'JWT_SECRET']

/** Every key the schema above claims — the basis for the unknown-key (typo) report. */
export const KNOWN_KEYS = new Set([
    'MONGODB_URI', 'JWT_SECRET', 'PORT', 'NODE_ENV', 'CLIENT_URL',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TOKEN_BUDGET_USD', 'TOKEN_DEGRADE_USD',
    'FMP_API_KEY', 'MASSIVE_API_KEY', 'FINNHUB_API_KEY', 'FRED_API_KEY', 'GNEWS_API_KEY',
    'CHART_IMG_API_KEY', 'SEC_USER_AGENT', 'USE_FMP_CANDLES', 'FMP_QUOTE_TTL_MS',
    'CANDLE_CACHE_INTRADAY_MS', 'CANDLE_CACHE_DAILY_MS', 'QUOTE_FEED_MAX_AGE_MS',
    'OWN_CHART_RENDER', 'OWN_CHART_RENDER_TIMEOUT_MS', 'OWN_CHART_RENDER_PAGE_TIMEOUT_MS',
    'OWN_CHART_RENDER_CONCURRENCY',
    'PAPER_FILL_INTERVAL_MS', 'PAPER_MARK_INTERVAL_MS', 'PAPER_EQUITY_SNAPSHOT_MS',
    'PAPER_QUOTE_TTL_MS', 'PAPER_FAST_QUOTE_TTL_MS',
    'MARKET_BRIEF_TTL_MS', 'MARKET_BRIEF_OFFER_HOUR_UTC', 'MARKET_BRIEF_OFFER',
    'CTRADER_CLIENTID', 'CTRADER_SECRET', 'CTRADER_REDIRECT_URI', 'CTRADER_REDIRECT_URL_PROD',
    'IBKR_CLIENT_ID', 'IBKR_CLIENT_SECRET', 'IBKR_REDIRECT_URI',
    'IBKR_GW_HOST', 'IBKR_GW_PORT', 'IBKR_GW_CLIENTID',
    'HTTP_METER_MS', 'HTTP_RETRIES', 'HTTP_RETRY_BASE_MS',
    'DNS_SERVERS', 'SHUTDOWN_GRACE_MS', 'UNHANDLED_REJECTION_FATAL', 'TRUST_PROXY_HOPS',
    'INSTANCE_LEASE_TTL_MS', 'INSTANCE_LEASE_RENEW_MS', 'DB_NAME',
    'RATE_LIMIT_API_PER_MIN', 'RATE_LIMIT_AUTH_PER_15M', 'RATE_LIMIT_AGENT_PER_15M',
    'RATE_LIMIT_DISABLED',
])

/**
 * Read every value once so the malformed-value ledger is populated, then report.
 *
 * @returns {{ missing: string[], malformed: {key: string, value: string}[] }}
 */
export function validateConfig() {
    // Touching every getter is what fills `_malformed` — the readers record as they parse.
    for (const key of Object.keys(Object.getOwnPropertyDescriptors(config))) {
        try { void config[key] } catch { /* a getter that throws is not a config problem */ }
    }
    return {
        missing:   REQUIRED.filter(k => !process.env[k]),
        malformed: [..._malformed].map(([key, value]) => ({ key, value })),
    }
}

/**
 * Keys that came from `.env` but that no schema entry claims. This is the typo detector: a
 * misspelled `CANDLE_CACHE_INTRADY_MS` is unreachable by definition, so it can only be caught from
 * this side. Empty on a platform deploy, where there is no .env to compare against.
 */
export function unknownConfigKeys() {
    return Object.keys(_dotenvParsed).filter(k => !KNOWN_KEYS.has(k)).sort()
}
