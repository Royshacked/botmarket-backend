// What an industry-view refusal means to the user — status + message by reason. ONE table for the view routes and
// Pythia's session action (services/desks/actions/strategy.actions.js), so the two can never disagree.
export const VIEW_REASONS = {
    bad_draft: [422, 'The view does not hold up — see detail'],
    unknown_industry: [404, 'Unknown GICS sub-industry'],
}
