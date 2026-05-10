import { priceService } from "../../services/price.service.js"


export const priceFeedService = {
    query,
}

async function query(ticker, options={}) {
    const candles = await priceService.getPriceData(ticker, options)
    return candles
}