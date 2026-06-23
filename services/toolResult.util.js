/**
 * Shared marker so a tool handler can signal a genuine failure (upstream API
 * error, bad input, no data) distinctly from a real result. The providers turn
 * this into an error-flagged tool_result — Anthropic sets `is_error: true`,
 * OpenAI gets an `ERROR:` prefix — so the model treats it as "the call failed",
 * never as a finding. Without this, an error string like "Could not fetch
 * correlations: …" reads to the LLM exactly like data, and a mandate such as
 * "check correlations before finalizing" can be silently satisfied by a failure.
 */

// Symbol.for so the marker is identical across module instances / providers.
const TOOL_ERROR = Symbol.for('botmarket.toolError')

/** Wrap a failure message so providers flag it as an error tool_result. */
export function toolError(message) {
    return { [TOOL_ERROR]: true, message: String(message ?? 'Tool call failed') }
}

/** True if a handler return is a toolError() marker. */
export function isToolError(ret) {
    return Boolean(ret && typeof ret === 'object' && ret[TOOL_ERROR])
}

/** Human-readable text of a toolError() marker. */
export function toolErrorText(ret) {
    return ret?.message ?? 'Tool call failed'
}
