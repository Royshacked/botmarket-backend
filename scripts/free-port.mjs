/**
 * Free the dev server port if a previous node process is still listening.
 * Used before npm start to avoid EADDRINUSE from orphaned servers.
 */
import { execSync } from 'child_process'

const port = String(process.env.PORT || 3030)

function freePortWindows() {
    let out
    try {
        out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
        return
    }

    const pids = new Set()
    for (const line of out.split('\n')) {
        if (!line.includes('LISTENING')) continue
        if (!line.includes(`:${port}`)) continue
        const parts = line.trim().split(/\s+/)
        const pid = parts[parts.length - 1]
        if (/^\d+$/.test(pid)) pids.add(pid)
    }

    for (const pid of pids) {
        try {
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
            console.log(`[free-port] Stopped PID ${pid} on port ${port}`)
        } catch {
            // already gone or access denied
        }
    }
}

function freePortUnix() {
    try {
        execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: 'ignore', shell: true })
    } catch {
        // nothing listening
    }
}

if (process.platform === 'win32') freePortWindows()
else freePortUnix()
