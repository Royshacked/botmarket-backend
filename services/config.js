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
 *    entry claims, which is exactly what a typo looks like. The set of claimed keys is DERIVED — each
 *    reader records the key it read — so a getter cannot be added without its key being known. (It
 *    was a hand-kept list beside the getters, guarded by a test that could only catch the eight it
 *    named — and it was already one short: GUARD_SWEEP_INTERVAL_MS had a getter and no entry, so
 *    setting it in .env would have been reported as a typo at every boot.)
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
const _known     = new Set()   // every key any reader has read — the schema, derived

/** The one read of process.env. Every reader goes through it, so the key is known from the read. */
function _raw(key) {
    _known.add(key)
    return process.env[key]
}

function _str(key, fallback = '') {
    const raw = _raw(key)
    return (typeof raw === 'string' && raw !== '') ? raw : fallback
}

/** A number, falling back when absent OR unparseable — and remembering which of the two it was. */
function _num(key, fallback) {
    const raw = _raw(key)
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
    const value = _raw(key)
    const raw = String(value ?? '').toLowerCase()
    if (mode === 'off-switch') return value !== 'off'
    if (mode === 'false-0')    return raw !== 'false' && raw !== '0'
    return ['true', '1', 'yes'].includes(raw)
}

// ─── the schema ───────────────────────────────────────────────────────────────

