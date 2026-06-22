const { scannerAgentService } = await import('./services/scanner.agent.service.js')
const editList = {
  thesis: 'Earnings-week large caps',
  period: { label: 'Coming week', start: '2026-06-22', end: '2026-06-28' },
  direction: 'mixed',
  candidates: [
    { ticker: 'FDX', direction: 'long',  thesis: 'beat setup' },
    { ticker: 'CCL', direction: 'short', thesis: 'stretched run-up' },
  ],
}
const res = await scannerAgentService.chatStream({
  messages: [{ role: 'user', content: 'Remove CCL from the list and add NKE as a short into its earnings. Keep FDX.' }],
  model: 'claude-sonnet-4-6',
  editList,
  onToken: () => {},
})
console.log('captured scan tickers:', res.scan?.candidates?.map(c => `${c.ticker}/${c.direction}`).join(', '))
console.log('thesis:', res.scan?.thesis, '| period:', res.scan?.period?.label)
