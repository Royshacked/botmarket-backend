// Shared JSON-over-HTTP helper: fetch with an AbortController timeout and a
// status check. Transport only — callers keep their own try/catch and decide
// whether to swallow the error (return a string/empty) or rethrow.

export async function getJson(url, { headers, timeoutMs = 10000, label } = {}) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
        const res = await fetch(url, { headers, signal: ac.signal })
        if (!res.ok) throw new Error(`${label || 'http'} ${res.status}`)
        return await res.json()
    } finally {
        clearTimeout(timer)
    }
}
