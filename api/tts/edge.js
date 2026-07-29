import { EdgeTTS } from 'edge-tts-universal'
import { readJsonBody, rejectMethod, requireSession, sendJson } from '../../server/auth.js'
import { defaultAzureVoice, normalizeWords } from '../../server/tts.js'

const synthesize = async (text, voice, rate) => {
  const rateText = `${rate >= 0 ? '+' : ''}${Math.round(rate)}%`
  const tts = new EdgeTTS(text, voice, { rate: rateText, volume: '+0%', pitch: '+0Hz' })
  const result = await tts.synthesize()
  return Buffer.from(await result.audio.arrayBuffer())
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    return res.end()
  }
  if (req.method !== 'POST') return rejectMethod(res, 'POST, OPTIONS')
  if (!requireSession(req, res)) return

  try {
    const body = await readJsonBody(req)
    const words = normalizeWords(body.words, 80)
    if (!words.length) return sendJson(res, 400, { ok: false, error: '没有可朗读的单词。' })

    const voice = body.voice || defaultAzureVoice(body.accent)
    const rate = Number(body.rate || 0)
    const pauseMs = Math.max(0, Number.parseInt(body.pauseMs || 800, 10) || 800)

    if (body.segmented) {
      const segments = []
      for (const word of words) {
        const audio = await synthesize(word, voice, rate)
        segments.push({
          text: word,
          audioBase64: audio.toString('base64'),
          contentType: 'audio/mpeg',
        })
      }
      return sendJson(res, 200, {
        ok: true,
        provider: 'edge',
        mode: 'segments',
        pauseMs,
        segments,
      })
    }

    const audio = await synthesize(words.join(' '), voice, rate)
    res.statusCode = 200
    res.setHeader('content-type', 'audio/mpeg')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-tts-provider', 'edge')
    res.setHeader('content-length', String(audio.length))
    return res.end(audio)
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || 'Edge-TTS 生成失败。' })
  }
}
