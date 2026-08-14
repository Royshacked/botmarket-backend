import express         from 'express'
import { log }         from '../../middleware/logger.middleware.js'
import { requireAuth } from '../../middleware/auth.middleware.js'
import {
    streamScanner,
    createScan, listScans, getScan, updateScan, removeScan,
    saveScannerChatState, getScannerChatState, deleteScannerChatState,
} from './scanner.controller.js'

const router = express.Router()

router.use(requireAuth)

router.post('/stream',      log, streamScanner)

router.get('/scans',        log, listScans)
router.get('/scans/:id',    log, getScan)
router.post('/scans',       log, createScan)
router.put('/scans/:id',    log, updateScan)
router.delete('/scans/:id', log, removeScan)

router.post('/chat-state',   log, saveScannerChatState)
router.get('/chat-state',    log, getScannerChatState)
router.delete('/chat-state', log, deleteScannerChatState)

export const scannerRoutes = router
