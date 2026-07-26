// Race a promise against a timeout so a single hung IO call (LLM/vision/price fetch)
// can't wedge its caller forever — in a poll loop an unbounded await keeps the loop's
// `running` flag true and every later tick skips; in a request path it holds the socket.
// The underlying promise is left to settle on its own (best-effort, not cancellable);
// the caller just stops waiting.
//
// Lives in services/ (not monitoring/) so both layers can reach it without an upward
// import — monitoring/ may import from services/, never the reverse. THE one timeout
// guard: monitors, coverage refresh, and the chart-image cache all use this.
//
// `label` names the operation in the rejection message ("<label> timed out after Nms").
// Defaults to 'check' so the monitors' long-standing message text is unchanged.
export function withTimeout(promise, ms, label = 'check') {
    let t
    const timeout = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}
