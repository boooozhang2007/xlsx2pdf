import { rejectMethod, requireSession, sendJson } from '../../server/auth.js'
import { azureVoiceFallbacks, edgeVoiceFallbacks } from '../../server/tts.js'

const fetchAzureVoices = async () => {
  const key = process.env.AZURE_SPEECH_KEY
  const region = process.env.AZURE_SPEECH_REGION
  if (!key || !region) return []
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
    headers: { 'Ocp-Apim-Subscription-Key': key },
  })
  if (!response.ok) throw new Error(`Azure 音色列表读取失败：${response.status}`)
  const voices = await response.json()
  return voices
    .filter((voice) => ['en-US', 'en-GB'].includes(voice.Locale))
    .map((voice) => ({
      id: voice.ShortName,
      name: `${voice.LocalName || voice.DisplayName || voice.ShortName} · ${voice.Locale} · ${voice.Gender || ''}`,
      accent: voice.Locale === 'en-GB' ? 'gb' : 'us',
      provider: 'azure',
    }))
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return rejectMethod(res, 'GET')
  if (!requireSession(req, res)) return
  try {
    const azure = await fetchAzureVoices().catch((error) => {
      console.warn(error)
      return azureVoiceFallbacks
    })
    return sendJson(res, 200, {
      ok: true,
      azure: azure.length ? azure : azureVoiceFallbacks,
      edge: edgeVoiceFallbacks,
    })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '读取音色失败。' })
  }
}

