import OpenAI from 'openai'
import { logger } from '../../services/logger.service.js'

const LOG = '[transcribe]'
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function transcribeAudio(req, res) {
    try {
        const buffer = req.body
        if (!buffer || !buffer.length) {
            return res.status(400).json({ err: 'No audio data received' })
        }

        const contentType = req.headers['content-type'] || 'audio/webm'
        const ext  = contentType.includes('mp4') ? 'mp4' : contentType.includes('ogg') ? 'ogg' : 'webm'
        const file = new File([buffer], `audio.${ext}`, { type: contentType })
        const result = await openai.audio.transcriptions.create({
            file,
            model: 'whisper-1',
        })

        logger.info(LOG, `Transcribed ${buffer.length} bytes → "${result.text?.slice(0, 80)}"`)
        res.json({ text: result.text ?? '' })
    } catch (err) {
        logger.error(LOG, 'Transcription failed:', err.message, err.status ?? '', err.error ?? '')
        res.status(500).json({ err: 'Transcription failed' })
    }
}
