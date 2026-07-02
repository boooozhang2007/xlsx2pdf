export const DEFAULT_TTS_CONFIG = {
  provider: 'azure',
  accent: 'us',
  azureVoice: 'en-US-JennyNeural',
  edgeVoice: 'en-US-JennyNeural',
  rate: 0,
  pauseMs: 800,
  batchSize: 30,
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

const zipTextEncoder = new TextEncoder()
const ZIP_FLAG_UTF8 = 0x0800
const ZIP_EXTRA_FIELD_UNICODE_PATH = 0x7075

let crcTable = null

const getCrcTable = () => {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    crcTable[index] = value >>> 0
  }
  return crcTable
}

const crc32 = (bytes) => {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const u16 = (value) => {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, true)
  return bytes
}

const u32 = (value) => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true)
  return bytes
}

const getDosDateTime = (date = new Date()) => {
  const year = Math.max(1980, date.getFullYear())
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosTime, dosDate }
}

const hasNonAsciiBytes = (bytes) => {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] > 0x7f) return true
  }
  return false
}

const createUnicodePathExtraField = (nameBytes) => {
  if (!hasNonAsciiBytes(nameBytes)) return new Uint8Array(0)
  return new Blob([
    u16(ZIP_EXTRA_FIELD_UNICODE_PATH),
    u16(5 + nameBytes.byteLength),
    new Uint8Array([1]),
    u32(crc32(nameBytes)),
    nameBytes,
  ])
}

const normalizeZipPath = (name) => String(name || 'audio.mp3')
  .replace(/\\/g, '/')
  .replace(/^\/+/, '')
  .replace(/\/+/g, '/')
  .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
  .replace(/\/?\.\.(\/|$)/g, '-')
  || 'audio.mp3'

export const createZipBlob = async (files = []) => {
  const normalizedFiles = files
    .filter((file) => file?.blob)
    .map((file, index) => ({
      name: normalizeZipPath(file.name || `audio-${index + 1}.mp3`),
      blob: file.blob,
    }))
  if (!normalizedFiles.length) throw new Error('没有可打包的音频文件。')

  const localParts = []
  const centralParts = []
  let offset = 0
  const { dosTime, dosDate } = getDosDateTime()

  for (const file of normalizedFiles) {
    const data = new Uint8Array(await file.blob.arrayBuffer())
    const filename = zipTextEncoder.encode(file.name)
    const extraField = createUnicodePathExtraField(filename)
    const checksum = crc32(data)
    const size = data.byteLength
    const localOffset = offset
    const localHeader = new Blob([
      u32(0x04034b50),
      u16(20),
      u16(ZIP_FLAG_UTF8),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(checksum),
      u32(size),
      u32(size),
      u16(filename.byteLength),
      u16(extraField.size ?? extraField.byteLength),
      filename,
      extraField,
    ])

    localParts.push(localHeader, data)
    offset += localHeader.size + size

    centralParts.push(new Blob([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(ZIP_FLAG_UTF8),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(checksum),
      u32(size),
      u32(size),
      u16(filename.byteLength),
      u16(extraField.size ?? extraField.byteLength),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(localOffset),
      filename,
      extraField,
    ]))
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.size, 0)
  const endRecord = new Blob([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(normalizedFiles.length),
    u16(normalizedFiles.length),
    u32(centralSize),
    u32(offset),
    u16(0),
  ])

  return new Blob([...localParts, ...centralParts, endRecord], { type: 'application/zip' })
}

export const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.split(',').pop() : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

export const base64ToBlob = (base64, contentType = 'audio/mpeg') => {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return new Blob([bytes], { type: contentType })
}

const getAudioContextCtor = () => window.AudioContext || window.webkitAudioContext

const audioBufferToInt16 = (audioBuffer) => {
  const channel = audioBuffer.getChannelData(0)
  const samples = new Int16Array(channel.length)
  for (let index = 0; index < channel.length; index += 1) {
    const value = Math.max(-1, Math.min(1, channel[index]))
    samples[index] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
  return samples
}

const encodeMonoMp3 = async (audioBuffer) => {
  // lamejs 的 npm 入口在 Vite/browser 下会有几个旧式全局引用
  // （例如 MPEGMode / Lame）。先把它们指向同一份内部模块实例，
  // 否则 Edge-TTS 批量合成 MP3 时会报 “MPEGMode is not defined”。
  const [{ default: MPEGMode }, { default: Lame }] = await Promise.all([
    import('lamejs/src/js/MPEGMode.js'),
    import('lamejs/src/js/Lame.js'),
  ])
  globalThis.MPEGMode = MPEGMode
  globalThis.Lame = Lame

  const lame = await import('lamejs')
  const Mp3Encoder = lame.Mp3Encoder || lame.default?.Mp3Encoder
  if (!Mp3Encoder) throw new Error('MP3 编码器加载失败。')

  const samples = audioBufferToInt16(audioBuffer)
  const encoder = new Mp3Encoder(1, audioBuffer.sampleRate, 128)
  const chunks = []
  const blockSize = 1152

  for (let offset = 0; offset < samples.length; offset += blockSize) {
    const mp3buf = encoder.encodeBuffer(samples.subarray(offset, offset + blockSize))
    if (mp3buf.length) chunks.push(mp3buf)
  }

  const end = encoder.flush()
  if (end.length) chunks.push(end)
  return new Blob(chunks, { type: 'audio/mpeg' })
}

export const mergeSegmentBlobsToMp3 = async (segments = [], pauseMs = 0) => {
  const sourceSegments = segments.filter((segment) => segment?.blob)
  if (!sourceSegments.length) throw new Error('没有可合并的 Edge-TTS 音频片段。')

  const AudioContextCtor = getAudioContextCtor()
  if (!AudioContextCtor || typeof OfflineAudioContext === 'undefined') {
    throw new Error('当前浏览器不支持音频合成，请改用 Azure 或更新浏览器。')
  }

  const audioContext = new AudioContextCtor()
  try {
    const decoded = []
    for (const segment of sourceSegments) {
      const arrayBuffer = await segment.blob.arrayBuffer()
      decoded.push(await audioContext.decodeAudioData(arrayBuffer.slice(0)))
    }

    const sampleRate = decoded[0]?.sampleRate || 24000
    const pauseFrames = Math.max(0, Math.round((Number(pauseMs) || 0) * sampleRate / 1000))
    const totalFrames = decoded.reduce((sum, buffer) => sum + Math.ceil(buffer.duration * sampleRate), 0)
      + pauseFrames * Math.max(0, decoded.length - 1)
    const offline = new OfflineAudioContext(1, Math.max(1, totalFrames), sampleRate)

    let cursor = 0
    decoded.forEach((buffer, index) => {
      const source = offline.createBufferSource()
      source.buffer = buffer
      source.connect(offline.destination)
      source.start(cursor / sampleRate)
      cursor += Math.ceil(buffer.duration * sampleRate)
      if (index < decoded.length - 1) cursor += pauseFrames
    })

    const rendered = await offline.startRendering()
    return encodeMonoMp3(rendered)
  } finally {
    audioContext.close?.()
  }
}
