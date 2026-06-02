/**
 * IBKR Client Portal Web API provider — STATELESS.
 *
 * Implements OAuth 2.0 + REST calls to Interactive Brokers Client Portal API.
 * No global token store — the adapter layer owns token persistence (MongoDB).
 *
 * Docs:  https://www.interactivebrokers.com/en/trading/ib-api.php
 * OAuth: https://interactivebrokers.github.io/cpwebapi/
 *
 * Required env vars (add to .env when you register your app at IBKR):
 *   IBKR_CLIENT_ID
 *   IBKR_CLIENT_SECRET
 *   IBKR_REDIRECT_URI   e.g. http://localhost:3030/api/broker/callback
 *
 * NOTE: The exact OAuth endpoint URLs below are based on IBKR's documentation.
 * Verify them at https://www.interactivebrokers.com/en/trading/ib-api.php
 * after registering your app.
 */

import https from 'https'
import { logger } from '../services/logger.service.js'

const LOG = '[ibkr.provider]'

const BASE_URL   = 'https://api.ibkr.com/v1/api'
const AUTH_HOST  = 'www.interactivebrokers.com'
const AUTH_PATH  = '/oauth2/authorize'
const TOKEN_HOST = 'www.interactivebrokers.com'
const TOKEN_PATH = '/oauth2/token'

// In-memory cache: symbol → conid (contract ID), shared across all users
// Conids don't change so a global cache is safe
const _conidCache = new Map()

// ─── OAuth URLs ───────────────────────────────────────────────────────────────

/**
 * Build the IBKR OAuth 2.0 authorization URL.
 * @param {string} [state]  CSRF / context token to round-trip through OAuth
 * @returns {string}
 */
export function getAuthUrl(state) {
    const clientId    = process.env.IBKR_CLIENT_ID
    const redirectUri = encodeURIComponent(process.env.IBKR_REDIRECT_URI ?? '')
    const stateParam  = state ? `&state=${encodeURIComponent(state)}` : ''
    return (
        `https://${AUTH_HOST}${AUTH_PATH}` +
        `?response_type=code` +
        `&client_id=${clientId}` +
        `&redirect_uri=${redirectUri}` +
        `&scope=trading` +
        stateParam
    )
}

/**
 * Exchange an authorisation code for tokens.
 * Does NOT store anything — caller is responsible for persistence.
 * @param {string} code
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
 */
export async function exchangeCode(code) {
    const body = new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  process.env.IBKR_REDIRECT_URI   ?? '',
        client_id:     process.env.IBKR_CLIENT_ID      ?? '',
        client_secret: process.env.IBKR_CLIENT_SECRET  ?? '',
    }).toString()

    const data = await _postForm(TOKEN_HOST, TOKEN_PATH, body)
    logger.info(LOG, 'Tokens obtained via code exchange')
    return _normalize(data)
}

/**
 * Refresh an access token.
 * Does NOT store anything — caller is responsible for persistence.
 * @param {{ refreshToken: string }} tokens
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
 */
export async function refreshTokens({ refreshToken }) {
    if (!refreshToken) throw new Error('IBKR: no refresh token provided')

    const body = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     process.env.IBKR_CLIENT_ID     ?? '',
        client_secret: process.env.IBKR_CLIENT_SECRET ?? '',
    }).toString()

    const data = await _postForm(TOKEN_HOST, TOKEN_PATH, body)
    logger.info(LOG, 'Access token refreshed')
    return _normalize(data)
}

// ─── REST ─────────────────────────────────────────────────────────────────────

/**
 * GET {BASE_URL}{path} using the provided access token.
 * @param {string} path         e.g. '/portfolio/accounts'
 * @param {{ accessToken: string }} tokens
 * @returns {Promise<object>}
 */
export async function get(path, { accessToken }) {
    if (!accessToken) throw new Error('IBKR: no access token provided')
    return _request('GET', `${BASE_URL}${path}`, accessToken)
}

// ─── Market data ──────────────────────────────────────────────────────────────

/**
 * Resolve a ticker symbol to an IBKR contract ID (conid).
 * Results cached in-memory for the lifetime of the process.
 * @param {string} symbol  e.g. 'AAPL'
 * @param {{ accessToken: string }} tokens
 * @returns {Promise<string>}
 */
export async function resolveConid(symbol, tokens) {
    const key = symbol.toUpperCase()
    if (_conidCache.has(key)) return _conidCache.get(key)

    const results = await get(
        `/iserver/secdef/search?symbol=${encodeURIComponent(key)}&name=true&secType=STK`,
        tokens
    )
    const list = Array.isArray(results) ? results : []
    if (list.length === 0) throw new Error(`IBKR: no contract found for symbol ${symbol}`)

    // Prefer US stocks (primaryExch: NASDAQ/NYSE/ARCA)
    const us = list.find(r => ['NASDAQ', 'NYSE', 'ARCA', 'BATS'].includes(r.primaryExch)) ?? list[0]
    const conid = String(us.conid)

    _conidCache.set(key, conid)
    logger.info(LOG, `Resolved ${symbol} → conid ${conid}`)
    return conid
}

/**
 * Fetch OHLCV bars.
 * @param {string} symbol
 * @param {{ period: string, bar: string }} opts   e.g. { period: '1y', bar: '1d' }
 * @param {{ accessToken: string }} tokens
 * @returns {Promise<Array<{t,o,h,l,c,v}>>}
 */
export async function getHistoricalBars(symbol, { period, bar }, tokens) {
    const conid = await resolveConid(symbol, tokens)
    const path  = `/iserver/marketdata/history?conid=${conid}&period=${period}&bar=${bar}&outsideRth=true`
    const raw   = await get(path, tokens)
    const data  = Array.isArray(raw?.data) ? raw.data : []
    return data.map(b => ({
        t: b.t,
        o: Number(b.o),
        h: Number(b.h),
        l: Number(b.l),
        c: Number(b.c),
        v: Number(b.v),
    }))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _normalize(data) {
    return {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        expiresIn:    Number(data.expires_in) || 3600,
    }
}

function _request(method, url, token) {
    return new Promise((resolve, reject) => {
        const parsed  = new URL(url)
        const options = {
            hostname: parsed.hostname,
            path:     parsed.pathname + parsed.search,
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept':        'application/json',
            },
        }
        https.request(options, (res) => {
            let raw = ''
            res.on('data', chunk => { raw += chunk })
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw)
                    if (res.statusCode >= 400) {
                        const err = new Error(`IBKR API ${res.statusCode}: ${JSON.stringify(data)}`)
                        err.status = res.statusCode
                        return reject(err)
                    }
                    resolve(data)
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message}`))
                }
            })
        }).on('error', reject).end()
    })
}

function _postForm(hostname, path, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname,
            path,
            method: 'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        }
        const req = https.request(options, (res) => {
            let raw = ''
            res.on('data', chunk => { raw += chunk })
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw)
                    if (res.statusCode >= 400) {
                        const err = new Error(`IBKR OAuth ${res.statusCode}: ${data?.error_description ?? raw}`)
                        err.status = res.statusCode
                        return reject(err)
                    }
                    resolve(data)
                } catch (e) {
                    reject(new Error(`OAuth JSON parse error: ${e.message}`))
                }
            })
        })
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}
