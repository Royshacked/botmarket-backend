import { test } from 'node:test'
import assert from 'node:assert/strict'

import { config, KNOWN_KEYS, validateConfig, unknownConfigKeys } from '../../services/config.js'

// The config module replaced 43 environment variables read as inline expressions at ~70 sites.
// These hold the two properties that make that worth having: it does not lie about what it reads,
// and it does not reach for the real environment while the suite is running.

// ── the test gate ─────────────────────────────────────────────────────────────

test('config does NOT load .env under the test runner', () => {
    // Load-bearing, not hygiene. The unit suite has always run offline — by accident, because .env
    // was only ever loaded by server.js. Several tests depend on it: notifyCard asserts "posting a
    // card never throws", and it passes because the write cannot reach a database. When config
    // started loading .env everywhere, those became live connections to the PRODUCTION cluster
    // that hung the runner. `unknownConfigKeys` is empty iff nothing was parsed from a .env file.
    assert.deepEqual(unknownConfigKeys(), [],
        'config parsed a .env file inside the test runner — the suite is no longer offline')
})

// ── the schema ────────────────────────────────────────────────────────────────

test('every documented key is registered, so the typo detector cannot cry wolf', () => {
    // unknownConfigKeys reports .env keys that KNOWN_KEYS does not claim. A getter added without
    // its key registered turns a legitimate setting into a "typo" warning at every boot.
    for (const key of ['MONGODB_URI', 'JWT_SECRET', 'ANTHROPIC_API_KEY', 'FMP_API_KEY',
        'CANDLE_CACHE_INTRADAY_MS', 'PAPER_FILL_INTERVAL_MS', 'CTRADER_CLIENTID', 'IBKR_GW_HOST']) {
        assert.ok(KNOWN_KEYS.has(key), `${key} missing from KNOWN_KEYS`)
    }
})

test('reads are LIVE, not frozen at import', () => {
    // Getters, deliberately. ESM hoists imports above top-level statements, so a test that sets
    // process.env to exercise a failure path lands AFTER every module has loaded — only a live read
    // sees it. protectionPlanParseFail.test.js relies on exactly this.
    const before = config.tokenBudgetUsd
    process.env.TOKEN_BUDGET_USD = '999'
    try {
        assert.equal(config.tokenBudgetUsd, 999)
    } finally {
        delete process.env.TOKEN_BUDGET_USD
    }
    assert.equal(config.tokenBudgetUsd, before, 'value must return to its default once unset')
})

// ── parsing ───────────────────────────────────────────────────────────────────

test('an absent numeric falls back to its default', () => {
    delete process.env.CANDLE_CACHE_INTRADAY_MS
    assert.equal(config.candleCacheIntradayMs, 30_000)
    assert.equal(config.paperFillIntervalMs, 3_000)
    assert.equal(config.port, 3030)
})

test('a MALFORMED numeric falls back AND is reported — the case that used to be silent', () => {
    // `CANDLE_CACHE_INTRADAY_MS=abc` produced NaN, `|| default` swallowed it, and the system ran on
    // a setting nobody chose. The fallback still happens (nothing should crash mid-request over a
    // cache TTL) but startup now refuses to continue.
    process.env.CANDLE_CACHE_INTRADAY_MS = 'abc'
    try {
        assert.equal(config.candleCacheIntradayMs, 30_000, 'still falls back')
        const { malformed } = validateConfig()
        assert.deepEqual(malformed.filter(m => m.key === 'CANDLE_CACHE_INTRADAY_MS'),
            [{ key: 'CANDLE_CACHE_INTRADAY_MS', value: 'abc' }])
    } finally {
        delete process.env.CANDLE_CACHE_INTRADAY_MS
    }
    assert.deepEqual(validateConfig().malformed, [], 'the report clears once the value is fixed')
})

test('the three boolean spellings each keep their own contract', () => {
    // Not unified: each is a live contract with someone's deployment.
    // off-switch — anything but the literal 'off' is ON
    process.env.MARKET_BRIEF_OFFER = 'off';   assert.equal(config.marketBriefOffer, false)
    process.env.MARKET_BRIEF_OFFER = 'false'; assert.equal(config.marketBriefOffer, true)
    delete process.env.MARKET_BRIEF_OFFER;    assert.equal(config.marketBriefOffer, true)

    // false-0 — 'false' or '0' turns it OFF, anything else (incl. unset) ON
    process.env.OWN_CHART_RENDER = 'false'; assert.equal(config.ownChartRender, false)
    process.env.OWN_CHART_RENDER = '0';     assert.equal(config.ownChartRender, false)
    process.env.OWN_CHART_RENDER = 'yes';   assert.equal(config.ownChartRender, true)
    delete process.env.OWN_CHART_RENDER;    assert.equal(config.ownChartRender, true)

    // opt-in — only true/1/yes turn it ON
    delete process.env.USE_FMP_CANDLES;      assert.equal(config.useFmpCandles, false)
    process.env.USE_FMP_CANDLES = 'true';    assert.equal(config.useFmpCandles, true)
    process.env.USE_FMP_CANDLES = 'YES';     assert.equal(config.useFmpCandles, true)
    process.env.USE_FMP_CANDLES = 'maybe';   assert.equal(config.useFmpCandles, false)
    delete process.env.USE_FMP_CANDLES
})

