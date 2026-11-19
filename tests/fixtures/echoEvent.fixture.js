// A pipeline event as echo_events stores it (docs/design/echo-pipeline.md) — shared by the Echo read and tool tests.

export const ID = 'ev_0b6f1c2a-1111-4222-8333-944455556666'
export const DOC = {
    _id: ID, kind: 'house', userId: null, date: '2026-11-12', timing: 'after_close', type: 'demand_shock', origin: 'Cisco Systems, Inc.', originTickers: ['CSCO'],
    terms: ['Cisco'], whatChanged: 'Cisco guided networking hardware lower', size: 'Day 0 -5.9% vs SPY', durability: { kind: 'price_spike', why: 'one quarter' },
    effect: 'down', filter: { surprise: true, large: true, lasting: true, why: 'a bellwether guide' }, sources: ['earnings'], status: 'watching',
    map: { model: 'claude-opus-5-5', promptVersion: 'chain-2026-11-19', mappedAt: 'x', fromTemplate: null, dropped: [{ ticker: 'TSE', reason: 'not an active US listing' }],
        links: [
            { ticker: 'FN', name: 'Fabrinet', relation: 'supplier', layer: 2, direction: 'loses', why: 'optics for Cisco', confidence: 'medium', sector: 'Technology', filings: { named: true, share: { share: 0.199 } } },
            { ticker: 'PLUS', name: 'ePlus', relation: 'customer', layer: 1, direction: 'loses', why: 'Cisco reseller', confidence: 'high', sector: 'Technology', filings: { named: true } },
            { ticker: 'VRT', name: 'Vertiv', relation: 'infrastructure', layer: 3, direction: 'loses', why: 'cooling', confidence: 'low', sector: 'Industrials', filings: { named: false } },
        ] },
    scores: { model: 'claude-opus-5-5', scoredAt: 'x', high: 8, links: [
        { ticker: 'PLUS', total: 6, high: false, factors: { directness: { score: 2 } } },
        { ticker: 'FN', total: 5, high: false, factors: { directness: { score: 2 } } },
        { ticker: 'VRT', total: 9, high: true, factors: { directness: { score: 1 } } }] },
    check: { day0: '2026-11-13', checkDay: '2026-11-19', yardstick: { median: 0.03, from: 'layer 1', n: 2 },
        links: [{ ticker: 'FN', flag: 'overreacted_loser', why: 'fell hard', signedMove: 0.12, moves: {}, volume: {}, analysts: { count: 0 } }, { ticker: 'PLUS', flag: 'fully_priced', why: 'x' }] },
    grades: { 5: { rows: [{ ticker: 'FN', signed: 0.04 }] } },
    triggers: [{ kind: 'earnings', ticker: 'FN', what: 'FN reported' }],
}
