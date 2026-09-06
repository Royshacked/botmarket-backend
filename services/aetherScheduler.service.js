// Aether engine scheduler — spawns the Python scheduler as a child process.
//
// Started from server.js OUTSIDE the instance lease, gated instead on whether this machine
// actually has the engine: AETHER_ENGINE_PATH pointing at an aether-engine checkout with a
// built venv. It used to sit inside startBackgroundLoops(), which meant it only ran on the
// lease holder — the deployed instance, which has no Python and no engine repo. It therefore
// ran essentially nowhere, and the one machine that COULD run it was a follower that never
// called start(). See the note at its call site in server.js.
//
// Two hosts that both have the engine are safe: scheduler.py claims each job occurrence in
// aether_scheduler_runs before running it, so exclusion is per job, not per host.
//
// If the engine is not present here, start() is a quiet no-op and the read endpoints keep
// serving normally — the vast majority of deploys are in exactly that state.
//
// Env bridging: Node uses MONGODB_URI / DB_NAME; aether-engine uses MONGO_URI / MONGO_DB.
// The spawn env maps them so both sides read the same database without duplicating the values.
//
// It maps the database Node is CONNECTED TO, not the env var Node was configured with.
// The old bridge mapped DB_NAME → MONGO_DB; DB_NAME was unset, so it mapped nothing, and
// both sides fell through to their own hardcoded "test" — agreeing by luck. The day one
// engine process had MONGO_DB=botmarket in its environment it wrote a full parallel copy
// of every aether_* collection, silently, and the pipeline stalled for five days looking
// like it was running. A database name we cannot resolve is now a refusal to spawn.

import { spawn } from 'child_process'
import fs       from 'fs'
import path     from 'path'
import { getDbName } from '../providers/mongodb.provider.js'
import { config } from './config.js'
import { logger } from './logger.service.js'

const LOG = '[aetherScheduler]'

let _proc = null

function _pythonExe(engineDir) {
    return process.platform === 'win32'
        ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
        : path.join(engineDir, '.venv', 'bin', 'python')
}

// Returns null when the database cannot be resolved — the caller must not spawn on null.
function _buildEnv() {
    const dbName = getDbName()
    if (!dbName) return null

    const env = { ...process.env }
    // aether-engine reads MONGO_URI / MONGO_DB; the backend sets MONGODB_URI / DB_NAME.
    // Both are set unconditionally: an inherited MONGO_DB from the parent shell is exactly
    // the way the engine ends up in a different database from the app.
    env.MONGO_URI = config.mongoUri
    env.MONGO_DB  = dbName
    return env
}

function start() {
    const engineDir = config.aetherEnginePath
    if (!engineDir) {
        logger.info(LOG, 'AETHER_ENGINE_PATH not set — no engine on this host, scheduler not started')
        return
    }

    // The host check comes BEFORE the database check on purpose. A deploy with no engine
    // should say so once, calmly, and not go on to complain about a database name it was
    // never going to use.
    const python = _pythonExe(engineDir)
    const script = path.join(engineDir, 'scripts', 'scheduler.py')
    if (!fs.existsSync(python) || !fs.existsSync(script)) {
        logger.info(LOG, `no engine venv at ${python} — scheduler not started on this host`)
        return
    }

    const env = _buildEnv()
    if (!env) {
        logger.error(LOG, 'cannot resolve the database name — scheduler NOT started. '
            + 'Set DB_NAME, or start the scheduler after the first DB connection.')
        return
    }

    _proc = spawn(python, [script], {
        cwd: engineDir,
        env,
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

    logger.info(LOG, `started  pid=${_proc.pid}  cwd=${engineDir}  db="${env.MONGO_DB}"`)
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
