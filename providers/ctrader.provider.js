/**
 * cTrader Open API provider — STATELESS.
 *
 * All functions are pure: they accept tokens as arguments and return new tokens.
 * No global token store — the adapter layer owns token persistence (MongoDB).
 *
 * Docs: https://help.ctrader.com/open-api/
 * App registration: https://openapi.ctrader.com/apps
 *
 * Required env vars:
 *   CTRADER_CLIENTID      numeric App ID from the portal (e.g. 29413)
 *   CTRADER_SECRET        Client Secret from the portal
 *   CTRADER_REDIRECT_URI  e.g. http://localhost:3030/api/broker/callback
 */

import https from 'https'
import { logger } from '../services/logger.service.js'

const LOG = '[ctrader.provider]'

const BASE_URL    = 'https://api.spotware.com/connect'
const TOKEN_HOST  = 'openapi.ctrader.com'
const TOKEN_PATH  = '/apps/token'
const AUTH_BASE   = 'https://id.ctrader.com/my/settings/openapi/grantingaccess/'

function _redirectUri() {
    return process.env.NODE_ENV === 'production'
        ? (process.env.CTRADER_REDIRECT_URL_PROD ?? '')
        : (process.env.CTRADER_REDIRECT_URI ?? '')
}

// ─── OAuth URLs ───────────────────────────────────────────────────────────────

/**
 * Build the URL to redirect the user to for cTrader login + consent.
 * @param {string} [state]  CSRF / context token to round-trip through OAuth
 * @returns {string}
 */
export function getAuthUrl(state) {
    const clientId    = process.env.CTRADER_CLIENTID ?? ''
    const redirectUri = encodeURIComponent(_redirectUri())
    const stateParam  = state ? `&state=${encodeURIComponent(state)}` : ''
    return (
        `${AUTH_BASE}` +
        `?client_id=${clientId}` +
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
    const params = new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  _redirectUri(),
        client_id:     process.env.CTRADER_CLIENTID ?? '',
        client_secret: process.env.CTRADER_SECRET ?? '',
    })

    const data = await _getToken(params)
    logger.info(LOG, 'Tokens obtained via code exchange')
    return _normalize(data)
}

/**
 * Refresh an access token using an existing refresh token.
 * Does NOT store anything — caller is responsible for persistence.
 * @param {{ refreshToken: string }} tokens
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
 */
export async function refreshTokens({ refreshToken }) {
    if (!refreshToken) throw new Error('cTrader: no refresh token provided')

    const params = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     process.env.CTRADER_CLIENTID ?? '',
        client_secret: process.env.CTRADER_SECRET ?? '',
    })

    const data = await _getToken(params)
    logger.info(LOG, 'Access token refreshed')
    return _normalize(data)
}

// ─── REST ─────────────────────────────────────────────────────────────────────

/**
 * GET /connect/{path} using the provided access token.
 * @param {string} path         e.g. '/tradingaccounts'
 * @param {{ accessToken: string }} tokens
 * @returns {Promise<object>}
 */
export async function get(path, { accessToken }) {
    if (!accessToken) throw new Error('cTrader: no access token provided')
    return _request('GET', `${BASE_URL}${path}`, accessToken)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _normalize(data) {
    return {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        expiresIn:    Number(data.expires_in) || 3600,
    }
}

/** Token endpoint now uses GET with query params (openapi.ctrader.com). */
function _getToken(params) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: TOKEN_HOST,
            path:     `${TOKEN_PATH}?${params.toString()}`,
            method:   'GET',
            headers:  { 'Accept': 'application/json' },
        }
        https.request(options, (res) => {
            let raw = ''
            res.on('data', chunk => { raw += chunk })
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw)
                    if (res.statusCode >= 400) {
                        const err = new Error(`cTrader OAuth ${res.statusCode}: ${data?.errorCode ?? data?.error_description ?? raw}`)
                        err.status = res.statusCode
                        return reject(err)
                    }
                    resolve(data)
                } catch (e) {
                    reject(new Error(`OAuth JSON parse error: ${e.message}`))
                }
            })
        }).on('error', reject).end()
    })
}

function _request(method, url, token) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url)
        parsed.searchParams.set('oauth_token', token)
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
                        const err = new Error(`cTrader API ${res.statusCode}: ${data?.description ?? raw}`)
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
