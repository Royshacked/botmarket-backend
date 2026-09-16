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

import { logger } from '../services/logger.service.js'
import { getJson } from '../services/http.util.js'
import { config } from '../services/config.js'

const LOG = '[ctrader.provider]'

const BASE_URL    = 'https://api.spotware.com/connect'
const TOKEN_URL   = 'https://openapi.ctrader.com/apps/token'
const AUTH_BASE   = 'https://id.ctrader.com/my/settings/openapi/grantingaccess/'

function _redirectUri() {
    return config.ctraderRedirectUri
}

// ─── OAuth URLs ───────────────────────────────────────────────────────────────

/**
 * Build the URL to redirect the user to for cTrader login + consent.
 * @param {string} [state]  CSRF / context token to round-trip through OAuth
 * @returns {string}
 */
export function getAuthUrl(state) {
    const clientId    = config.ctraderClientId
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
        client_id:     config.ctraderClientId,
        client_secret: config.ctraderSecret,
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
        client_id:     config.ctraderClientId,
        client_secret: config.ctraderSecret,
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

// Both cTrader reads go through the shared pipe (timeout, meter, typed status, retry on 429/5xx).
// They were two ~30-line hand-rolled https.request promises, byte-for-byte alike but for the error
// text, with no timeout and no place in the minute-summary. What survives of each is the one thing
// that was its own: the wording of the refusal, built from the body the pipe hands back.

/** Token endpoint now uses GET with query params (openapi.ctrader.com). */
async function _getToken(params) {
    try {
        return await getJson(`${TOKEN_URL}?${params.toString()}`, { headers: { Accept: 'application/json' }, label: 'cTrader /apps/token' })
    } catch (err) {
        throw _withDetail(err, 'cTrader OAuth', b => b?.errorCode ?? b?.error_description)
    }
}

async function _request(method, url, token) {
    const parsed = new URL(url)
    parsed.searchParams.set('oauth_token', token)
    try {
        return await getJson(parsed.toString(), {
            method,
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            label:   `cTrader ${parsed.pathname.replace(/^\/connect/, '')}`,
        })
    } catch (err) {
        throw _withDetail(err, 'cTrader API', b => b?.description)
    }
}

/**
 * Re-word a pipe error in this provider's voice, keeping `status` (the adapter reads it — a 401 is
 * "reconnect", not "retry"). A network error or timeout has no status and passes through as it is.
 */
function _withDetail(err, prefix, pick) {
    if (!err?.status) return err
    const body   = err.body
    const detail = pick(typeof body === 'object' && body ? body : null) ?? (typeof body === 'string' ? body : JSON.stringify(body ?? ''))
    const out = new Error(`${prefix} ${err.status}: ${detail}`)
    out.status = err.status
    out.body   = body
    return out
}
