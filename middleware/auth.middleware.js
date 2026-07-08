import jwt from 'jsonwebtoken'

export function requireAuth(req, res, next) {
    const token = req.cookies?.token
    if (!token) return res.status(401).json({ error: 'Unauthorized' })
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET)
        // Admin cross-user visibility disabled for now — every user sees only
        // their own ideas/portfolios/scans. Forced here so it also neutralizes
        // still-valid admin tokens issued before this change. Remove to restore.
        req.user.isAdmin = false
        next()
    } catch {
        res.status(401).json({ error: 'Unauthorized' })
    }
}
