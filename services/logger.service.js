import fs from 'fs'

export const logger = {
	debug: (...args) => doLog('DEBUG', ...args),
	info: (...args) => doLog('INFO', ...args),
	warn: (...args) => doLog('WARN', ...args),
	error: (...args) => doLog('ERROR', ...args),
}

const logsDir = './logs'

if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir)

function doLog(level, ...args) {

	const strs = args.map(arg => (typeof arg === 'string' || _isError(arg) ? arg : JSON.stringify(arg)))


	const line = `${_getTime()} - ${level} - ${strs.join(' | ')}\n`
	console.log(line)

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
