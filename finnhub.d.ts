declare module 'finnhub' {
    type DateLike = string | number | Date
    type FinnhubCallback<T = unknown> = (error: unknown, data: T, response: unknown) => void

    class DefaultApi {
        constructor(apiKey?: string)
        marketNews(category: string, opts: { minId?: number }, callback: FinnhubCallback): void
        companyNews(symbol: string, from: DateLike, to: DateLike, callback: FinnhubCallback): void
        companyProfile(opts: { symbol: string }, callback: FinnhubCallback): void
        earningsCalendar(opts: { symbol?: string; from?: DateLike; to?: DateLike; international?: boolean }, callback: FinnhubCallback): void
    }

    const finnhub: {
        DefaultApi: typeof DefaultApi
    }

    export { DefaultApi }
    export default finnhub
}
