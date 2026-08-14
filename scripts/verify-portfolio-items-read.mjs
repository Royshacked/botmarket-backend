/**
 * Live check of the read that opening a book for review now makes.
 *
 *   node scripts/verify-portfolio-items-read.mjs [portfolioId] [userId]
 *
 * Read-only. Asserts the two things the review depends on: that the rows come back at all, and that
 * each one carries the `id` the accepted <portfolio_update> will name as itemId.
 */
import dotenv from 'dotenv'
dotenv.config()

const { listPortfolioItems } = await import('../services/portfolioState.service.js')

const portfolioId = process.argv[2] ?? 'portfolio_1786030441286'
const userId      = process.argv[3] ?? '1779968319268'

const items = await listPortfolioItems(portfolioId, userId)
console.log(`\n${items.length} holding(s) for ${portfolioId}\n`)

let bad = 0
for (const it of items) {
    const hasId    = typeof it.id === 'string' && it.id.length > 0
    const hasAsset = !!it.asset
    if (!hasId || !hasAsset) bad++
    console.log(`  ${hasId ? '✓' : '✗'} ${String(it.asset ?? '?').padEnd(6)} ${String(it.status ?? '').padEnd(8)} ${it.id ?? '(NO ID)'}`)
}

// Ownership must be enforced by the query, not by the caller remembering to filter.
const foreign = await listPortfolioItems(portfolioId, 'not-this-user')
console.log(`\nowner scoping: another user reads ${foreign.length} row(s) — expected 0`)

const ok = items.length > 0 && bad === 0 && foreign.length === 0
console.log(ok ? '\nPASS — every holding carries an id, and the book is owner-scoped.\n' : '\nFAIL\n')
process.exit(ok ? 0 : 1)
