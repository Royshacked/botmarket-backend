// Shared JSON-over-HTTP helper: fetch with an AbortController timeout and a
// status check. Transport only — callers keep their own try/catch and decide
// whether to swallow the error (return a string/empty) or rethrow.

export async function getJson(url, { headers, timeoutMs = 10000, label } = {}) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
        const res = await fetch(url, { headers, signal: ac.signal })
        if (!res.ok) {
            // The status rides on the error, not just in its text. "Try again in a second"
            // (429, 5xx) and "your plan does not include this" (402, 403) are opposite
            // instructions, and a caller that can only read the message has to regex the
            // number back out to tell them apart — or, worse, treat them the same.
            const err = new Error(`${label || 'http'} ${res.status}`)
            err.status = res.status
            throw err
        }
        return await res.json()
    } finally {
        clearTimeout(timer)
    }
}
