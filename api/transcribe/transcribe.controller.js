import OpenAI from 'openai'
import { createReadStream } from 'fs'
import { writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { logger }     from '../../services/logger.service.js'
import { config }     from '../../services/config.js'
import { makeHandle } from '../_shared/handle.util.js'
import { httpError }  from '../../services/httpError.util.js'

const LOG    = '[transcribe]'
const handle = makeHandle(LOG)
const openai = new OpenAI({ apiKey: config.openaiApiKey })

// The OpenAI SDK's errors carry a `status` (a 401 on a bad key, a 429) — the PROVIDER's, which the
// global handler answers as our 500. The temp file goes whichever way the call went.
export const transcribeAudio = handle('transcribeAudio', async (req, res) => {
    const buffer = req.body
    if (!buffer || !buffer.length) throw httpError(400, 'No audio data received')

    const contentType = req.headers['content-type'] || 'audio/webm'
    const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('ogg') ? 'ogg' : 'webm'

    const tmpPath = join(tmpdir(), `audio-${randomUUID()}.${ext}`)
    await writeFile(tmpPath, buffer)
    try {
        const result = await openai.audio.transcriptions.create({
            file: createReadStream(tmpPath),
            model: 'whisper-1',
        })
        logger.info(LOG, `Transcribed ${buffer.length} bytes → "${result.text?.slice(0, 80)}"`)
        res.json({ text: result.text ?? '' })
    } finally {
        unlink(tmpPath).catch(() => {})
    }
})
