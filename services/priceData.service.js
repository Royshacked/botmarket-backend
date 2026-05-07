import { fetchTickerPriceData } from "../providers/finnhub.provider.js"


export const priceDataService = {
    getPriceData,
}

async function getPriceData(ticker) {
    const priceData = await fetchTickerPriceData(ticker)
    return priceData
}

