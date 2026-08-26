import jwt from 'jsonwebtoken'
import { config } from '../services/config.js'

export function requireAuth(req, res, next) {
    const token = req.cookies?.token
    if (!token) return res.status(401).json({ error: 'Unauthorized' })
    try {
        req.user = jwt.verify(token, config.jwtSecret)
        next()
    } catch {
        res.status(401).json({ error: 'Unauthorized' })
    }
}

export function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' })
    next()
}
