import { priceDataService } from "../../services/priceData.service.js"


export const priceFeedService = {
    query,
}

async function query(ticker) {
    const priceData = await priceDataService.getPriceData(ticker)
    return priceData
}