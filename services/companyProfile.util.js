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
import { mapLimit } from './concurrency.util.js'

export async function enrichWithProfiles(items, {
    fetchProfile  = fetchCompanyProfile,
    key           = 'symbol',
    concurrency   = 5,
    overwriteName = true,
} = {}) {
    // The worker pool this used to carry inline now belongs to concurrency.util, which the batch read
    // shares. The enrichment is a MUTATION of the rows, so the mapped results are discarded.
    await mapLimit(items, async (item) => {
        const { name, logo } = await fetchProfile(item[key])
        item.logo = logo
        if (overwriteName || item.name == null || item.name === '') item.name = name
    }, { concurrency })
    return items
}
