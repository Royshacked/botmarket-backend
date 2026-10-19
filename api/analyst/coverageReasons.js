// What a coverage refusal means to the user — status + message by reason. ONE table for the coverage routes and
// Prometheus's session actions (services/desks/actions/analyst.actions.js), so the two can never disagree.
export const COVERAGE_REASONS = {
    symbol_required:           [400, 'A symbol is required to initiate coverage'],
    already_covered:           [409, 'Already covered — update the thesis instead of initiating it again'],
    rating_contradicts_target: [422, 'The rating and the price target point in opposite directions'],
}
