export const DEFAULT_TTS_CONFIG = {
  provider: 'azure',
  accent: 'us',
  azureVoice: 'en-US-JennyNeural',
  edgeVoice: 'en-US-JennyNeural',
  rate: 0,
  pauseMs: 800,
  batchSize: 20,
}

export const splitWords = (text) => String(text || '')
  .split(/[\n,，;；\t]+/)
  .map((item) => item.replace(/^\d+[.)、\s-]*/, '').trim())
  .filter(Boolean)

export const uniqueKeepOrder = (items) => {
  const seen = new Set()
  return items.filter((item) => {
    const key = item.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const chunkWords = (words, size) => {
  const safeSize = Math.max(1, Math.min(80, Number.parseInt(size, 10) || DEFAULT_TTS_CONFIG.batchSize))
  const chunks = []
  for (let index = 0; index < words.length; index += safeSize) {
    chunks.push(words.slice(index, index + safeSize))
  }
  return chunks
}

export const isEdgeBrowser = () => /Edg\//.test(navigator.userAgent)

export const getSpeechSupport = () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window

export const speakWordsLocally = ({ words, rate = 0, pauseMs = 800, accent = 'us', onWord, onDone, onError }) => {
  if (!getSpeechSupport()) throw new Error('当前浏览器不支持 Web Speech API。')
  window.speechSynthesis.cancel()
  const queue = [...words]
  const lang = accent === 'gb' ? 'en-GB' : 'en-US'
  const utterRate = Math.max(0.4, Math.min(1.8, 1 + Number(rate || 0) / 100))
  let stopped = false

  const next = () => {
    if (stopped) return
    const word = queue.shift()
    if (!word) {
      onDone?.()
      return
    }
    onWord?.(word)
    const utterance = new SpeechSynthesisUtterance(word)
    utterance.lang = lang
    utterance.rate = utterRate
    utterance.onend = () => window.setTimeout(next, Math.max(0, Number(pauseMs) || 0))
    utterance.onerror = (event) => onError?.(event.error || '本机朗读失败')
    window.speechSynthesis.speak(utterance)
  }

  next()
  return () => {
    stopped = true
    window.speechSynthesis.cancel()
  }
}

export const downloadNamedBlob = (blob, name) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
