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

if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir)

function doLog(level, ...args) {

	const strs = args.map(arg => (typeof arg === 'string' || _isError(arg) ? arg : JSON.stringify(arg)))


	const line = `${_getTime()} - ${level} - ${strs.join(' | ')}\n`
	console.log(line)

	if (_sync) {
		// Never throws into the shutdown path — console.log above already carries the line.
		try { fs.appendFileSync(`${logsDir}/backend.log`, line) }
		catch { console.log('FATAL: cannot write to log file') }
		return
	}

	fs.appendFile(`${logsDir}/backend.log`, line, err => {
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
