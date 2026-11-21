// The line a chart-only row carries ("Here's the NVDA daily chart.") — its own leaf module so the subagent pipe can use it
// without importing sessionTurn (index → axl.desk → subagent → sessionTurn → index is a cycle that broke module loading).

const TIMEFRAME_WORD = Object.freeze({ day: 'daily', week: 'weekly', month: 'monthly', '1day': 'daily', '1week': 'weekly' })

/**
 * A reply that was ONLY a chart still gets a row: one plain line naming it ("Here's the NVDA daily chart."), so the chart
 * comes back on a reload and the agent's memory knows which chart it already showed. Null when there is no chart.
 */
export function chartLine(chart) {
    const ticker = String(chart?.ticker ?? '').trim()
    if (!ticker) return null
    const tf = String(chart.timeframe ?? '').trim()
    const word = TIMEFRAME_WORD[tf] ?? (tf ? tf : '')
    return `Here's the ${ticker}${word ? ` ${word}` : ''} chart.`
}
