export const normalizeWords = (words, limit = 80) => {
  if (!Array.isArray(words)) return []
  return words
    .map((word) => String(word || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, limit)
}

export const clampNumber = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export const escapeXml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')

export const localeFromAccent = (accent = 'us') => (accent === 'gb' ? 'en-GB' : 'en-US')

export const defaultAzureVoice = (accent = 'us') => (accent === 'gb' ? 'en-GB-SoniaNeural' : 'en-US-JennyNeural')

export const buildAzureSsml = ({ words, voice, accent, rate = 0, pauseMs = 800 }) => {
  const locale = localeFromAccent(accent)
  const safeVoice = voice || defaultAzureVoice(accent)
  const safeRate = clampNumber(rate, -50, 50, 0)
  const safePause = Math.round(clampNumber(pauseMs, 0, 5000, 800))
  const rateText = safeRate > 0 ? `+${safeRate}%` : `${safeRate}%`
  const body = words
    .map((word, index) => {
      const pause = index < words.length - 1 ? `<break time="${safePause}ms"/>` : ''
      return `<s>${escapeXml(word)}</s>${pause}`
    })
    .join('')

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}"><voice name="${escapeXml(safeVoice)}"><prosody rate="${rateText}">${body}</prosody></voice></speak>`
}

export const azureVoiceFallbacks = [
  { id: 'en-US-JennyNeural', name: 'Jenny · US · Female', accent: 'us', provider: 'azure' },
  { id: 'en-US-GuyNeural', name: 'Guy · US · Male', accent: 'us', provider: 'azure' },
  { id: 'en-US-AriaNeural', name: 'Aria · US · Female', accent: 'us', provider: 'azure' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia · UK · Female', accent: 'gb', provider: 'azure' },
  { id: 'en-GB-RyanNeural', name: 'Ryan · UK · Male', accent: 'gb', provider: 'azure' },
]

export const edgeVoiceFallbacks = azureVoiceFallbacks.map((voice) => ({ ...voice, provider: 'edge' }))
