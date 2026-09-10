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

// ── discovery, on demand ──────────────────────────────────────────────────────
//
// DELIBERATELY NOT ON THE SCHEDULE. scheduler.py runs six jobs and discovery is not one
// of them: it fills the queues discovery reads and stops there. This is the other half —
// an admin presses it, and nothing else can.
//
// The reason it is manual rather than daily is what it costs. One run is an Opus call
// with web search per selected event, plus roughly nine SEC requests for every candidate
// it proposes — a few hundred in a run. Everything else the engine does is a data fetch.
// A schedule spends that every morning whether or not anything happened worth spending it
// on, and "was there an event today" is a judgement, which is exactly the thing a cron
// cannot make.
//
// ONE AT A TIME. Two concurrent runs would work the same queue, and the selector's
// recent-subject skip reads Mongo at start-up, so the second would re-run the first's
// picks before it had written any of them.

let _discovery = null            // the child process, while one is running
let _lastRun   = null            // { startedAt, finishedAt, code, ok }
let _progress  = null            // { stage, detail, event, events, at }

/**
 * WHERE THE RUN IS, read off the engine's own log lines.
 *
 * A run is minutes long and its stages are wildly uneven — the news triage takes twenty
 * seconds, the proposal takes six and a half minutes, verification takes as long as EDGAR
 * feels like. "Running" for all of that tells the reader nothing, and on the day the Iran
 * run died it looked identical to a run that was working.
 *
 * PARSED FROM STDOUT rather than reported by the engine. The engine is a separate process
 * in another language whose only channel here is its log, and a progress protocol between
 * the two would be a second thing to keep in sync for a status chip. The cost is that
 * these patterns follow the Python log strings: if one changes, the stage silently stops
 * updating. That failure is deliberately benign — an unrecognised line leaves the previous
 * stage standing, and `running` is still true, so the worst case is the chip we had before.
 */
const _STAGES = [
    [/selector: (\d+) queued -> (\d+) after cheap cuts/,
        m => ({ stage: 'triage', detail: `reading ${m[2]} of ${m[1]} headlines` })],
    [/selector: (\d+) runnable/,
        m => ({ stage: 'selected', detail: `${m[1]} events worth a run` })],
    [/discovery: (.+)$/,
        m => ({ stage: 'proposing', detail: m[1].slice(0, 80), bumpEvent: true })],
    [/(\d+) candidates proposed/,
        m => ({ stage: 'proposed', detail: `${m[1]} names proposed` })],
    [/verifying (\d+) of (\d+)/,
        m => ({ stage: 'verifying', detail: `0 of ${m[1]} against EDGAR` })],
    [/verified (\d+)\/(\d+)/,
        m => ({ stage: 'verifying', detail: `${m[1]} of ${m[2]} against EDGAR` })],
    [/stored (\d+) candidates under run_id=(\S+)/,
        m => ({ stage: 'stored', detail: `${m[1]} stored for ${m[2]}` })],
]

function _readProgress(line) {
    for (const [re, build] of _STAGES) {
        const m = re.exec(line)
        if (!m) continue
        const next = build(m)
        _progress = {
            stage:  next.stage,
            detail: next.detail,
            // Which event of how many, so "proposing" on a two-event run says which one.
            event:  (_progress?.event ?? 0) + (next.bumpEvent ? 1 : 0),
            events: _progress?.events ?? 0,
            at:     new Date().toISOString(),
        }
        return
    }
}

/**
 * Can THIS host run a discovery, and if not, why not.
 *
 * A CAPABILITY, NOT AN IDENTITY. The engine is a Python process spawned on the same
 * filesystem, so the question is whether this server has one — never which admin is
 * asking. Gating on the person would be wrong in both directions at once: it would show
 * the button to whoever it named while they were using the DEPLOYED app, where nothing
 * can be spawned, and hide it from a second admin with a local checkout that works
 * perfectly. There are two admins on two different hosts; the host is the thing that
 * differs.
 *
 * Cheap enough to answer on every status poll: two `existsSync` calls on a path that is
 * almost certainly in the OS cache.
 */
