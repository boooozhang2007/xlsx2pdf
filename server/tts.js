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

// Rime (Coda) 音色：来自 https://docs.rime.ai/docs/voices-coda.md 的英文目录，
// 已逐个用真实 API 验证可合成（185/185）。accent 只区分美音/英音，其余国家归入美音分组。
export const rimeVoiceFallbacks = [
  { id: 'astra', name: 'Astra · US · Female', accent: 'us', provider: 'rime' },
  { id: 'bancroft', name: 'Bancroft · US · Male', accent: 'us', provider: 'rime' },
  { id: 'beatty', name: 'Beatty · US · Male', accent: 'us', provider: 'rime' },
  { id: 'clementine', name: 'Clementine · US · Female', accent: 'us', provider: 'rime' },
  { id: 'cupola', name: 'Cupola · US · Male', accent: 'us', provider: 'rime' },
  { id: 'eyre', name: 'Eyre · US · Female', accent: 'us', provider: 'rime' },
  { id: 'godfrey', name: 'Godfrey · US · Male', accent: 'us', provider: 'rime' },
  { id: 'hesse', name: 'Hesse · US · Female', accent: 'us', provider: 'rime' },
  { id: 'lawton', name: 'Lawton · US · Male', accent: 'us', provider: 'rime' },
  { id: 'lintel', name: 'Lintel · US · Female', accent: 'us', provider: 'rime' },
  { id: 'luna', name: 'Luna · US · Female', accent: 'us', provider: 'rime' },
  { id: 'lyra', name: 'Lyra · US · Female', accent: 'us', provider: 'rime' },
  { id: 'marlu', name: 'Marlu · AU · Male', accent: 'us', provider: 'rime' },
  { id: 'masonry', name: 'Masonry · US · Male', accent: 'us', provider: 'rime' },
  { id: 'parapet', name: 'Parapet · US · Male', accent: 'us', provider: 'rime' },
  { id: 'vespera', name: 'Vespera · US · Female', accent: 'us', provider: 'rime' },
  { id: 'adeline', name: 'Adeline · US · Female', accent: 'us', provider: 'rime' },
  { id: 'albion', name: 'Albion · GB · Male', accent: 'gb', provider: 'rime' },
  { id: 'alfhild', name: 'Alfhild · US · Female', accent: 'us', provider: 'rime' },
  { id: 'alma', name: 'Alma · US · Female', accent: 'us', provider: 'rime' },
  { id: 'almond', name: 'Almond · NZ · Male', accent: 'us', provider: 'rime' },
  { id: 'alpine', name: 'Alpine · US · Male', accent: 'us', provider: 'rime' },
  { id: 'amarante', name: 'Amarante · CA · Female', accent: 'us', provider: 'rime' },
  { id: 'ana', name: 'Ana · US · Female', accent: 'us', provider: 'rime' },
  { id: 'andromeda', name: 'Andromeda · US · Female', accent: 'us', provider: 'rime' },
  { id: 'arcade', name: 'Arcade · US · Male', accent: 'us', provider: 'rime' },
  { id: 'argon', name: 'Argon · US · Female', accent: 'us', provider: 'rime' },
  { id: 'armpatch', name: 'Armpatch · US · Male', accent: 'us', provider: 'rime' },
  { id: 'atrium', name: 'Atrium · US · Male', accent: 'us', provider: 'rime' },
  { id: 'aurelio', name: 'Aurelio · US · Male', accent: 'us', provider: 'rime' },
  { id: 'azura', name: 'Azura · US · Female', accent: 'us', provider: 'rime' },
  { id: 'backbay', name: 'Backbay · US · Male', accent: 'us', provider: 'rime' },
  { id: 'baobab', name: 'Baobab · NG · Male', accent: 'us', provider: 'rime' },
  { id: 'bauer', name: 'Bauer · US · Male', accent: 'us', provider: 'rime' },
  { id: 'belle', name: 'Belle · US · Female', accent: 'us', provider: 'rime' },
  { id: 'berklee', name: 'Berklee · US · Female', accent: 'us', provider: 'rime' },
  { id: 'bianchi', name: 'Bianchi · US · Female', accent: 'us', provider: 'rime' },
  { id: 'birch', name: 'Birch · US · Female', accent: 'us', provider: 'rime' },
  { id: 'blackout', name: 'Blackout · US · Male', accent: 'us', provider: 'rime' },
  { id: 'blue', name: 'Blue · US · Male', accent: 'us', provider: 'rime' },
  { id: 'bogg', name: 'Bogg · GB · Male', accent: 'gb', provider: 'rime' },
  { id: 'bond', name: 'Bond · US · Male', accent: 'us', provider: 'rime' },
  { id: 'brightwater', name: 'Brightwater · US · Female', accent: 'us', provider: 'rime' },
  { id: 'bronte', name: 'Bronte · US · Female', accent: 'us', provider: 'rime' },
  { id: 'brussels', name: 'Brussels · US · Male', accent: 'us', provider: 'rime' },
  { id: 'castro', name: 'Castro · US · Male', accent: 'us', provider: 'rime' },
  { id: 'celer', name: 'Celer · IN · Male', accent: 'us', provider: 'rime' },
  { id: 'celeste', name: 'Celeste · US · Female', accent: 'us', provider: 'rime' },
  { id: 'chantal', name: 'Chantal · US · Female', accent: 'us', provider: 'rime' },
  { id: 'cherry', name: 'Cherry · NZ · Female', accent: 'us', provider: 'rime' },
  { id: 'clara', name: 'Clara · US · Female', accent: 'us', provider: 'rime' },
  { id: 'clarity', name: 'Clarity · US · Male', accent: 'us', provider: 'rime' },
  { id: 'cliff', name: 'Cliff · IE · Male', accent: 'us', provider: 'rime' },
  { id: 'clipper', name: 'Clipper · US · Male', accent: 'us', provider: 'rime' },
  { id: 'clover', name: 'Clover · NZ · Male', accent: 'us', provider: 'rime' },
  { id: 'dayform', name: 'Dayform · US · Female', accent: 'us', provider: 'rime' },
  { id: 'dore', name: 'Dore · US · Male', accent: 'us', provider: 'rime' },
  { id: 'dove', name: 'Dove · US · Female', accent: 'us', provider: 'rime' },
  { id: 'drift', name: 'Drift · US · Male', accent: 'us', provider: 'rime' },
  { id: 'drownlight', name: 'Drownlight · AU · Male', accent: 'us', provider: 'rime' },
  { id: 'egbert', name: 'Egbert · US · Male', accent: 'us', provider: 'rime' },
  { id: 'eliphas', name: 'Eliphas · US · Male', accent: 'us', provider: 'rime' },
  { id: 'elsie', name: 'Elsie · US · Female', accent: 'us', provider: 'rime' },
  { id: 'estelle', name: 'Estelle · US · Female', accent: 'us', provider: 'rime' },
  { id: 'esther', name: 'Esther · US · Female', accent: 'us', provider: 'rime' },
  { id: 'eucalyptus', name: 'Eucalyptus · AU · Female', accent: 'us', provider: 'rime' },
  { id: 'everett', name: 'Everett · US · Male', accent: 'us', provider: 'rime' },
  { id: 'everstatic', name: 'Everstatic · US · Male', accent: 'us', provider: 'rime' },
  { id: 'fade', name: 'Fade · US · Male', accent: 'us', provider: 'rime' },
  { id: 'faith', name: 'Faith · US · Female', accent: 'us', provider: 'rime' },
  { id: 'fern', name: 'Fern · US · Male', accent: 'us', provider: 'rime' },
  { id: 'firefly', name: 'Firefly · US · Female', accent: 'us', provider: 'rime' },
  { id: 'firewall', name: 'Firewall · US · Male', accent: 'us', provider: 'rime' },
  { id: 'fleetfox', name: 'Fleetfox · US · Female', accent: 'us', provider: 'rime' },
  { id: 'foster', name: 'Foster · US · Male', accent: 'us', provider: 'rime' },
  { id: 'frost', name: 'Frost · GB · Male', accent: 'gb', provider: 'rime' },
  { id: 'fuzz', name: 'Fuzz · GB · Male', accent: 'gb', provider: 'rime' },
  { id: 'ghostface', name: 'Ghostface · US · Male', accent: 'us', provider: 'rime' },
  { id: 'glasshour', name: 'Glasshour · US · Female', accent: 'us', provider: 'rime' },
  { id: 'green', name: 'Green · US · Female', accent: 'us', provider: 'rime' },
  { id: 'greyline', name: 'Greyline · GB · Male', accent: 'gb', provider: 'rime' },
  { id: 'hawa', name: 'Hawa · IN · Female', accent: 'us', provider: 'rime' },
  { id: 'helium', name: 'Helium · US · Female', accent: 'us', provider: 'rime' },
  { id: 'heller', name: 'Heller · US · Male', accent: 'us', provider: 'rime' },
  { id: 'holloway', name: 'Holloway · US · Male', accent: 'us', provider: 'rime' },
  { id: 'hugo', name: 'Hugo · US · Male', accent: 'us', provider: 'rime' },
  { id: 'ibis', name: 'Ibis · US · Female', accent: 'us', provider: 'rime' },
  { id: 'jayne', name: 'Jayne · US · Female', accent: 'us', provider: 'rime' },
  { id: 'jenco', name: 'Jenco · US · Female', accent: 'us', provider: 'rime' },
  { id: 'jicarilla', name: 'Jicarilla · US · Female', accent: 'us', provider: 'rime' },
  { id: 'joyce', name: 'Joyce · US · Female', accent: 'us', provider: 'rime' },
  { id: 'jupiter', name: 'Jupiter · US · Male', accent: 'us', provider: 'rime' },
  { id: 'katherine', name: 'Katherine · US · Female', accent: 'us', provider: 'rime' },
  { id: 'kima', name: 'Kima · US · Female', accent: 'us', provider: 'rime' },
  { id: 'kimashley', name: 'Kimashley · US · Female', accent: 'us', provider: 'rime' },
  { id: 'latte', name: 'Latte · US · Female', accent: 'us', provider: 'rime' },
  { id: 'lector', name: 'Lector · US · Male', accent: 'us', provider: 'rime' },
  { id: 'leni', name: 'Leni · IN · Female', accent: 'us', provider: 'rime' },
  { id: 'linden', name: 'Linden · US · Male', accent: 'us', provider: 'rime' },
  { id: 'luise', name: 'Luise · US · Female', accent: 'us', provider: 'rime' },
  { id: 'lydia', name: 'Lydia · US · Female', accent: 'us', provider: 'rime' },
  { id: 'maddux', name: 'Maddux · US · Female', accent: 'us', provider: 'rime' },
  { id: 'madison', name: 'Madison · US · Female', accent: 'us', provider: 'rime' },
  { id: 'matilda', name: 'Matilda · AU · Female', accent: 'us', provider: 'rime' },
  { id: 'meadow', name: 'Meadow · GB · Female', accent: 'gb', provider: 'rime' },
  { id: 'mercury', name: 'Mercury · US · Male', accent: 'us', provider: 'rime' },
  { id: 'meridian', name: 'Meridian · AU · Male', accent: 'us', provider: 'rime' },
  { id: 'merritt', name: 'Merritt · US · Female', accent: 'us', provider: 'rime' },
  { id: 'milan', name: 'Milan · US · Female', accent: 'us', provider: 'rime' },
  { id: 'milton', name: 'Milton · US · Male', accent: 'us', provider: 'rime' },
  { id: 'mopang', name: 'Mopang · SG · Female', accent: 'us', provider: 'rime' },
  { id: 'moraga', name: 'Moraga · US · Female', accent: 'us', provider: 'rime' },
  { id: 'moss', name: 'Moss · SG · Female', accent: 'us', provider: 'rime' },
  { id: 'myrtle', name: 'Myrtle · US · Female', accent: 'us', provider: 'rime' },
  { id: 'naipaul', name: 'Naipaul · ZA · Male', accent: 'us', provider: 'rime' },
  { id: 'neptune', name: 'Neptune · US · Male', accent: 'us', provider: 'rime' },
  { id: 'nexus', name: 'Nexus · US · Male', accent: 'us', provider: 'rime' },
  { id: 'nicklaus', name: 'Nicklaus · US · Male', accent: 'us', provider: 'rime' },
  { id: 'northvale', name: 'Northvale · GB · Male', accent: 'gb', provider: 'rime' },
  { id: 'ocean', name: 'Ocean · US · Female', accent: 'us', provider: 'rime' },
  { id: 'oculus', name: 'Oculus · US · Female', accent: 'us', provider: 'rime' },
  { id: 'orbea', name: 'Orbea · US · Female', accent: 'us', provider: 'rime' },
  { id: 'orion', name: 'Orion · US · Male', accent: 'us', provider: 'rime' },
  { id: 'ozu', name: 'Ozu · US · Female', accent: 'us', provider: 'rime' },
  { id: 'palegreen', name: 'Palegreen · IE · Male', accent: 'us', provider: 'rime' },
  { id: 'paula', name: 'Paula · US · Female', accent: 'us', provider: 'rime' },
  { id: 'perth', name: 'Perth · AU · Female', accent: 'us', provider: 'rime' },
  { id: 'petal', name: 'Petal · US · Female', accent: 'us', provider: 'rime' },
  { id: 'pilaster', name: 'Pilaster · US · Male', accent: 'us', provider: 'rime' },
  { id: 'pimlico', name: 'Pimlico · US · Male', accent: 'us', provider: 'rime' },
  { id: 'pola', name: 'Pola · DO · Female', accent: 'us', provider: 'rime' },
  { id: 'potrero', name: 'Potrero · US · Male', accent: 'us', provider: 'rime' },
  { id: 'prentiss', name: 'Prentiss · US · Female', accent: 'us', provider: 'rime' },
  { id: 'proxy', name: 'Proxy · US · Male', accent: 'us', provider: 'rime' },
  { id: 'pulse', name: 'Pulse · US · Male', accent: 'us', provider: 'rime' },
  { id: 'purple', name: 'Purple · US · Female', accent: 'us', provider: 'rime' },
  { id: 'qwell', name: 'Qwell · US · Male', accent: 'us', provider: 'rime' },
  { id: 'rainy', name: 'Rainy · GB · Female', accent: 'gb', provider: 'rime' },
  { id: 'rodriguez_carla', name: 'Rodriguez_carla · US · Female', accent: 'us', provider: 'rime' },
  { id: 'ronan', name: 'Ronan · IE · Female', accent: 'us', provider: 'rime' },
  { id: 'rooney', name: 'Rooney · US · Male', accent: 'us', provider: 'rime' },
  { id: 'rosal', name: 'Rosal · US · Female', accent: 'us', provider: 'rime' },
  { id: 'rosemount', name: 'Rosemount · US · Female', accent: 'us', provider: 'rime' },
  { id: 'ru', name: 'Ru · US · Male', accent: 'us', provider: 'rime' },
  { id: 'sachet', name: 'Sachet · US · Female', accent: 'us', provider: 'rime' },
  { id: 'sage', name: 'Sage · US · Male', accent: 'us', provider: 'rime' },
  { id: 'salik', name: 'Salik · US · Male', accent: 'us', provider: 'rime' },
  { id: 'sandoval', name: 'Sandoval · US · Male', accent: 'us', provider: 'rime' },
  { id: 'santal', name: 'Santal · US · Male', accent: 'us', provider: 'rime' },
  { id: 'saturn', name: 'Saturn · GB · Male', accent: 'gb', provider: 'rime' },
  { id: 'sirius', name: 'Sirius · US · Male', accent: 'us', provider: 'rime' },
  { id: 'sky', name: 'Sky · US · Female', accent: 'us', provider: 'rime' },
  { id: 'solana', name: 'Solana · US · Male', accent: 'us', provider: 'rime' },
  { id: 'sonnagh', name: 'Sonnagh · IE · Female', accent: 'us', provider: 'rime' },
  { id: 'southvale', name: 'Southvale · AU · Female', accent: 'us', provider: 'rime' },
  { id: 'sprite', name: 'Sprite · US · Female', accent: 'us', provider: 'rime' },
  { id: 'star', name: 'Star · US · Male', accent: 'us', provider: 'rime' },
  { id: 'stucco', name: 'Stucco · US · Male', accent: 'us', provider: 'rime' },
  { id: 'sunset', name: 'Sunset · US · Male', accent: 'us', provider: 'rime' },
  { id: 'sylune', name: 'Sylune · US · Female', accent: 'us', provider: 'rime' },
  { id: 'tauro', name: 'Tauro · US · Male', accent: 'us', provider: 'rime' },
  { id: 'thalassa', name: 'Thalassa · US · Female', accent: 'us', provider: 'rime' },
  { id: 'thread', name: 'Thread · US · Male', accent: 'us', provider: 'rime' },
  { id: 'tim', name: 'Tim · US · Male', accent: 'us', provider: 'rime' },
  { id: 'topeka', name: 'Topeka · US · Female', accent: 'us', provider: 'rime' },
  { id: 'transom', name: 'Transom · US · Female', accent: 'us', provider: 'rime' },
  { id: 'truss', name: 'Truss · US · Male', accent: 'us', provider: 'rime' },
  { id: 'ursa', name: 'Ursa · US · Male', accent: 'us', provider: 'rime' },
  { id: 'vashti', name: 'Vashti · GB · Female', accent: 'gb', provider: 'rime' },
  { id: 'vayu', name: 'Vayu · US · Male', accent: 'us', provider: 'rime' },
  { id: 'velune', name: 'Velune · US · Female', accent: 'us', provider: 'rime' },
  { id: 'vernal', name: 'Vernal · US · Male', accent: 'us', provider: 'rime' },
  { id: 'vesta', name: 'Vesta · US · Female', accent: 'us', provider: 'rime' },
  { id: 'victoria', name: 'Victoria · US · Female', accent: 'us', provider: 'rime' },
  { id: 'walavista', name: 'Walavista · US · Female', accent: 'us', provider: 'rime' },
  { id: 'walnut', name: 'Walnut · US · Male', accent: 'us', provider: 'rime' },
  { id: 'waveroom', name: 'Waveroom · US · Male', accent: 'us', provider: 'rime' },
  { id: 'wawona', name: 'Wawona · US · Female', accent: 'us', provider: 'rime' },
  { id: 'willow', name: 'Willow · US · Female', accent: 'us', provider: 'rime' },
  { id: 'woodwind', name: 'Woodwind · IE · Female', accent: 'us', provider: 'rime' },
  { id: 'woolsey', name: 'Woolsey · US · Male', accent: 'us', provider: 'rime' },
  { id: 'wren', name: 'Wren · GB · Male', accent: 'gb', provider: 'rime' },
  { id: 'yukiko', name: 'Yukiko · US · Female', accent: 'us', provider: 'rime' },
  { id: 'zellish', name: 'Zellish · US · Male', accent: 'us', provider: 'rime' },
  { id: 'zen', name: 'Zen · US · Male', accent: 'us', provider: 'rime' },
]

export const defaultRimeVoice = (accent = 'us') => (accent === 'gb' ? 'albion' : 'celeste')

export const rimeSpeedAlpha = (rate = 0) => {
  const safeRate = clampNumber(rate, -50, 50, 0)
  return Math.round((1 + safeRate / 100) * 100) / 100
}