test('missing REQUIRED values are reported, and are the only fatal ones', () => {
    const saved = { uri: process.env.MONGODB_URI, secret: process.env.JWT_SECRET }
    delete process.env.MONGODB_URI
    delete process.env.JWT_SECRET
    try {
        assert.deepEqual(validateConfig().missing, ['MONGODB_URI', 'JWT_SECRET'])
        // An absent API key is NOT fatal: a deployment without a FRED key simply has no macro feed,
        // which must not stop the app from serving trades.
        assert.equal(config.fredApiKey, undefined)
    } finally {
        if (saved.uri) process.env.MONGODB_URI = saved.uri
        if (saved.secret) process.env.JWT_SECRET = saved.secret
    }
})

test('ctraderRedirectUri follows NODE_ENV rather than being set twice', () => {
    process.env.CTRADER_REDIRECT_URI = 'http://dev/cb'
    process.env.CTRADER_REDIRECT_URL_PROD = 'https://prod/cb'
    const savedEnv = process.env.NODE_ENV
    try {
        process.env.NODE_ENV = 'development'
        assert.equal(config.ctraderRedirectUri, 'http://dev/cb')
        process.env.NODE_ENV = 'production'
        assert.equal(config.ctraderRedirectUri, 'https://prod/cb')
    } finally {
        if (savedEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = savedEnv
        delete process.env.CTRADER_REDIRECT_URI
        delete process.env.CTRADER_REDIRECT_URL_PROD
    }
})

// ── the DNS override (A3) ─────────────────────────────────────────────────────
//
// This was an unconditional `dns.setServers(['8.8.8.8','1.1.1.1'])` on line 5 of server.js, added
// because a developer's router blocks the SRV queries a `mongodb+srv://` URI needs. Being global,
// it also overrode whatever resolver a container or VPC supplies — so a private Mongo endpoint
// would be unresolvable in production, presenting as a Mongo outage rather than as a DNS override
// nobody remembered making. What matters is the DEFAULT on each side, because that is what ships.

test('dnsServers defaults: the dev workaround stays, production gets the platform resolver', () => {
    const savedEnv = process.env.NODE_ENV
    const savedDns = process.env.DNS_SERVERS
    delete process.env.DNS_SERVERS
    try {
        process.env.NODE_ENV = 'development'
        assert.deepEqual(config.dnsServers, ['8.8.8.8', '1.1.1.1'],
            'unchanged on the dev box — the router that prompted this still blocks SRV')

        process.env.NODE_ENV = 'production'
        assert.deepEqual(config.dnsServers, [],
            'never ship a global resolver override; server.js skips setServers entirely on empty')
    } finally {
        if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv
        if (savedDns !== undefined) process.env.DNS_SERVERS = savedDns
    }
})

test('dnsServers is overridable in BOTH directions', () => {
    const savedEnv = process.env.NODE_ENV
    const savedDns = process.env.DNS_SERVERS
    try {
        // Opt a deployment IN.
        process.env.NODE_ENV = 'production'
        process.env.DNS_SERVERS = '10.0.0.2, 10.0.0.3'
        assert.deepEqual(config.dnsServers, ['10.0.0.2', '10.0.0.3'], 'trimmed, in order')

        // Opt a dev box OUT. An explicitly empty value must CLEAR rather than fall back to the
        // default — which is why this getter reads process.env directly instead of via _str.
        process.env.NODE_ENV = 'development'
        process.env.DNS_SERVERS = ''
        assert.deepEqual(config.dnsServers, [])
    } finally {
        if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv
        if (savedDns === undefined) delete process.env.DNS_SERVERS; else process.env.DNS_SERVERS = savedDns
    }
})

test('trustProxyHops is 0 outside production — a dev box has no proxy to trust', () => {
    // Trusting a hop that does not exist lets any caller forge X-Forwarded-For and mint a fresh
    // rate-limit bucket per request, which is the limiter quietly not existing.
    const savedEnv = process.env.NODE_ENV
    try {
        process.env.NODE_ENV = 'development'
        assert.equal(config.trustProxyHops, 0)
        process.env.NODE_ENV = 'production'
        assert.equal(config.trustProxyHops, 1)
    } finally {
        if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv
    }
})

test('the new hardening keys are all registered, so none reads as a typo at boot', () => {
    for (const key of ['DNS_SERVERS', 'SHUTDOWN_GRACE_MS', 'UNHANDLED_REJECTION_FATAL',
        'TRUST_PROXY_HOPS', 'RATE_LIMIT_API_PER_MIN', 'RATE_LIMIT_AUTH_PER_15M',
        'RATE_LIMIT_AGENT_PER_15M', 'RATE_LIMIT_DISABLED']) {
        assert.ok(KNOWN_KEYS.has(key), `${key} missing from KNOWN_KEYS`)
    }
})
