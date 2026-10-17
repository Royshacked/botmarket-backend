// What a setup refusal means to the user — status + message by reason. ONE table for every setup route and for
// Mentor's session actions (services/desks/actions/mentor.actions.js), so the two can never disagree.

// Setup-OWNED reasons. Everything cross-kind (not_found / forbidden / in_position /
// closed_is_terminal / invalid_status / nothing_to_patch) is answered by the shared table, so this
// route can no longer disagree with the idea and call routes about what a refusal means.
//
// What's left is the Generate gate: `missing_*` says the draft isn't finished and `cannot_arm_*`
// says re-running that gate at Arm time failed (the broker disconnected after Generate). Both are
// "fix it in the chat" — a 400 carrying the slug, never a 500.
const SETUP_REASONS = {
    invalid_setup: [400, 'The draft is not a usable setup'],
    invalid_leg:   [400, 'A level is missing its price'],
    no_venue:      [400, 'Mark a trading account before generating'],
    // Management refusals. `confirm_order` is not an error the user caused: a printing second leg is
    // placed by confirming its order, so the client is being told WHERE the action lives.
    confirm_order:        [409, 'That leg is placed by confirming its order, not from here'],
    no_pending_action:    [409, 'Talos has not proposed that'],
    bad_verb:             [400, 'That is not an action this desk can execute'],
    bad_proposal:         [422, 'The proposal is missing the level it needs'],
    no_position_link:     [409, 'No broker position is linked to this setup'],
    not_a_pending_limit:  [409, 'This setup is not a confirmed limit order awaiting a fill'],
    // Share refusals. A card only a person can open cannot be sent to a bot; a conversation the
    // sender is not in is `forbidden` from the shared table.
    invalid_conversation: [400, 'Pick a conversation to share into'],
    bot_recipient:        [400, 'A setup can only be shared with another user'],
}
// Named reasons win over the prefix rules — `invalid_setup` / `invalid_leg` have their own copy and
// must not be swallowed by the generic `invalid_*` passthrough below them.
export const setupReason = (reason) =>
    SETUP_REASONS[reason]
    ?? ((reason?.startsWith('missing_') || reason?.startsWith('cannot_arm_') || reason?.startsWith('invalid_'))
        ? [400, reason]
        : null)
