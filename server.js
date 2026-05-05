import http from 'http'
import path from 'path'
import cors from 'cors'
import express from 'express'
import cookieParser from 'cookie-parser'

import { newsFeedRoutes } from './api/newsFeed/newsFeed.routes.js'
import { assetAnalysisRoutes } from './api/assetAnalysis/assetAnalysis.routes.js'
import { logger } from './services/logger.service.js'

const app = express()
const server = http.createServer(app)

// Express App Config
app.use(cookieParser())
app.use(express.json())

if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('public')))
} else {
    const corsOptions = {
        origin: [   'http://127.0.0.1:3030',
                    'http://localhost:3030',
                    'http://127.0.0.1:5173',
                    'http://localhost:5173'
                ],
        credentials: true
    }
    app.use(cors(corsOptions))
}

app.use('/newsfeed', newsFeedRoutes)
app.use('/analysis', assetAnalysisRoutes)

// SPA fallback: only in production when static assets live in public/
if (process.env.NODE_ENV === 'production') {
    app.get('/**', (req, res) => {
        res.sendFile(path.resolve('public/index.html'))
    })
}

const port = process.env.PORT || 3030

server.listen(port, () => {
    logger.info('Server is running on port: ' + port)
})