function discoveryCapability() {
    const engineDir = config.aetherEnginePath
    if (!engineDir) {
        return { available: false, reason: 'no engine on this host — AETHER_ENGINE_PATH is not set' }
    }
    const python = _pythonExe(engineDir)
    const script = path.join(engineDir, 'scripts', 'select_events.py')
    if (!fs.existsSync(python) || !fs.existsSync(script)) {
        return { available: false, reason: `no engine venv at ${python}` }
    }
    return { available: true, reason: '' }
}

function discoveryStatus() {
    const cap = discoveryCapability()
    return {
        running: Boolean(_discovery),
        available: cap.available,
        unavailableReason: cap.reason,
        progress: _progress,
        last: _lastRun,
    }
}

/**
 * Spawn one discovery run. Resolves as soon as the process is RUNNING, not when it
 * finishes — a run takes minutes and the caller is an HTTP request.
 *
 * Throws for the reasons a caller should hear about: no engine on this host, no
 * resolvable database, or a run already in flight.
 */
function runDiscovery({ maxRuns = 2, hours = 36, top = 5 } = {}) {
    if (_discovery) throw new Error('a discovery run is already in flight')

    // ONE ANSWER TO "CAN THIS HOST RUN IT", asked here and by the status endpoint the
    // button polls. Two copies of this check is how the button ends up offering a run the
    // server will refuse.
    const cap = discoveryCapability()
    if (!cap.available) throw new Error(cap.reason)

    const engineDir = config.aetherEnginePath
    const script = path.join(engineDir, 'scripts', 'select_events.py')
    const python = _pythonExe(engineDir)

    // Same resolution as the scheduler: the engine must reach the database this process is
    // actually connected to, not one inherited from the shell. See the note at the top.
    const env = _buildEnv()
    if (!env) throw new Error('cannot resolve the database name')

    const args = [script, '--run',
        '--max-runs', String(maxRuns), '--hours', String(hours), '--top', String(top)]
    const startedAt = new Date().toISOString()
    // Reset, or the chip opens on the last run's final stage. `events` is the ceiling this
    // run was given, so "event 1 of 2" can be read before the engine says anything.
    _progress = { stage: 'starting', detail: 'spawning the engine', event: 0, events: maxRuns, at: startedAt }

    _discovery = spawn(python, args, { cwd: engineDir, env, stdio: ['ignore', 'pipe', 'pipe'] })

    // The engine logs to stderr (Python's logging default), so BOTH streams are read for
    // progress — reading stdout alone would leave the chip on "starting" for the whole run.
    _discovery.stdout.on('data', buf => {
        for (const line of buf.toString().trim().split('\n')) {
            if (!line) continue
            _readProgress(line)
            logger.info(LOG, line)
        }
    })
    _discovery.stderr.on('data', buf => {
        for (const line of buf.toString().trim().split('\n')) {
            if (!line) continue
            _readProgress(line)
            logger.warn(LOG, line)
        }
    })
    _discovery.on('exit', code => {
        // The last stage reached is kept on `last`, because WHERE a failed run died is the
        // useful half of knowing that it did. The Iran run reported exit 1 and nothing
        // else; "died in verifying, 45 names already proposed" is the sentence that would
        // have pointed straight at the SEC outage.
        _lastRun = { startedAt, finishedAt: new Date().toISOString(), code, ok: code === 0,
                     lastStage: _progress?.stage ?? null, lastDetail: _progress?.detail ?? null }
        logger.info(LOG, `discovery finished  code=${code ?? '-'}  last stage=${_progress?.stage ?? '-'}`)
        _discovery = null
        _progress = null
    })
    _discovery.on('error', err => {
        _lastRun = { startedAt, finishedAt: new Date().toISOString(), code: null, ok: false,
                     error: err.message }
        logger.error(LOG, 'discovery spawn failed:', err.message)
        _discovery = null
        _progress = null
    })

    logger.info(LOG, `discovery started  pid=${_discovery.pid}  maxRuns=${maxRuns}  hours=${hours}`)
    return { startedAt, pid: _discovery.pid, maxRuns, hours, top }
}

export const aetherSchedulerService = { start, stop, runDiscovery, discoveryStatus }
