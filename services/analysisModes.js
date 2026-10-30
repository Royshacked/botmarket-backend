// The analytical LENSES a trade can be built through — the shared vocabulary, not one desk's.
//
// Renamed from kairos.modes.js on 2026-08-18. Kairos defined these and is now archived, but the
// words outlived it: Argus stamps a `recommended_mode` on a hand-off (`isMode` guards it) and
// Mentor's tool kit reads DEFAULT_MODE. A lens is a way of reading a chart, which was never
// Kairos-specific — only the tool SUBSETTING was, and that stayed behind with the desk.
//
// discretionary : classical price action — structure, momentum, false-breaks. (default)
// smc           : strict smart-money — order-blocks, FVG, liquidity, BOS/CHoCH, premium/discount.
// institutional : macro/regime + relative-strength + positioning (chart-light).
// thesis        : the stop is where the thesis breaks (under the sellers' last swing), the targets where sellers
//                 last took over; the entry is a LEVEL from the user's risk limit / reward to risk, "the level and below",
//                 entered on strength Talos judges on the 1h / 4h (Roy, 2026-10-30; docs/design/stock-playbook.md).

export const MODES = ['discretionary', 'smc', 'institutional', 'thesis']
export const DEFAULT_MODE = 'discretionary'

/** Coerce any input to a known mode; unknown/absent → discretionary. */
export function normalizeMode(mode) {
    return MODES.includes(mode) ? mode : DEFAULT_MODE
}

export function isMode(mode) {
    return MODES.includes(mode)
}
