import { fetchTickerPriceData } from "../providers/massive.provider.js"


export const priceService = {
    getPriceData,
}

async function getPriceData(ticker) {
    const priceData = await fetchTickerPriceData(ticker)
    return priceData
}

