// THE SECTOR LAYER'S SECTORS (docs/design/situation-network-layers.md §4; build step 1).
//
// The network describes the world by SECTOR (GICS, 11) and asks and scores by INDUSTRY. Each sector reads its own
// news: two GNews topics, two Federal Register terms (the network's own — Echo's five are Echo's), and FMP news on its
// largest names. The lists are Claude's first draft (2026-11-23) for Roy to cut; a busy industry split out of its
// sector would be a new entry here with an industry code (§4.1).
//
// An industry basket's code starts with its sector's two digits (GICS), so `sectorOf` needs no lookup.

import { getEngineDb } from '../engineDb.js'

export const SECTORS = Object.freeze([
    { code: '10', name: 'Energy', gnews: ['"oil prices" OR drilling OR refiners', '"natural gas" OR LNG OR OPEC'], terms: ['crude oil', 'natural gas'] },
    { code: '15', name: 'Materials', gnews: ['steel OR aluminum OR copper prices', 'chemicals OR fertilizer OR mining'], terms: ['steel', 'chemical'] },
    { code: '20', name: 'Industrials', gnews: ['aerospace OR "defense contractors" OR Boeing', 'freight OR railroads OR airlines OR machinery'], terms: ['aircraft', 'infrastructure'] },
    { code: '25', name: 'Consumer Discretionary', gnews: ['"retail sales" OR "consumer spending"', 'automakers OR homebuilders OR "electric vehicles"'], terms: ['motor vehicle', 'consumer product'] },
    { code: '30', name: 'Consumer Staples', gnews: ['"food prices" OR grocery OR beverage', '"packaged food" OR tobacco OR "consumer staples"'], terms: ['food', 'tobacco'] },
    { code: '35', name: 'Health Care', gnews: ['"drug pricing" OR FDA OR Medicare', 'biotech OR pharma OR "health insurers"'], terms: ['drug pricing', 'Medicare'] },
    { code: '40', name: 'Financials', gnews: ['"bank regulation" OR "bank earnings" OR lending', 'insurers OR "private credit" OR "credit markets"'], terms: ['capital requirements', 'deposit insurance'] },
    { code: '45', name: 'Information Technology', gnews: ['semiconductors OR chipmakers', 'software OR cloud OR cybersecurity'], terms: ['semiconductor', 'artificial intelligence'] },
    { code: '50', name: 'Communication Services', gnews: ['telecom OR streaming OR media', 'advertising OR "social media" regulation'], terms: ['spectrum', 'broadband'] },
    { code: '55', name: 'Utilities', gnews: ['"power demand" OR "electric utilities"', 'nuclear OR "power grid" OR renewables'], terms: ['electric transmission', 'nuclear'] },
    { code: '60', name: 'Real Estate', gnews: ['"commercial real estate" OR REIT', '"housing market" OR "mortgage rates"'], terms: ['housing', 'mortgage'] },
])
export const SECTOR_CODES = Object.freeze(SECTORS.map(s => s.code))
export const MACRO = 'macro'
/** Open questions per sector, and across every sector (§13 defaults). The macro layer keeps its own (network.OPEN_CAP). */
export const SECTOR_CAP = 3
export const SECTORS_TOTAL_CAP = 30
/** A sector question whose branches move industries in this many sectors or more moves up to the macro layer (§5.1). */
export const PROMOTE_AT = 3
/** FMP news is read on each sector's largest names, this many. */
export const TOP_NAMES = 8

/** The sector of an industry code ('35201010' → '35'), or null. Pure. */
export const sectorOf = (code) => {
    const s = String(code ?? '').slice(0, 2)
    return SECTOR_CODES.includes(s) ? s : null
}
export const sectorByCode = (code) => SECTORS.find(s => s.code === code) ?? null
/** A layer is 'macro' or a sector code. Pure. */
export const isLayer = (x) => x === MACRO || SECTOR_CODES.includes(x)
export const layerOf = (node) => (isLayer(node?.layer) ? node.layer : MACRO)
/**
 * Where a question was BORN: its layer, unless it was promoted — then the sector it came from. A promoted question lives
 * and updates in the macro layer, but is graded (and counted out of "macro alone") by its origin, so the comparison of
 * the layers stays clean. Pure.
 */
export const originOf = (node) => (isLayer(node?.origin) ? node.origin : layerOf(node))
export const layerName = (layer) => (layer === MACRO ? 'Macro' : sectorByCode(layer)?.name ?? layer)

const _io = { engineDb: () => getEngineDb() }
export function _setIO(io) { Object.assign(_io, io) }

/** Each sector's largest names by market cap (`gics_companies`) → `Map(sector → [symbol])`. A failure is an empty map. */
export async function topNames(n = TOP_NAMES) {
    const out = new Map()
    try {
        const edb = await _io.engineDb()
        const rows = await edb.collection('gics_companies').find({ sector_code: { $in: [...SECTOR_CODES, ...SECTOR_CODES.map(Number)] }, market_cap: { $gt: 0 } },
            { projection: { _id: 0, symbol: 1, sector_code: 1, market_cap: 1 } }).sort({ market_cap: -1 }).limit(2000).toArray()
        for (const r of rows) {
            const s = String(r.sector_code).padStart(2, '0')
            if (!out.has(s)) out.set(s, [])
            if (out.get(s).length < n && r.symbol) out.get(s).push(r.symbol)
        }
    } catch { /* no names: the sector reads GNews and the Federal Register only */ }
    return out
}
