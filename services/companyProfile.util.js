// Shared company-profile enrichment: attaches a company `name` + `logo` to each
// row from Finnhub's profile2 (cached in the provider). Used by the calendar
// endpoints (earnings/IPO) and by saved scan candidates so every ticker the UI
// renders shares one logo + name source. Concurrency-capped so a busy list
// doesn't burst past Finnhub's rate limit; cached profiles return instantly.
//
// `key` is the field holding the symbol ('symbol' for calendar rows, 'ticker'
// for scan candidates). `overwriteName` controls whether an existing name is
// replaced — scan candidates carry an agent-authored name we keep, only filling
// it in when absent.

import { fetchCompanyProfile } from '../providers/finnhub.provider.js'

export async function enrichWithProfiles(items, {
    fetchProfile  = fetchCompanyProfile,
    key           = 'symbol',
    concurrency   = 5,
    overwriteName = true,
} = {}) {
    let idx = 0
    async function worker() {
        while (idx < items.length) {
            const item = items[idx++]
            const { name, logo } = await fetchProfile(item[key])
            item.logo = logo
            if (overwriteName || item.name == null || item.name === '') item.name = name
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
    return items
}
