/**
 * `get_company_view` — Axl's read of the house's work on ONE company (docs/design/axl-one-voice.md, Roy 2026-11-21): the
 * analyst's coverage, our measured technical profile, the events we mapped that reach it — each with a verdict code
 * decided — and the background work a missing or invalid coverage needs, started (services/companyView.service.js).
 *
 * Bound to the user (their own events) and the session (where the "ready" line goes); in a direct message there is no
 * session, and the build still runs — only the line has nowhere to go.
 */

import { makeToolHandler } from '../agentUtils.js'
import { companyView as defaultCompanyView, formatCompanyView } from '../companyView.service.js'

const LOG = '[companyViewTool]'

export const COMPANY_VIEW_TOOL_SPEC = {
    get_company_view: `The HOUSE'S WORK on one company: the analyst's coverage (rating, our target and why, the thesis, bull/bear, catalysts, what breaks it, the revisions) with a verdict — VALID, STALE, WITHDRAWN or none; our technical profile, measured from its candles (what holds, ATR, false breaks, day trade or swing); and the events we mapped that reach it. Call it for a VIEW on a company — is it a buy, how is it for the long term, the risks, the valuation, how it trades, is it exposed to an event — not for "what happened / why is it down" (that is the news). A missing or invalid coverage is built or re-modelled in the background by this call — the result says so; tell the user, and a line comes to the chat when it lands. Answer in your own voice: each part said as the house's, dated; your own reading (news, web, knowledge) as yours.`,
}

/** @returns {{ get_company_view: Function }} */
export function makeCompanyViewHandlers({ userId = null, sessionId = null, view = defaultCompanyView } = {}) {
    return {
        get_company_view: makeToolHandler('get_company_view', async ({ symbol } = {}) => {
            const v = await view.view({ symbol, userId, sessionId })
            if (v.invalid) return 'symbol is required — one ticker, e.g. NVDA'
            return formatCompanyView(v)
        }, (err) => `Could not read the house's work on that company: ${err.message}`, LOG),
    }
}
