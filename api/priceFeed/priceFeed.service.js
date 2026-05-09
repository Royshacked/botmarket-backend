import { priceService } from "../../services/price.service.js"


export const priceFeedService = {
    query,
}

async function query(ticker) {
    const priceData = await priceService.getPriceData(ticker)
    return priceData
}