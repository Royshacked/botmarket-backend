import dotenv from 'dotenv'
import axios from 'axios'

dotenv.config()

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY


export async function fetchNews() {
    try {
        const response = await axios.get(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`)
        return response.data
    } catch (error) {
        console.error('Error getting news feeds', error)
        throw error
    }
}
