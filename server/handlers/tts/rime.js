import { getEnv, readJsonBody, rejectMethod, requireSession, sendJson } from '../../auth.js'
import { defaultRimeVoice, normalizeWords, rimeSpeedAlpha } from '../../tts.js'

const RIME_ENDPOINT = 'https://coda.api.rime.ai/'
const RIME_TIMEOUT_MS = 30000

const synthesize = async ({ text, speaker, speedAlpha }) => {
  const key = getEnv('RIME_API_KEY')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RIME_TIMEOUT_MS)
  try {
    const response = await fetch(RIME_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mp3',
      },
      body: JSON.stringify({
        text,
        speaker,
        modelId: 'coda',
        lang: 'en',
        speedAlpha,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const error = new Error(`Rime 生成失败：${response.status}`)
      error.statusCode = response.status === 401 || response.status === 403 ? 502 : 502
      error.detail = detail.slice(0, 300)
      throw error
    }
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
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

    const speaker = body.voice || defaultRimeVoice(body.accent)
    const speedAlpha = rimeSpeedAlpha(body.rate)
    const pauseMs = Math.max(0, Number.parseInt(body.pauseMs || 800, 10) || 800)

    if (body.segmented) {
      const segments = []
      for (const word of words) {
        const audio = await synthesize({ text: word, speaker, speedAlpha })
        segments.push({
          text: word,
          audioBase64: audio.toString('base64'),
          contentType: 'audio/mpeg',
        })
      }
      return sendJson(res, 200, {
        ok: true,
        provider: 'rime',
        mode: 'segments',
        pauseMs,
        segments,
      })
    }

    const audio = await synthesize({ text: words.join(' '), speaker, speedAlpha })
    res.statusCode = 200
    res.setHeader('content-type', 'audio/mpeg')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-tts-provider', 'rime')
    res.setHeader('content-length', String(audio.length))
    return res.end(audio)
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || 'Rime 生成失败。',
      detail: error.detail,
    })
  }
}