export const config = {
    // ── core ──
    /** Mongo connection string. REQUIRED — the app cannot serve a request without it. */
    get mongoUri()  { return _raw('MONGODB_URI') },
    // Which database on that cluster. UNSET is the historical behaviour — the name comes from the
    // URI path, and an `mongodb+srv://host/` with no path lands on `test`. It exists so a developer
    // can point a laptop at its OWN database on the shared cluster: sharing one meant local dev and
    // the deployed instance contended for the SAME background-loops lease, the laptop always lost,
    // and every paper fill it executed went onto an in-process executionBus with no reconciler on
    // it (2026-08-20). Leave it unset in the deployed environment.
    get dbName()    { return _raw('DB_NAME') || null },
    /** Signing secret for the session JWT and the broker OAuth `state`. REQUIRED. */
    get jwtSecret() { return _raw('JWT_SECRET') },
    get port()      { return _num('PORT', 3030) },
    get nodeEnv()   { return _str('NODE_ENV', 'development') },
    get isProduction() { return this.nodeEnv === 'production' },
    /** Where the browser is sent back to after a broker OAuth round trip. */
    get clientUrl() { return _str('CLIENT_URL', 'http://localhost:5173') },

    // ── LLM ──
    get anthropicApiKey() { return _raw('ANTHROPIC_API_KEY') },
    get openaiApiKey()    { return _raw('OPENAI_API_KEY') },        // transcription only
    // The non-Anthropic Talos candidates' accounts (TALOS_MODELS `endpoint`): OpenRouter fronts most
    // vendors behind one key; Mistral is read on their own API.
    get openrouterApiKey() { return _raw('OPENROUTER_API_KEY') },
    get mistralApiKey()    { return _raw('MISTRAL_API_KEY') },
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
    get fmpApiKey()     { return _raw('FMP_API_KEY') },
    get massiveApiKey() { return _raw('MASSIVE_API_KEY') },
    get finnhubApiKey() { return _raw('FINNHUB_API_KEY') },
    get fredApiKey()    { return _raw('FRED_API_KEY') },
    get gnewsApiKey()   { return _raw('GNEWS_API_KEY') },
    get chartImgApiKey() { return _raw('CHART_IMG_API_KEY') },
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
    // THE MARK LOOP IS PACED BY A QUOTE BUDGET, not by its interval alone. At 3s over 45 held symbols
    // it spent ~900 quotes a minute — before the open, all weekend — against a plan that allows a
    // few hundred, and the 429s it caused starved every other FMP read in the app (2026-09-21: a
    // Prometheus sizing came back "no forward revenue" while the marker ran). The sweep now waits
    // until symbols ÷ budget minutes have passed (45 symbols at 120/min → one mark every ~22s), and
    // outside the US session it sweeps once a minute — crypto and forex still move, equities do not.
    // `paperMarkFreshMs` is how old a stored mark may be before a positions READ re-prices the symbol
    // itself: longer than the slowest sweep, so a live leader is never second-guessed, and short
    // enough that a dead one ages out.
    get paperMarkQuoteBudgetPerMin() { return Math.max(1, _num('PAPER_MARK_QUOTE_BUDGET_PER_MIN', 120)) },
    get paperMarkClosedIntervalMs()  { return _num('PAPER_MARK_CLOSED_INTERVAL_MS', 60_000) },
    get paperMarkFreshMs()           { return _num('PAPER_MARK_FRESH_MS', 120_000) },
    get paperEquitySnapshotMs()   { return _num('PAPER_EQUITY_SNAPSHOT_MS', 300_000) },
    get paperQuoteTtlMs()         { return _num('PAPER_QUOTE_TTL_MS', 5_000) },

    // ── guard sweep (Talos tier-0) ──
    // How often armed setups' wake guards are evaluated, and therefore the resolution of every price
    // term in the system: a wick between two sweeps is invisible. 30s is a deliberate middle — far
    // finer than the 30-to-240-minute scheduled glance it replaces, and lazy enough that a book of
    // setups costs a handful of quotes a minute, deduped by symbol. Our own polling is what caused
    // the FMP 429s before, so this is the knob to turn UP if quota bites, not down.
    get guardSweepIntervalMs()    { return _num('GUARD_SWEEP_INTERVAL_MS', 30_000) },

    // ── Talos read recorder (the replay eval's input — monitoring/talos.recorder.js) ──
    // Opt-in: every Talos read is written to disk as a replayable bundle (prompt, trajectory, verdict,
    // frozen data pack). Off, the recorder is one boolean check per read and nothing else. The dir
    // is gitignored (`data/`) — bundles carry users' live trading plans.
    get talosRecordReads() { return _bool('TALOS_RECORD_READS', 'opt-in') },
    // `disk` (the default) writes files under talosRecordDir; `mongo` inserts into the `talos_reads`
    // collection of the app's own database — the sink for the deployed instance, whose disk is
    // ephemeral. `scripts/eval/talos-replay/pull-reads.mjs` brings those down to the disk layout.
    get talosRecordSink()  { return _str('TALOS_RECORD_SINK', 'disk') },
    get talosRecordDir()   { return _str('TALOS_RECORD_DIR', 'data/eval/talos-reads') },
    // The model behind Talos's CHEAP tier (monitoring/talos.cheap.js) — the numbers-only pass that
    // decides whether the expensive read runs. Deliberately its own knob, not the house Talos
    // model: paying the expensive tier's rate to decide whether to run the expensive tier would
    // defeat the point. Empty → the module's own default (Haiku 4.5, which the 95-read replay
    // measured at 78% slept).
    get talosCheapModel()  { return _str('TALOS_CHEAP_MODEL', '') },

    // ── market brief ──
    get marketBriefTtlMs()       { return _num('MARKET_BRIEF_TTL_MS', 45 * 60 * 1000) },
    get marketBriefOfferHourUtc() { return _num('MARKET_BRIEF_OFFER_HOUR_UTC', 12) },
    /** The daily offer card. Set to the literal 'off' to disable the fan-out. */
    get marketBriefOffer()       { return _bool('MARKET_BRIEF_OFFER', 'off-switch') },

    // ── web push ──
    // One VAPID key pair identifies this server to the browsers' push services (`npx web-push
    // generate-vapid-keys`). The public half is handed to the client at subscribe time; the
    // private half signs every send. Both unset = push is off and every card still lands in chat.
    get vapidPublicKey()  { return _raw('VAPID_PUBLIC_KEY')  || null },
    get vapidPrivateKey() { return _raw('VAPID_PRIVATE_KEY') || null },
    /** The contact the push services may reach about abuse — a mailto: or https: URL. Falls back
     *  to the app's own https origin, which is what it is in the deployed environment. */
    get vapidSubject()    {
        const own = _str('VAPID_SUBJECT', '')
        if (own) return own
        return this.clientUrl.startsWith('https:') ? this.clientUrl : 'mailto:admin@localhost'
    },

    // ── cTrader ──
    get ctraderClientId()  { return _str('CTRADER_CLIENTID') },
    get ctraderSecret()    { return _str('CTRADER_SECRET') },
    /**
     * The redirect URI differs by deployment, so it is chosen by NODE_ENV rather than set twice.
     * BOTH are read, so both keys are known whichever environment this is — a dev .env carrying the
     * production URI must not read as a typo.
     */
    get ctraderRedirectUri() {
        const prod = _str('CTRADER_REDIRECT_URL_PROD'), dev = _str('CTRADER_REDIRECT_URI')
        return this.isProduction ? prod : dev
    },

    // ── IBKR (data-only, in progress) — gateway coords only ──
    /** Gateway coords. A stored connection's own coords take precedence over these. */
    get ibkrGwHost()       { return _str('IBKR_GW_HOST', '127.0.0.1') },
    get ibkrGwPort()       { return _num('IBKR_GW_PORT', 4002) },
    get ibkrGwClientId()   { return _num('IBKR_GW_CLIENTID', 1) },

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
        const raw = _raw('DNS_SERVERS') ?? (this.isProduction ? '' : '8.8.8.8,1.1.1.1')
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
    get trustProxyHops() { const hops = _num('TRUST_PROXY_HOPS', 1); return this.isProduction ? hops : 0 },

    // ── rate limiting ──
    /** Blanket ceiling per IP across /api. Generous — this is a runaway backstop, not a quota. */
    get rateLimitApiPerMin()   { return _num('RATE_LIMIT_API_PER_MIN', 300) },
    /** Sign-in / sign-up attempts per IP per 15 min. The credential-stuffing gate. */
    get rateLimitAuthPer15m()  { return _num('RATE_LIMIT_AUTH_PER_15M', 20) },
    /** Agent turns per session per 15 min. This one is a COST ceiling: every turn buys tokens. */
    get rateLimitAgentPer15m() { return _num('RATE_LIMIT_AGENT_PER_15M', 60) },
    /** Escape hatch for load testing. Opt-IN, and logged loudly at boot when it is on. */
    get rateLimitDisabled()    { return _bool('RATE_LIMIT_DISABLED', 'opt-in') },

    // ── Aether engine scheduler ──
    /**
     * Absolute path to the aether-engine Python repo. When set, the backend spawns
     * scripts/scheduler.py from that directory as a child process on startup (loop-leader only).
     * Leave unset to disable the scheduler — the engine still serves its read endpoints normally.
     */
    get aetherEnginePath() { return _str('AETHER_ENGINE_PATH', '') },
    /**
     * The HOUSE database the engine reads and writes — the one the deployed instance is on
     * (`test`), where the daily news queue lands and where every admin's Aether list reads from.
     * Unset = the database this process is connected to, which is right everywhere except a
     * laptop on its own dev database: there, an engine pointed at the local clone reads a news
     * queue nobody refreshes and writes candidates nobody on the deployed app can see. When it
     * differs from the connected database, a finished discovery run is mirrored back locally
     * (aetherMirror.service).
     */
    get aetherDb() { return _str('AETHER_DB', '') || null },

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

/** Touch every getter: fills the malformed-value ledger AND the known-key set as the readers go. */
function _readAll() {
    for (const key of Object.keys(Object.getOwnPropertyDescriptors(config))) {
        try { void config[key] } catch { /* a getter that throws is not a config problem */ }
    }
}

/**
 * Every key the schema reads — DERIVED from the readers, never typed. A getter that reads a key
 * through `_raw` / `_str` / `_num` / `_bool` has registered it; a getter that reads `process.env`
 * directly has not, and the test that pins this set's size will say so.
 * @returns {Set<string>}
 */
export function knownKeys() {
    _readAll()
    return new Set(_known)
}

/**
 * Read every value once so the malformed-value ledger is populated, then report.
 *
 * @returns {{ missing: string[], malformed: {key: string, value: string}[] }}
 */
export function validateConfig() {
    _readAll()
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
    const known = knownKeys()
    return Object.keys(_dotenvParsed).filter(k => !known.has(k)).sort()
}
