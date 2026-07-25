// The single source of truth for Kairos's analytical MODES (KAIROS_MODES.md). ONE agent, three
// profiles — the mode is a build-time lens (selects prompt profile + tool subset + pattern vocab);
// it is lens-agnostic to the output schema and never touches the gate or Hermes.
//
// discretionary : classical price action — structure, momentum, false-breaks. (default)
// smc           : strict smart-money — order-blocks, FVG, liquidity, BOS/CHoCH, premium/discount.
// institutional : macro/regime + relative-strength + positioning (chart-light).

export const MODES = ['discretionary', 'smc', 'institutional']
export const DEFAULT_MODE = 'discretionary'

/** Coerce any input to a known mode; unknown/absent → discretionary. */
export function normalizeMode(mode) {
    return MODES.includes(mode) ? mode : DEFAULT_MODE
}

export function isMode(mode) {
    return MODES.includes(mode)
}
