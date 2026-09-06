import fs from 'fs'

export const logger = {
	debug: (...args) => doLog('DEBUG', ...args),
	info: (...args) => doLog('INFO', ...args),
	warn: (...args) => doLog('WARN', ...args),
	error: (...args) => doLog('ERROR', ...args),
}

const logsDir = './logs'

// File writes are ASYNC by default — a busy server should not block the event loop on a log
// line — and become synchronous once shutdown starts. That switch is not tidiness.
//
// `fs.appendFile` queues, and `process.exit()` discards whatever has not been flushed. So the
// LAST few lines are precisely the ones that never reach the file, and the last few lines are
// the shutdown tail: whether the loops stopped, whether the sockets drained, whether Mongo
// closed. Going looking for that record after a bad Ctrl-C is how this was found — three
// loop-stop lines had already been lost from the file while the console had shown all ten.
//
// One-way, like the draining latch. Once shutting down there is no throughput left to protect.
let _sync = false
export function switchToSyncLogging() { _sync = true }

// Tests do NOT write to backend.log. The file is the only forensic record of what the
// server actually did, and a test run pours hundreds of synthetic lines into it —
// fabricated ERRORs included, since the suites that matter here are the ones exercising
// failure paths. That is not noise you can skim past: instanceLock's tests drive a lock
// through acquire -> lose -> re-acquire -> release inside one second under the instance
// ids 'A' and 'B', which reads exactly like a production instance thrashing its lease.
// It cost a wrong diagnosis in this repo — the churn was read as a Mongo blip flapping
// the background loops, and only the instance ids gave it away.
//
// NODE_TEST_CONTEXT is set by `node --test` itself, so this needs nothing of the suites
// and cannot be forgotten by a new test file. console.log still carries every line, so a
// failing test loses no output.
const _isTestRun = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test'

// Where the file sink points, or null for "do not write a file at all".
//
// Null under test rather than backend.log. The sync/async timing above is a real property
// worth testing, so the sink is redirectable instead of merely switched off — a test that
// needs to prove FILE behaviour points it at a temp path and asserts against that.
let _sink = _isTestRun ? null : `${logsDir}/backend.log`

/** Redirect the file sink. Tests only — pass a temp path, or null to write no file. */
export function _setLogSinkForTests(filePath) { _sink = filePath }

if (!_isTestRun && !fs.existsSync(logsDir)) fs.mkdirSync(logsDir)

function doLog(level, ...args) {

	const strs = args.map(arg => (typeof arg === 'string' || _isError(arg) ? arg : JSON.stringify(arg)))


	const line = `${_getTime()} - ${level} - ${strs.join(' | ')}\n`
	console.log(line)

	if (!_sink) return

	if (_sync) {
		// Never throws into the shutdown path — console.log above already carries the line.
		try { fs.appendFileSync(_sink, line) }
		catch { console.log('FATAL: cannot write to log file') }
		return
	}

	fs.appendFile(_sink, line, err => {
		if (err) console.log('FATAL: cannot write to log file')
	})
}

function _getTime() {
	let now = new Date()
	return now.toLocaleString('he')
}

function _isError(e) {
	return e && e.stack && e.message
}
