// Aether engine scheduler — spawns the Python scheduler as a child process.
//
// Registered in startBackgroundLoops() behind the instance lock, so only one server process
// runs it. The scheduler fires: news (every 4h), FRED validation (daily, release-gated),
// weekly coupling rebuild (Sundays), monthly decay audit (1st of month).
//
// Requires AETHER_ENGINE_PATH in .env pointing at the aether-engine repo root.
// If unset, start() is a no-op and the engine still serves its read endpoints normally.
//
// Env bridging: Node uses MONGODB_URI / DB_NAME; aether-engine uses MONGO_URI / MONGO_DB.
// The spawn env maps them so both sides read the same database without duplicating the values.

import { spawn } from 'child_process'
import path     from 'path'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[aetherScheduler]'

let _proc = null

function _pythonExe(engineDir) {
    return process.platform === 'win32'
        ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
        : path.join(engineDir, '.venv', 'bin', 'python')
}

function _buildEnv() {
    const env = { ...process.env }
    // aether-engine reads MONGO_URI / MONGO_DB; the backend sets MONGODB_URI / DB_NAME.
    if (!env.MONGO_URI  && env.MONGODB_URI) env.MONGO_URI = env.MONGODB_URI
    if (!env.MONGO_DB   && env.DB_NAME)     env.MONGO_DB  = env.DB_NAME
    return env
}

function start() {
    const engineDir = config.aetherEnginePath
    if (!engineDir) {
        logger.warn(LOG, 'AETHER_ENGINE_PATH not set — scheduler not started')
        return
    }

    const python = _pythonExe(engineDir)
    const script = path.join(engineDir, 'scripts', 'scheduler.py')

    _proc = spawn(python, [script], {
        cwd: engineDir,
        env: _buildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Stream the scheduler's output through our logger so it appears in the same log trail.
    _proc.stdout.on('data', buf => {
        const lines = buf.toString().trim().split('\n')
        for (const line of lines) if (line) logger.info(LOG, line)
    })
    _proc.stderr.on('data', buf => {
        const lines = buf.toString().trim().split('\n')
        for (const line of lines) if (line) logger.warn(LOG, line)
    })

    _proc.on('exit', (code, signal) => {
        logger.info(LOG, `exited  code=${code ?? '-'}  signal=${signal ?? '-'}`)
        _proc = null
    })
    _proc.on('error', err => {
        logger.error(LOG, 'spawn failed:', err.message)
        _proc = null
    })

    logger.info(LOG, `started  pid=${_proc.pid}  cwd=${engineDir}`)
}

async function stop() {
    if (!_proc) return
    return new Promise(resolve => {
        _proc.once('exit', resolve)
        _proc.kill('SIGTERM')
        // If the scheduler doesn't exit within 5s, force it. Unref'd so it doesn't
        // keep the Node process alive on its own.
        const backstop = setTimeout(() => { if (_proc) _proc.kill('SIGKILL') }, 5_000)
        backstop.unref()
    })
}

export const aetherSchedulerService = { start, stop }
