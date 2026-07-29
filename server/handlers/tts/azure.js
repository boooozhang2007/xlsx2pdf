import { getEnv, readJsonBody, rejectMethod, requireSession, sendJson } from '../../auth.js'
import { buildAzureSsml, defaultAzureVoice, normalizeWords } from '../../tts.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  if (!requireSession(req, res)) return

  try {
    const body = await readJsonBody(req)
    const words = normalizeWords(body.words, 80)
    if (!words.length) return sendJson(res, 400, { ok: false, error: '没有可朗读的单词。' })

    const region = getEnv('AZURE_SPEECH_REGION')
    const key = getEnv('AZURE_SPEECH_KEY')
    const voice = body.voice || defaultAzureVoice(body.accent)
    const ssml = buildAzureSsml({
      words,
      voice,
      accent: body.accent,
      rate: body.rate,
      pauseMs: body.pauseMs,
    })

    const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'xlsx2pdf-tts',
      },
      body: ssml,
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return sendJson(res, response.status, {
        ok: false,
        error: `Azure 生成失败：${response.status}`,
        detail: detail.slice(0, 500),
      })
    }

    const audio = Buffer.from(await response.arrayBuffer())
    res.statusCode = 200
    res.setHeader('content-type', 'audio/mpeg')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-tts-provider', 'azure')
    return res.end(audio)
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || 'Azure 生成失败。' })
  }
}
