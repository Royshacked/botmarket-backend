// What a portfolio commit refusal means to the user — status + message by reason. ONE table for the portfolio routes
// and Atlas's session actions (services/desks/actions/portfolio.actions.js), so the two can never disagree.

// A rebalance's refusals.
export const REBALANCE_REASONS = {
    missing_portfolioId: [400, 'Missing portfolioId'],
    no_changes:          [400, 'No changes to apply'],
    // 409, not 400: the request is well formed and the book is real — every individual change was
    // refused by the state of what it named. Changing that state (or re-running the review against
    // the book as it now stands) makes the same request valid.
    nothing_applied:     [409, 'None of the proposed changes could be applied'],
}

// Saving a book (portfolioCommit.createBook / replacePlan).
export const BOOK_REASONS = {
    avoid_needs_ok: [409, 'Pythia rates an industry in this AVOID — say yes to keep it'],
    book_live:      [409, 'A position in this book is live on the broker — close it before re-planning'],
    no_ideas:       [400, 'The plan has no holdings'],
    save_failed:    [500, 'Could not save the book — nothing was saved'],
}
