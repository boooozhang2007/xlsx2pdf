import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { createZipBuffer } from './zip.js'
import { createDocxBuffer } from './docx.js'
import { ALL_QUESTION_TYPE_KEYS, FIXED_TEST_PAPER_QUESTION_KEYS, FIXED_TEST_PAPER_SECTIONS, QUESTION_TYPE_OPTIONS } from '../shared/worksheetTypes.js'
import {
  GENERATION_MODE_FIXED_TEST_PAPER,
  GENERATION_MODE_LEGACY_ZIP,
  normalizeLegacyQuestionCount,
  normalizeTestPaperGroupSizes,
  normalizeWithChineseTranslation,
} from '../shared/generationModes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BLACK = rgb(0, 0, 0)
const GROUP_SIZE = 50
const TEST_PAPER_GROUP_SIZE = 100
const MAX_EXPORT_ROWS = 2500
const DISPLAY_WORD_OVERRIDES = {
  'analyse/ze': 'analyze',
  'apologize/se': 'apologize',
  'grey/ay': 'gray',
  'organise/ze': 'organize',
  'realise/ze': 'realize',
  'recognise/ze': 'recognize',
}
const POS_LABEL_RE = /(?<![A-Za-z])(?:vt|vi|v|n|adj|adv|a|ad|pron|prep|conj|num|int|interj|det|aux|pl)\.\s*/gi
const BAD_SENTENCE_HEADWORDS = new Set([
  'a', 'between and', 'cm', 'good afternoon', 'happy birthday', 'how old', 'kilo',
  "let's", 'nothing', 'to', 'what about',
])
const SENTENCE_STOPWORDS = new Set([
  'a', 'an', 'and', 'also', 'are', 'as', 'at', 'be', 'but', 'for', 'have', 'in',
  'is', 'nor', 'not', 'of', 'on', 'only', 'or', 'sb', "sb's", 'sth', 'the', 'to',
  'us', 'what', 'with', 'your', 'my', 'his', 'her', 'our', 'their', "one's",
])
const TRANSLATION_LAYOUT_CANDIDATES = [
  { cols: 4, fontSize: 10.5, spacing: 10 },
  { cols: 3, fontSize: 10.5, spacing: 12 },
  { cols: 4, fontSize: 10.0, spacing: 10 },
  { cols: 3, fontSize: 10.0, spacing: 12 },
  { cols: 4, fontSize: 9.5, spacing: 10 },
  { cols: 3, fontSize: 9.5, spacing: 12 },
  { cols: 3, fontSize: 9.0, spacing: 12 },
  { cols: 3, fontSize: 8.5, spacing: 12 },
]
const MM_TO_PT = 72 / 25.4
const mm = (value) => value * MM_TO_PT
const A4 = { width: mm(210), height: mm(297) }
const TRANSLATION_MARGINS = { left: 90, right: 90, top: 72, bottom: 72 }
const QUESTION_TYPE_MAP = new Map(QUESTION_TYPE_OPTIONS.map((item) => [item.key, item]))
const FIXED_TEST_PAPER_SECTION_MAP = new Map(FIXED_TEST_PAPER_SECTIONS.map((item) => [item.key, item]))
const LEXICAL_QUESTION_KEYS = new Set(['一_释义匹配', '三_同义替换', '六_同义反义辨析', '七_同义词匹配', '八_反义词匹配'])
const BASIC_MATERIAL_QUESTION_KEYS = new Set(['二_选择题', '九_判断正误'])
const normalizeGenerationMode = (mode) => (mode === GENERATION_MODE_LEGACY_ZIP ? GENERATION_MODE_LEGACY_ZIP : GENERATION_MODE_FIXED_TEST_PAPER)

let cjkFontBytesPromise = null

const getCjkFontUrlCandidates = (env = process.env) => {
  const candidates = []
  const explicitUrl = String(env.CJK_FONT_URL || '').trim()
  if (explicitUrl) candidates.push(explicitUrl)

  for (const host of [env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
    const value = String(host || '').trim()
    if (!value) continue
    candidates.push(/^https?:\/\//i.test(value) ? `${value.replace(/\/$/, '')}/STSong.ttf` : `https://${value}/STSong.ttf`)
  }

  // Keep the current public deployment as a last-resort source when Vercel's
  // system environment variables are not exposed to Workflow step functions.
  candidates.push('https://xlsx.070320.xyz/STSong.ttf')
  return [...new Set(candidates)]
}

const readCjkFontFromUrl = async (url) => {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const signature = bytes.subarray(0, 4).toString('hex')
  if (!['00010000', '4f54544f', '74746366'].includes(signature)) throw new Error('响应不是有效字体')
  return bytes
}

const loadCjkFontBytes = async () => {
  if (!cjkFontBytesPromise) {
    cjkFontBytesPromise = (async () => {
      let fileError = null
      try {
        return await fs.readFile(path.join(__dirname, '..', 'public', 'STSong.ttf'))
      } catch (error) {
        fileError = error
      }

      let lastError = fileError
      for (const url of getCjkFontUrlCandidates()) {
        try {
          return await readCjkFontFromUrl(url)
        } catch (error) {
          lastError = error
        }
      }

      throw new Error(`无法加载中文字体 STSong.ttf：${lastError?.message || '未知错误'}`)
    })()
    cjkFontBytesPromise = cjkFontBytesPromise.catch((error) => {
      cjkFontBytesPromise = null
      throw error
    })
  }
  return cjkFontBytesPromise
}

const createSeededRng = (seedInput) => {
  const hash = createHash('sha256').update(String(seedInput || 'xlsx2pdf')).digest()
  let seed = hash.readUInt32LE(0) || 1
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = (items, rng) => {
  const next = [...items]
  for (let index = next.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(rng() * (index + 1))
    ;[next[index], next[pick]] = [next[pick], next[index]]
  }
  return next
}

const sample = (items, count, rng) => shuffle(items, rng).slice(0, Math.max(0, count))
const choice = (items, rng) => items[Math.floor(rng() * items.length)]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const stripCodeFence = (text) => String(text || '')
  .trim()
  .replace(/^```(?:json)?\s*/i, '')
  .replace(/\s*```$/, '')
  .trim()

const normalizeBlankMarkers = (text) => String(text || '')
  .replace(/_{2,}/g, '______')
  .replace(/[\[({<]\s*blank\s*[\])}>]/gi, '______')

const countBlankSlots = (text) => (normalizeBlankMarkers(text).match(/_{4,}/g) || []).length

const extractBalancedJson = (text, startIndex) => {
  const source = String(text || '')
  const opener = source[startIndex]
  const closer = opener === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === opener) depth += 1
    if (char === closer) depth -= 1
    if (depth === 0) return source.slice(startIndex, index + 1)
  }
  return ''
}

const parseJsonValues = (text) => {
  const cleaned = stripCodeFence(text)
  if (!cleaned) return []
  const candidates = [cleaned]
  for (let index = 0; index < cleaned.length; index += 1) {
    if (!['[', '{'].includes(cleaned[index])) continue
    const candidate = extractBalancedJson(cleaned, index)
    if (!candidate) continue
    candidates.push(candidate)
    index += candidate.length - 1
  }
  const values = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    try {
      values.push(JSON.parse(candidate))
    } catch {
      // Keep scanning: reasoning text may contain braces before the final JSON.
    }
  }
  return values
}

const displayWord = (value) => {
  let text = String(value ?? '').replace(/\u00a0/g, ' ').trim()
  text = text.replace(/[’‘]/g, "'").replace(/…/g, '...')
  text = text.replace(/\s+/g, ' ')
  text = text.replace(/^[*•·]+/, '')
  text = text.replace(/\s*=\s*.*$/, '')
  text = DISPLAY_WORD_OVERRIDES[text] || text
  text = text.replace(/\([^)]*\)/g, '')
  text = text.replace(/\s*\(.*$/, '')
  text = text.replace(/\s*'\s*/g, "'")
  text = text.replace(/\.{3,}/g, ' ')
  text = text.replace(/[?!]+$/g, '')
  text = text.replace(/\s+/g, ' ').trim().replace(/^[ .]+|[ .]+$/g, '')
  text = text.replace(/\s+\b(?:v|n|adj|adv|vt|vi)\.$/i, '')
  if (text.toLowerCase() === 'ai') return 'AI'
  return text
}

const cleanWord = (value) => displayWord(value)
  .toLowerCase()
  .replace(/\([^)]*\)/g, '')
  .replace(/…/g, ' ')
  .replace(/[^a-z0-9' -]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const cleanCn = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
const plainCn = (value) => {
  const text = cleanCn(value)
    .replace(/＆/g, '&')
    .replace(POS_LABEL_RE, '')
    .replace(/;/g, '；')
    .replace(/,/g, '，')
    .replace(/([\u4e00-\u9fff]{2,6})\1/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[ &;；,，]+|[ &;；,，]+$/g, '')
  return text || cleanCn(value)
}

const canonicalizeEnglishPunctuation = (value) => String(value ?? '')
  .replace(/[’‘]/g, "'")
  .replace(/[‐‑‒–—]/g, '-')

const normalizeRelationTerm = (value) => canonicalizeEnglishPunctuation(value)
  .replace(/_/g, ' ')
  .toLowerCase()
  .replace(/[^a-z' -]+/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s*-\s*/g, '-')
  .trim()

const lettersOnly = (value) => String(value ?? '').toLowerCase().replace(/[^a-z]/g, '')
const simpleStem = (value) => {
  const text = lettersOnly(value)
  const suffixes = [
    'ingly', 'edly', 'ation', 'itions', 'ness', 'ment', 'tion', 'sion',
    'ity', 'ist', 'ism', 'ive', 'ous', 'able', 'ible', 'ful', 'less',
    'ing', 'ed', 'ly', 'er', 'est', 'al', 's',
  ]
  for (const suffix of suffixes) {
    if (text.length > suffix.length + 3 && text.endsWith(suffix)) return text.slice(0, -suffix.length)
  }
  return text
}

const isMorphVariant = (left, right) => {
  const a = lettersOnly(left)
  const b = lettersOnly(right)
  if (!a || !b || a === b) return true
  if (simpleStem(a) === simpleStem(b)) return true
  if (Math.min(a.length, b.length) >= 4 && Math.abs(a.length - b.length) <= 5) {
    return a.startsWith(b) || b.startsWith(a)
  }
  return false
}

const spellingCore = (value) => {
  const text = cleanWord(value)
  return text && !text.includes(' ') && /^[a-z]+$/i.test(text) ? text : ''
}

const isSentenceCompatibleWord = (value) => {
  const word = displayWord(value)
  const lower = word.toLowerCase()
  if (BAD_SENTENCE_HEADWORDS.has(lower)) return false
  if (cleanWord(word).replace(/ /g, '').length < 2) return false
  const tokens = lower.match(/[A-Za-z']+/g) || []
  const contentTokens = tokens.filter((token) => !SENTENCE_STOPWORDS.has(token))
  if (tokens.length >= 2 && contentTokens.length < 2) return false
  return /^[A-Za-z][A-Za-z' ]*[A-Za-z]$|^[A-Za-z]+$/.test(word)
}

const sanitizeExportName = (value, fallback = '词组练习') => {
  const text = String(value ?? '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[ .]+|[ .]+$/g, '')
  return text || fallback
}

const materialKey = (entry) => `${entry.cleanEnglish}||${entry.plainChinese}`
const lexicalKey = materialKey

const normalizeRows = (rows, limit = MAX_EXPORT_ROWS) => {
  const out = []
  for (const row of rows || []) {
    const english = String(row?.english ?? '').trim()
    if (!english) continue
    const chinese = cleanCn(row?.chinese ?? '')
    out.push({
      english,
      chinese,
      displayEnglish: displayWord(english),
      cleanEnglish: cleanWord(english),
      plainChinese: plainCn(chinese),
    })
    if (out.length >= limit) break
  }
  return out.map((entry) => ({ ...entry, key: lexicalKey(entry) }))
}

const chunkGroups = (items, size = GROUP_SIZE) => {
  const groups = []
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size))
  return groups
}

const dedupeEntriesByKey = (entries) => Array.from(new Map((entries || []).map((entry) => [entry.key, entry])).values())
export const countCachedEntries = (entries, cache) => (entries || []).filter((entry) => cache?.has(entry.key)).length

const normalizeQuestionTypes = (questionTypes) => {
  const keys = Array.isArray(questionTypes) && questionTypes.length ? questionTypes : ALL_QUESTION_TYPE_KEYS
  const seen = new Set()
  return keys.filter((key) => QUESTION_TYPE_MAP.has(key) && !seen.has(key) && seen.add(key))
}

const replaceAnswerWithBlank = (sentence, answer) => {
  const source = canonicalizeEnglishPunctuation(sentence).trim()
  const expected = canonicalizeEnglishPunctuation(answer).trim()
  if (!source || !expected) return ''
  const pattern = expected
    .split(/[\s-]+/g)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:\\s+|-)')
  const regex = new RegExp(`(?<![A-Za-z])${pattern}(?![A-Za-z])`, 'i')
  const match = source.match(regex)
  return match ? source.replace(regex, '______') : ''
}

export const buildClozeSentence = ({ blankSentence = '', fullSentence = '', fallbackSentences = [] } = {}, answer = '') => {
  const normalizedBlank = normalizeBlankMarkers(blankSentence).trim()
  if (countBlankSlots(normalizedBlank) === 1) return normalizedBlank
  for (const sentence of [fullSentence, ...(fallbackSentences || [])]) {
    const replaced = replaceAnswerWithBlank(sentence, answer)
    if (countBlankSlots(replaced) === 1) return replaced
  }
  return ''
}

const containsWholeWord = (sentence, answer) => {
  const source = canonicalizeEnglishPunctuation(sentence).trim()
  const expected = canonicalizeEnglishPunctuation(answer).trim()
  if (!source || !expected) return false
  const pattern = expected
    .split(/[\s-]+/g)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:\\s+|-)')
  return new RegExp(`(?<![A-Za-z])${pattern}(?![A-Za-z])`, 'i').test(source)
}

const uniqueDistractors = (pool, correct, count, keyFn, rng) => {
  const correctKey = keyFn(correct)
  const seen = new Set([correctKey])
  const result = []
  for (const item of shuffle(pool, rng)) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= count) break
  }
  return result
}

const getRequiredEnv = (name) => {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

const STRICT_JSON_ONLY_RULES = [
  'Return exactly one valid JSON array and nothing else.',
  'Do not output markdown, code fences, comments, headings, explanations, or any extra text.',
  'The array length must exactly match the number of input items.',
  'Keep every input id exactly once.',
  'Preserve the input order.',
  'Every array item must be a JSON object containing all required fields.',
  'Never omit a required field. Use an empty string only when that field-specific rule explicitly allows it.',
]

const buildStrictJsonInstruction = (requiredFields, example) => [
  ...STRICT_JSON_ONLY_RULES,
  `Each object must contain exactly these fields: ${requiredFields.join(', ')}.`,
  `Complete example output array for one input item: ${JSON.stringify([example])}.`,
].join(' ')

const buildStrictJsonObjectInstruction = (requiredFields, example) => [
  'Return exactly one valid JSON object and nothing else.',
  'Do not output markdown, code fences, comments, headings, explanations, or any extra text.',
  'The object must contain all required fields exactly once.',
  'Never omit a required field. Use an empty string only when that field-specific rule explicitly allows it.',
  `The object must contain exactly these fields: ${requiredFields.join(', ')}.`,
  `Example output object: ${JSON.stringify(example)}.`,
].join(' ')

const parseLlmModelOptions = () => {
  const raw = String(process.env.VIVI_LLM_MODELS || '').trim()
  const legacyDefault = String(process.env.VIVI_LLM_MODEL || '').trim()

  if (!raw) {
    const fallbackId = legacyDefault || getRequiredEnv('VIVI_LLM_MODEL')
    return [{ id: fallbackId, label: fallbackId }]
  }

  let parsedItems = []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      parsedItems = parsed
    } else if (parsed && Array.isArray(parsed.models)) {
      parsedItems = parsed.models
    }
  } catch {
    parsedItems = raw.split(/[\n,]+/g)
  }

  const options = parsedItems
    .map((item) => {
      if (typeof item === 'string') {
        const id = item.trim()
        return id ? { id, label: id } : null
      }
      if (!item || typeof item !== 'object') return null
      const id = String(item.id || item.model || item.value || '').trim()
      if (!id) return null
      const label = String(item.label || item.name || id).trim() || id
      return { id, label }
    })
    .filter(Boolean)

  if (!options.length) {
    const fallbackId = legacyDefault || getRequiredEnv('VIVI_LLM_MODEL')
    return [{ id: fallbackId, label: fallbackId }]
  }

  const deduped = []
  const seen = new Set()
  for (const option of options) {
    if (seen.has(option.id)) continue
    seen.add(option.id)
    deduped.push(option)
  }
  return deduped
}

export const getAvailableLlmModels = () => parseLlmModelOptions()

export const getDefaultLlmModel = () => {
  const options = parseLlmModelOptions()
  const preferred = String(process.env.VIVI_LLM_MODEL || '').trim()
  if (preferred && options.some((item) => item.id === preferred)) return preferred
  return options[0]?.id || ''
}

export const orderWorksheetFallbackModels = (models = []) => {
  const lowCapacityPattern = /(?:^|[^0-9])(?:4b|8b)(?:[^0-9]|$)/i
  return [...models].sort((left, right) => (
    Number(lowCapacityPattern.test(String(left || ''))) - Number(lowCapacityPattern.test(String(right || '')))
  ))
}

const parseFallbackModelConfig = () => {
  const raw = String(process.env.VIVI_LLM_FALLBACK_MODELS || '').trim()
  if (!raw) return { defaultChain: [], byModel: new Map() }

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return {
        defaultChain: parsed.map((item) => String(item || '').trim()).filter(Boolean),
        byModel: new Map(),
      }
    }
    if (parsed && typeof parsed === 'object') {
      const byModel = new Map()
      let defaultChain = []
      Object.entries(parsed).forEach(([key, value]) => {
        const items = Array.isArray(value)
          ? value.map((item) => String(item || '').trim()).filter(Boolean)
          : String(value || '').split(/[\n,]+/g).map((item) => item.trim()).filter(Boolean)
        if (!items.length) return
        if (key === 'default') {
          defaultChain = items
          return
        }
        byModel.set(String(key || '').trim(), items)
      })
      return { defaultChain, byModel }
    }
  } catch {
    return {
      defaultChain: raw.split(/[\n,]+/g).map((item) => item.trim()).filter(Boolean),
      byModel: new Map(),
    }
  }

  return { defaultChain: [], byModel: new Map() }
}

export const getFallbackLlmModels = (primaryModel = '') => {
  const primary = String(primaryModel || getDefaultLlmModel()).trim()
  const available = parseLlmModelOptions().map((item) => item.id)
  const { defaultChain, byModel } = parseFallbackModelConfig()
  const configured = byModel.get(primary) || defaultChain
  const candidates = configured.length
    ? configured
    : orderWorksheetFallbackModels(available.filter((item) => item !== primary))
  const deduped = []
  const seen = new Set([primary])
  for (const candidate of candidates) {
    const model = String(candidate || '').trim()
    if (!model || seen.has(model) || !available.includes(model)) continue
    seen.add(model)
    deduped.push(model)
  }
  if (configured.length) {
    for (const fallback of available) {
      if (!fallback || seen.has(fallback) || fallback === primary) continue
      seen.add(fallback)
      deduped.push(fallback)
    }
  }
  return deduped
}

const getLlmConfig = (options = {}) => {
  const apiKey = getRequiredEnv('VIVI_LLM_API_KEY')
  let baseUrl = getRequiredEnv('VIVI_LLM_BASE_URL').replace(/\/+$/, '')
  if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`
  const models = parseLlmModelOptions()
  const requestedModel = String(options.model || '').trim()
  const model = requestedModel && models.some((item) => item.id === requestedModel)
    ? requestedModel
    : getDefaultLlmModel()
  const configuredBatchSize = Number.parseInt(process.env.VIVI_LLM_BATCH_SIZE || '20', 10) || 20
  const configuredConcurrency = Math.max(1, Number.parseInt(process.env.VIVI_LLM_CONCURRENCY || '5', 10) || 5)
  const batchSize = Math.max(1, Number.parseInt(options.batchSize, 10) || configuredBatchSize)
  const concurrency = Math.max(1, Number.parseInt(options.concurrency, 10) || configuredConcurrency)
  return {
    apiKey,
    baseUrl,
    model,
    batchSize,
    concurrency,
    url: `${baseUrl}/v1/chat/completions`,
  }
}

export const getLlmJobRuntime = (selectedModel = '', overrides = {}) => {
  const config = getLlmConfig({
    model: selectedModel,
    batchSize: overrides.batchSize,
    concurrency: overrides.concurrency,
  })
  return {
    model: config.model,
    batchSize: config.batchSize,
    concurrency: config.concurrency,
    fallbackModels: getFallbackLlmModels(config.model),
  }
}

const getLlmRetryPolicy = () => ({
  requestRetries: Math.max(1, Number.parseInt(process.env.VIVI_LLM_REQUEST_RETRIES || '1', 10) || 1),
  singleItemRetries: Math.max(1, Number.parseInt(process.env.VIVI_LLM_SINGLE_ITEM_RETRIES || '2', 10) || 2),
  requestTimeoutMs: Math.max(5000, Number.parseInt(process.env.VIVI_LLM_REQUEST_TIMEOUT_MS || '60000', 10) || 60000),
})

const createLlmError = (message, options = {}) => Object.assign(new Error(message), options)

const isRetryableLlmStatus = (status) => status === 400 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500

const readLlmErrorDetail = async (response) => {
  const rawText = await response.text().catch(() => '')
  if (!rawText) return ''
  let detail = rawText
  try {
    const data = JSON.parse(rawText)
    detail = data?.error?.message || data?.error || data?.message || rawText
  } catch {
    // Plain-text gateway responses are useful as-is.
  }
  return String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

const parseRetryAfterMs = (value) => {
  const source = String(value || '').trim()
  if (!source) return 0
  if (/^\d+(\.\d+)?$/.test(source)) return Math.max(0, Math.round(Number(source) * 1000))
  const timestamp = Date.parse(source)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0
}

const parseJsonArrayContent = (content) => {
  const values = parseJsonValues(content)
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const parsed = values[index]
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray(parsed.items)) return parsed.items
    if (parsed && Array.isArray(parsed.data)) return parsed.data
    if (parsed && Array.isArray(parsed.results)) return parsed.results
  }
  throw new Error('LLM 响应不是数组')
}

const parseJsonObjectContent = (content) => {
  const values = parseJsonValues(content)
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const parsed = values[index]
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.item && typeof parsed.item === 'object' && !Array.isArray(parsed.item)) return parsed.item
      if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) return parsed.data
      if (parsed.result && typeof parsed.result === 'object' && !Array.isArray(parsed.result)) return parsed.result
      return parsed
    }
  }
  throw new Error('LLM 响应不是对象')
}

const extractLlmMessageContent = (data) => {
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === 'string' ? item.text : typeof item === 'string' ? item : ''))
      .join('')
  }
  if (typeof data?.output_text === 'string') return data.output_text
  if (Array.isArray(data?.output)) {
    return data.output
      .flatMap((item) => item?.content || [])
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('')
  }
  return ''
}

const fetchLlmArray = async (payload, kind, llmOptions = {}) => {
  const { apiKey, url } = getLlmConfig(llmOptions)
  const { requestRetries, requestTimeoutMs } = getLlmRetryPolicy()
  let lastError = null
  for (let attempt = 0; attempt < requestRetries; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
        const isRateLimited = response.status === 429
        const responseDetail = await readLlmErrorDetail(response)
        throw createLlmError(`${kind} 请求失败：${response.status}${responseDetail ? `（${responseDetail}）` : ''}`, {
          code: isRateLimited ? 'LLM_RATE_LIMITED' : 'LLM_REQUEST_FAILED',
          status: response.status,
          retryAfterMs,
          retryable: isRetryableLlmStatus(response.status) || [401, 403].includes(response.status),
          model: payload.model,
          responseDetail,
        })
      }
      const rawText = await response.text()
      let data = null
      try {
        data = JSON.parse(rawText)
      } catch {
        data = { choices: [{ message: { content: rawText } }] }
      }
      try {
        return parseJsonArrayContent(extractLlmMessageContent(data)).filter(Boolean)
      } catch (error) {
        throw createLlmError(`${kind} 响应解析失败：${error.message || '返回内容不是有效 JSON 数组'}`, {
          retryable: false,
        })
      }
    } catch (error) {
      clearTimeout(timeoutId)
      lastError = error?.name === 'AbortError'
        ? createLlmError(`${kind} 请求超时（>${requestTimeoutMs / 1000}s）`, { code: 'LLM_REQUEST_FAILED', retryable: true })
        : error
      if (attempt >= requestRetries - 1 || !lastError?.retryable || lastError?.code === 'LLM_RATE_LIMITED') break
      await sleep(500 * (attempt + 1))
    }
  }
  throw lastError || new Error(`${kind} 请求失败`)
}

const fetchLlmObject = async (payload, kind, llmOptions = {}) => {
  const { apiKey, url } = getLlmConfig(llmOptions)
  const { requestRetries, requestTimeoutMs } = getLlmRetryPolicy()
  let lastError = null
  for (let attempt = 0; attempt < requestRetries; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
        const isRateLimited = response.status === 429
        const responseDetail = await readLlmErrorDetail(response)
        throw createLlmError(`${kind} 请求失败：${response.status}${responseDetail ? `（${responseDetail}）` : ''}`, {
          code: isRateLimited ? 'LLM_RATE_LIMITED' : 'LLM_REQUEST_FAILED',
          status: response.status,
          retryAfterMs,
          retryable: isRetryableLlmStatus(response.status) || [401, 403].includes(response.status),
          model: payload.model,
          responseDetail,
        })
      }
      const rawText = await response.text()
      let data = null
      try {
        data = JSON.parse(rawText)
      } catch {
        data = { choices: [{ message: { content: rawText } }] }
      }
      try {
        return parseJsonObjectContent(extractLlmMessageContent(data))
      } catch (error) {
        throw createLlmError(`${kind} 响应解析失败：${error.message || '返回内容不是有效 JSON 对象'}`, {
          retryable: false,
        })
      }
    } catch (error) {
      clearTimeout(timeoutId)
      lastError = error?.name === 'AbortError'
        ? createLlmError(`${kind} 请求超时（>${requestTimeoutMs / 1000}s）`, { code: 'LLM_REQUEST_FAILED', retryable: true })
        : error
      if (attempt >= requestRetries - 1 || !lastError?.retryable || lastError?.code === 'LLM_RATE_LIMITED') break
      await sleep(500 * (attempt + 1))
    }
  }
  throw lastError || new Error(`${kind} 请求失败`)
}

const callLlmForLexical = async (entries, llmOptions = {}) => {
  const { model } = getLlmConfig(llmOptions)
  const singleItemStrict = entries.length === 1
    ? ' Single-item strict mode: make sure definition_en does not contain the target word and synonym/antonym are each a single base-form word or short phrase.'
    : ''
  const system = [
    'You create vocabulary metadata for Chinese middle-school students.',
    buildStrictJsonInstruction(
      ['id', 'definition_en', 'definition_zh', 'synonym', 'antonym'],
      { id: 'sample-id', definition_en: 'to make something clear', definition_zh: '使某事变得清楚', synonym: 'explain', antonym: '' },
    ),
    'For each input item, keep the same id and produce: definition_en, definition_zh, synonym, antonym.',
    'Rules for definition_en: short, clear English explanation, avoid repeating the target word, no brackets. For very short function words where avoidance is unnatural, one exact occurrence is allowed.',
    'Rules for definition_zh: accurately translate definition_en into concise Simplified Chinese, no brackets.',
    'Rules for synonym and antonym: use very common classroom-friendly English words or short phrases, base form only, same part of speech when possible.',
    'If there is no safe, common choice, return an empty string.',
    'Avoid rare, slang, archaic, or highly technical words.',
    singleItemStrict,
  ].join(' ')
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          'Input JSON array:',
          JSON.stringify(entries.map((entry) => ({
            id: entry.key,
            word: entry.displayEnglish,
            meaning: entry.plainChinese,
          }))),
          'Return JSON array only.',
        ].join('\n'),
      },
    ],
    temperature: 0,
    max_tokens: Math.max(1536, Math.min(24000, 140 * entries.length)),
  }
  return fetchLlmArray(payload, 'LLM 词汇', llmOptions)
}

const callLlmForMaterials = async (entries, requireSynonym, llmOptions = {}) => {
  const { model } = getLlmConfig(llmOptions)
  const isSingle = entries.length === 1
  let requestedFields = 'cloze_full_sentence, tf_true, tf_false'
  let rules = [
    'Rules for cloze_full_sentence: it is for a multiple-choice item whose option is the vocabulary headword, so it must contain the exact input word string once, with no inflection, plural, tense change, or added suffix.',
    'Write the sentence so that exact form is grammatical; for verbs, use patterns like can/will/to + word when needed.',
    'Do not use blanks in cloze_full_sentence.',
    'tf_true and tf_false must be complete standalone English sentences using the input word; tf_true must be clearly true, tf_false clearly false.',
    ...(isSingle ? ['Single-item strict mode: make sure cloze_full_sentence contains the exact word field once and only once.'] : []),
  ]
  if (requireSynonym) {
    requestedFields = 'synonym, synonym_original, synonym_rewrite_full, synonym_rewrite_blank'
    rules = [
      'Rules for synonym: it is the exact answer shown in the options for synonym replacement.',
      'It may be inflected if grammar requires it, but synonym_rewrite_full must contain that exact synonym string once.',
      'If an input item provides required_synonym, you must use that exact text as synonym and also place that exact text in synonym_rewrite_full once.',
      'synonym_original must be a complete sentence using the input word naturally.',
      'synonym_rewrite_full must be a very similar complete sentence containing synonym exactly once; do not use blanks in it.',
      'synonym_rewrite_blank must equal synonym_rewrite_full with that exact synonym occurrence replaced by exactly six underscores: ______.',
      'synonym_rewrite_blank must contain exactly one ______ and must not contain the synonym answer.',
      'Never omit any required field; if the supplied synonym is difficult, use a short grammar-safe complete sentence that contains the exact synonym text.',
      ...(isSingle
        ? [
            'Single-item strict mode: choose the final synonym text first, copy it unchanged into synonym_rewrite_full exactly once, then replace only that occurrence with ______ in synonym_rewrite_blank.',
            'Single-item strict mode checklist: return one array containing one object; keep the same id; all four output strings must be non-empty.',
          ]
        : []),
    ]
  }
  const system = [
    'You create English vocabulary worksheet items for Chinese students.',
    buildStrictJsonInstruction(
      requireSynonym
        ? ['id', 'synonym', 'synonym_original', 'synonym_rewrite_full', 'synonym_rewrite_blank']
        : ['id', 'cloze_full_sentence', 'tf_true', 'tf_false'],
      requireSynonym
        ? {
            id: 'sample-id',
            synonym: 'quick',
            synonym_original: 'The runner is fast today.',
            synonym_rewrite_full: 'The runner is quick today.',
            synonym_rewrite_blank: 'The runner is ______ today.',
          }
        : {
            id: 'sample-id',
            cloze_full_sentence: 'We will share the food after class.',
            tf_true: 'We can share our ideas in class.',
            tf_false: 'Share means to hide everything from others.',
          },
    ),
    `For each input item, keep the same id and produce: ${requestedFields}.`,
    ...(requireSynonym
      ? [
          'Preferred synonym pattern: synonym_original uses the exact input word once; synonym_rewrite_full keeps the sentence almost unchanged and swaps only that word with the synonym.',
        ]
      : []),
    ...rules,
  ].join(' ')

  const userItems = entries.map((entry) => {
    const row = {
      id: entry.key,
      word: entry.displayEnglish,
      meaning: entry.plainChinese,
    }
    if (requireSynonym && entry.requiredSynonym) row.required_synonym = entry.requiredSynonym
    return row
  })

  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          'Input JSON array:',
          JSON.stringify(userItems),
          'Return JSON array only.',
        ].join('\n'),
      },
    ],
    temperature: 0,
    max_tokens: Math.max(1536, Math.min(24000, 180 * entries.length)),
  }
  return fetchLlmArray(payload, 'LLM 题面', llmOptions)
}

const callLlmForSynonymRepair = async (entry, lastRaw, llmOptions = {}) => {
  const synonym = String(lastRaw?.synonym || '').trim()
  const originalSentence = String(lastRaw?.synonym_original || '').trim()
  if (!synonym || !originalSentence) return null
  const { model } = getLlmConfig(llmOptions)
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: [
          'You repair one English synonym replacement item.',
          buildStrictJsonObjectInstruction(
            ['synonym_original', 'synonym_rewrite_full', 'synonym_rewrite_blank'],
            {
              synonym_original: 'The runner is fast today.',
              synonym_rewrite_full: 'The runner is quick today.',
              synonym_rewrite_blank: 'The runner is ______ today.',
            },
          ),
          'Keep the two sentences very similar in meaning and structure.',
          'synonym_rewrite_full must contain the exact given synonym string once and only once.',
          'synonym_rewrite_blank must copy synonym_rewrite_full and replace only that synonym with exactly ______.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          word: entry.displayEnglish,
          meaning: entry.plainChinese,
          synonym,
          synonym_original: originalSentence,
        }),
      },
    ],
    temperature: 0,
    max_tokens: 512,
  }
  try {
    const repaired = await fetchLlmObject(payload, 'LLM 同义替换修复', llmOptions)
    if (!repaired || typeof repaired !== 'object') return null
    // Merge repair fields into lastRaw so sanitizeMaterial can re-validate
    return {
      ...lastRaw,
      id: entry.key,
      synonym,
      synonym_original: String(repaired.synonym_original || originalSentence).trim(),
      synonym_rewrite_full: String(repaired.synonym_rewrite_full || '').trim(),
      synonym_rewrite_blank: String(repaired.synonym_rewrite_blank || '').trim(),
    }
  } catch {
    return null
  }
}

const callLlmForSynonymDoctor = async (entry, lexical, lastRaw, lastError, llmOptions = {}) => {
  const synonym = normalizeRelationTerm(
    entry.requiredSynonym
    || lastRaw?.synonym
    || lastRaw?.synonyms
    || lastRaw?.similar_word
    || lexical?.synonym
    || '',
  )
  if (!synonym) return null
  const { model } = getLlmConfig(llmOptions)
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: [
          'You are a doctor for failed English synonym replacement items.',
          buildStrictJsonObjectInstruction(
            ['id', 'synonym', 'synonym_original', 'synonym_rewrite_full', 'synonym_rewrite_blank'],
            {
              id: 'sample-id',
              synonym: 'quick',
              synonym_original: 'The runner is fast today.',
              synonym_rewrite_full: 'The runner is quick today.',
              synonym_rewrite_blank: 'The runner is ______ today.',
            },
          ),
          'Return one repaired object only.',
          'Keep the given id exactly unchanged.',
          'Keep the given synonym exactly unchanged; do not replace it with another word.',
          'If grammar becomes awkward, rewrite the whole sentence frame instead of changing the synonym text.',
          'synonym_original must contain the exact input word once and only once.',
          'synonym_rewrite_full must be a very similar complete sentence containing the exact synonym once and only once.',
          'synonym_rewrite_blank must copy synonym_rewrite_full and replace only the synonym with exactly ______.',
          'Fill every required field even if the partial draft is bad; rewrite from scratch when needed.',
          'Keep vocabulary simple and classroom-friendly for Chinese students.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          id: entry.key,
          word: entry.displayEnglish,
          meaning: entry.plainChinese,
          synonym,
          validation_error: lastError?.message || '',
          partial_draft: lastRaw && typeof lastRaw === 'object'
            ? {
                synonym: String(lastRaw.synonym || lastRaw.synonyms || '').trim(),
                synonym_original: String(
                  lastRaw.synonym_original
                  || lastRaw.original_sentence
                  || lastRaw.source_sentence
                  || '',
                ).trim(),
                synonym_rewrite_full: String(
                  lastRaw.synonym_rewrite_full
                  || lastRaw.rewrite_full
                  || lastRaw.rewrite_sentence
                  || '',
                ).trim(),
                synonym_rewrite_blank: String(
                  lastRaw.synonym_rewrite_blank
                  || lastRaw.rewrite_blank
                  || lastRaw.blank_rewrite
                  || '',
                ).trim(),
              }
            : {},
        }),
      },
    ],
    temperature: 0,
    max_tokens: 640,
  }
  try {
    const repaired = await fetchLlmObject(payload, 'LLM 同义替换 doctor', llmOptions)
    if (!repaired || typeof repaired !== 'object') return null
    return {
      ...(lastRaw && typeof lastRaw === 'object' ? lastRaw : {}),
      ...repaired,
      id: entry.key,
      synonym,
      synonym_original: String(
        repaired.synonym_original
        || repaired.original_sentence
        || repaired.source_sentence
        || '',
      ).trim(),
      synonym_rewrite_full: String(
        repaired.synonym_rewrite_full
        || repaired.rewrite_full
        || repaired.rewrite_sentence
        || repaired.rewritten_sentence
        || '',
      ).trim(),
      synonym_rewrite_blank: String(
        repaired.synonym_rewrite_blank
        || repaired.rewrite_blank
        || repaired.blank_rewrite
        || '',
      ).trim(),
    }
  } catch {
    return null
  }
}

const sanitizeLexical = (raw, entry) => {
  if (!raw || typeof raw !== 'object') throw new Error('词汇结果为空')
  const definitionEn = String(raw.definition_en || raw.definitionEn || raw.definition || raw.meaning_en || '').trim().replace(/\s+/g, ' ')
  const definitionZh = String(raw.definition_zh || raw.definitionZh || raw.meaning_zh || '').trim().replace(/\s+/g, ' ')
  if (!definitionEn) throw new Error('缺少 definition_en')
  if (!definitionZh) throw new Error('缺少 definition_zh')
  const normalizedHeadword = cleanWord(entry.displayEnglish)
  const shouldRejectDefinitionEcho = lettersOnly(normalizedHeadword).length >= 3
    && !BAD_SENTENCE_HEADWORDS.has(normalizedHeadword)
    && !SENTENCE_STOPWORDS.has(normalizedHeadword)
  if (shouldRejectDefinitionEcho && containsWholeWord(definitionEn, entry.displayEnglish)) {
    throw new Error('definition_en 不能重复目标词')
  }
  const synonym = normalizeRelationTerm(raw.synonym || raw.synonyms || raw.similar_word || '')
  const antonym = normalizeRelationTerm(raw.antonym || raw.antonyms || raw.opposite_word || '')
  return {
    definitionEn,
    definitionZh,
    synonym: synonym && !isMorphVariant(synonym, entry.displayEnglish) ? synonym : '',
    antonym: antonym && !isMorphVariant(antonym, entry.displayEnglish) ? antonym : '',
  }
}

const sanitizeMaterial = (raw, entry, lexical, requireSynonym) => {
  if (!raw || typeof raw !== 'object') throw new Error('题面结果为空')
  if (requireSynonym) {
    const synonym = normalizeRelationTerm(
      raw.synonym
      || raw.synonyms
      || raw.similar_word
      || raw.answer_synonym
      || lexical?.synonym
      || '',
    )
    const synonymOriginal = String(
      raw.synonym_original
      || raw.original_sentence
      || raw.source_sentence
      || raw.original_full_sentence
      || raw.source_full_sentence
      || raw.sentence_with_word
      || '',
    ).trim()
    const rewriteFull = String(
      raw.synonym_rewrite_full
      || raw.rewrite_full
      || raw.rewrite_sentence
      || raw.rewritten_sentence
      || raw.target_sentence
      || raw.sentence_with_synonym
      || '',
    ).trim()
    const rewriteBlankSource = normalizeBlankMarkers(
      raw.synonym_rewrite_blank
      || raw.rewrite_blank
      || raw.blank_rewrite
      || '',
    ).trim()
    const synonymRewriteBlank = countBlankSlots(rewriteBlankSource) === 1
      && !containsWholeWord(rewriteBlankSource, synonym)
      ? rewriteBlankSource
      : replaceAnswerWithBlank(rewriteFull, synonym)
    if (!synonym) throw new Error('同义替换缺少 synonym')
    if (!synonymOriginal) throw new Error('同义替换缺少 synonym_original')
    if (!rewriteFull && countBlankSlots(rewriteBlankSource) !== 1) throw new Error('同义替换缺少 synonym_rewrite_full')
    if (!synonymRewriteBlank) throw new Error('同义替换空格替换失败')
    if (countBlankSlots(synonymRewriteBlank) !== 1) throw new Error('同义替换空格数量不正确')
    return {
      synonym,
      synonymOriginal,
      synonymRewriteBlank,
    }
  }

  const clozeFullSentence = String(raw.cloze_full_sentence || raw.cloze_sentence_full || raw.full_sentence || '').trim()
  const clozeBlankSource = normalizeBlankMarkers(raw.cloze_sentence || raw.cloze_blank || raw.blank_sentence || '').trim()
  const tfTrue = String(raw.tf_true || raw.true_sentence || raw.trueStatement || '').trim()
  const tfFalse = String(raw.tf_false || raw.false_sentence || raw.falseStatement || '').trim()
  const clozeSentence = buildClozeSentence({
    blankSentence: clozeBlankSource,
    fullSentence: clozeFullSentence,
    fallbackSentences: [tfTrue, tfFalse],
  }, entry.displayEnglish)
  if (!tfTrue) throw new Error('基础题面缺少 tf_true')
  if (!tfFalse) throw new Error('基础题面缺少 tf_false')
  if (!clozeFullSentence && countBlankSlots(clozeBlankSource) !== 1) throw new Error('基础题面缺少 cloze_full_sentence')
  if (!clozeSentence) throw new Error('cloze 替换失败')
  if (countBlankSlots(clozeSentence) !== 1) throw new Error('cloze 替换失败')
  return { clozeSentence, tfTrue, tfFalse }
}

const runWithConcurrency = async (items, concurrency, worker) => {
  const results = new Array(items.length)
  let cursor = 0
  let firstError = null
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length && !firstError) {
      const index = cursor
      cursor += 1
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        firstError ||= error
      }
    }
  })
  await Promise.all(workers)
  if (firstError) throw firstError
  return results
}

const formatEntryLabel = (entry) => entry.displayEnglish || entry.english || entry.key || 'unknown'

const createLlmResolutionError = (kind, unresolved) => {
  const samples = (unresolved || [])
    .slice(0, 5)
    .map(({ entry, error }) => `${formatEntryLabel(entry)}: ${error?.message || '返回内容缺字段或格式不合法'}`)
    .join('；')
  const error = new Error(`${kind} 有 ${unresolved.length} 条未能通过校验，已停止生成。示例：${samples}`)
  error.code = 'LLM_GENERATION_INCOMPLETE'
  return error
}

const resolveResponseItems = async (entries, responseItems, sanitizeEntry, onResolved) => {
  const responseId = (item) => String(
    item?.id
    ?? item?.ID
    ?? item?.key
    ?? item?.input_id
    ?? item?.inputId
    ?? '',
  ).trim()
  const inputKeys = new Set(entries.map((entry) => entry.key))
  const byId = new Map()
  responseItems.forEach((item) => {
    if (!item || typeof item !== 'object') return
    const id = responseId(item)
    if (!id) return
    if (!byId.has(id)) byId.set(id, item)
  })
  const canFallbackByIndex = responseItems.length === entries.length
  const unresolved = []
  let resolvedCount = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const indexedItem = canFallbackByIndex ? responseItems[index] : null
    const indexedId = responseId(indexedItem)
    const fallbackByIndex = indexedItem && (!indexedId || !inputKeys.has(indexedId)) ? indexedItem : null
    const raw = byId.get(entry.key) || fallbackByIndex || null
    try {
      const didResolve = await onResolved(entry, sanitizeEntry(raw, entry))
      if (didResolve !== false) resolvedCount += 1
    } catch (error) {
      unresolved.push({ entry, error })
    }
  }
  return { unresolved, resolvedCount }
}

const tryModelForSingleEntry = async ({
  entry,
  callLlm,
  sanitizeEntry,
  onResolved,
  onTick,
  repairLlm,
  doctorLlm,
}) => {
  const { singleItemRetries } = getLlmRetryPolicy()
  let lastError = null
  let lastRaw = null
  for (let attempt = 0; attempt < singleItemRetries; attempt += 1) {
    try {
      await onTick?.()
      const responseItems = await callLlm([entry])
      lastRaw = Array.isArray(responseItems) ? (responseItems[0] ?? null) : null
      const { unresolved, resolvedCount } = await resolveResponseItems([entry], responseItems, sanitizeEntry, onResolved)
      if (!unresolved.length) return { success: true, resolvedCount, lastRaw, lastError: null }
      lastError = unresolved[0]?.error || new Error('返回内容缺字段或格式不合法')
    } catch (error) {
      lastError = error
      if (['LLM_RATE_LIMITED', 'LLM_REQUEST_FAILED'].includes(error?.code)) break
    }
    if (attempt < singleItemRetries - 1) await sleep(250 * (attempt + 1))
  }
  if (['LLM_RATE_LIMITED', 'LLM_REQUEST_FAILED'].includes(lastError?.code)) {
    return { success: false, resolvedCount: 0, lastRaw, lastError }
  }
  if (typeof repairLlm === 'function' && lastRaw) {
    try {
      const repairedRaw = await repairLlm(entry, lastRaw)
      if (repairedRaw) {
        const { unresolved, resolvedCount } = await resolveResponseItems([entry], [repairedRaw], sanitizeEntry, onResolved)
        if (!unresolved.length) return { success: true, resolvedCount, lastRaw: repairedRaw, lastError: null }
        lastError = unresolved[0]?.error || lastError
        lastRaw = repairedRaw
      }
    } catch { /* repair is best-effort */ }
  }
  if (typeof doctorLlm === 'function') {
    try {
      const doctoredRaw = await doctorLlm(entry, lastRaw, lastError)
      if (doctoredRaw) {
        const { unresolved, resolvedCount } = await resolveResponseItems([entry], [doctoredRaw], sanitizeEntry, onResolved)
        if (!unresolved.length) return { success: true, resolvedCount, lastRaw: doctoredRaw, lastError: null }
        lastError = unresolved[0]?.error || lastError
      }
    } catch { /* doctor is best-effort */ }
  }
  return { success: false, resolvedCount: 0, lastRaw, lastError }
}

const resolveSingleEntryStrict = async ({
  entry,
  kind,
  callLlm,
  sanitizeEntry,
  onResolved,
  onTick,
  repairLlm,
  doctorLlm,
  fallbackModels = [],
  makeLlmClosures,
}) => {
  let result = await tryModelForSingleEntry({
    entry, callLlm, sanitizeEntry, onResolved, onTick, repairLlm, doctorLlm,
  })
  if (result.success) return { resolvedCount: result.resolvedCount }

  if (['LLM_RATE_LIMITED', 'LLM_REQUEST_FAILED'].includes(result.lastError?.code)) {
    result.lastError.failedEntry = entry.displayEnglish || entry.english || entry.key || ''
    throw result.lastError
  }

  let lastError = result.lastError
  let lastRaw = result.lastRaw

  if (typeof makeLlmClosures === 'function') {
    for (const fallbackModel of fallbackModels.slice(0, 1)) {
      try {
        const closures = makeLlmClosures(fallbackModel)
        if (!closures?.callLlm) continue
        result = await tryModelForSingleEntry({
          entry,
          callLlm: closures.callLlm,
          sanitizeEntry,
          onResolved,
          onTick,
          repairLlm: closures.repairLlm,
          doctorLlm: closures.doctorLlm,
        })
        if (result.success) return { resolvedCount: result.resolvedCount }
        lastError = result.lastError || lastError
        lastRaw = result.lastRaw || lastRaw
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error || 'fallback 模型失败'))
      }
    }
  }

  if (lastError?.code === 'LLM_RATE_LIMITED') {
    lastError.failedEntry = entry.displayEnglish || entry.english || entry.key || ''
    throw lastError
  }
  if (lastError?.code === 'LLM_REQUEST_FAILED') {
    lastError.failedEntry = entry.displayEnglish || entry.english || entry.key || ''
    throw lastError
  }
  throw createLlmResolutionError(kind, [{ entry, error: lastError }])
}

const resolveLlmEntries = async ({
  entries,
  batchSize,
  concurrency,
  kind,
  callLlm,
  sanitizeEntry,
  onResolved,
  onProgress,
  onTick,
  repairLlm,
  doctorLlm,
  fallbackModels = [],
  makeLlmClosures,
}) => {
  const uniqueEntries = dedupeEntriesByKey(entries)
  const totalEntries = uniqueEntries.length
  if (!totalEntries) return 0
  let resolvedTotal = 0
  const batches = chunkGroups(uniqueEntries, batchSize)
  const batchResults = await runWithConcurrency(batches, concurrency, async (batch, batchIndex) => {
    let pending = batch
    let subBatchSize = batch.length
    let guard = 0

    while (pending.length > 1 && subBatchSize > 1 && guard < 12) {
      guard += 1
      const unresolved = []
      const chunks = chunkGroups(pending, subBatchSize)
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex]
        try {
          await onTick?.()
          let responseItems
          try {
            responseItems = await callLlm(chunk)
          } catch (error) {
            // Model rotation is handled by the durable queue so every retry is
            // checkpointed and visible instead of cycling models inside a step.
            throw error
          }
          const { unresolved: chunkUnresolved, resolvedCount } = await resolveResponseItems(chunk, responseItems, sanitizeEntry, onResolved)
          resolvedTotal += resolvedCount
          if (resolvedCount) await onProgress?.(resolvedTotal, totalEntries)
          if (!resolvedCount && chunk.length > 1) {
            const batchError = createLlmResolutionError(kind, chunkUnresolved)
            batchError.code = 'LLM_BATCH_REJECTED'
            batchError.batchSize = chunk.length
            throw batchError
          }
          unresolved.push(...chunkUnresolved.map((item) => item.entry))
        } catch (error) {
          if (error?.code === 'LLM_RATE_LIMITED') {
            error.failedEntries = chunk.map((entry) => entry.displayEnglish || entry.english || entry.key || '')
            throw error
          }
          if (error?.code === 'LLM_REQUEST_FAILED') throw error
          if (error?.code === 'LLM_BATCH_REJECTED') throw error
          unresolved.push(...chunk)
        }
      }
      pending = dedupeEntriesByKey(unresolved)
      if (!pending.length) return []
      const ceiling = Math.min(subBatchSize, pending.length)
      subBatchSize = ceiling > 1 ? Math.max(1, Math.floor(ceiling / 2)) : 1
    }

    if (!pending.length) return []
    const singleResults = await runWithConcurrency(
      pending,
      Math.min(3, pending.length),
      async (entry) => {
        try {
          return {
            entry,
            value: await resolveSingleEntryStrict({
              entry,
              kind,
              callLlm,
              sanitizeEntry,
              onResolved,
              onTick,
              repairLlm,
              doctorLlm,
              fallbackModels,
              makeLlmClosures,
            }),
          }
        } catch (error) {
          return {
            entry,
            error: error instanceof Error ? error : new Error(String(error || 'LLM 生成失败')),
          }
        }
      },
    )
    const unresolvedSingles = []
    for (const result of singleResults) {
      if (result?.error) {
        if (['LLM_RATE_LIMITED', 'LLM_REQUEST_FAILED'].includes(result.error.code)) throw result.error
        unresolvedSingles.push({ entry: result.entry, error: result.error })
        continue
      }
      resolvedTotal += result?.value?.resolvedCount || 0
      if (result?.value?.resolvedCount) await onProgress?.(resolvedTotal, totalEntries)
    }
    return unresolvedSingles
  })
  const unresolved = batchResults.flat().filter(Boolean)
  if (unresolved.length) throw createLlmResolutionError(kind, unresolved)
  return resolvedTotal
}

const ensureLexicalData = async (entries, context) => {
  const uniqueEntries = dedupeEntriesByKey(entries)
  const uncachedEntries = uniqueEntries.filter((entry) => !context.lexicalCache.get(entry.key)?.definitionZh)
  const cachedCount = uniqueEntries.length - uncachedEntries.length
  if (!uncachedEntries.length) return true
  const { batchSize, concurrency } = getLlmConfig({
    model: context.llmModel,
    batchSize: context.llmBatchSize,
    concurrency: context.llmConcurrency,
  })
  const stepEntries = uncachedEntries.slice(0, context.llmEntryLimit)
  const resolvedKeys = new Set()
  let lastCheckpointCount = 0
  const stageLabel = '预热 LLM 词汇关系'
  try {
    await resolveLlmEntries({
      entries: stepEntries,
      batchSize,
      concurrency,
      kind: 'LLM 词汇',
      callLlm: (batch) => callLlmForLexical(batch, { model: context.llmModel }),
      sanitizeEntry: sanitizeLexical,
      onResolved: async (entry, value) => {
        const isNew = !resolvedKeys.has(entry.key)
        if (isNew) resolvedKeys.add(entry.key)
        context.lexicalCache.set(entry.key, value)
        return isNew
      },
      onProgress: async (resolvedCount) => {
        const completedCount = cachedCount + resolvedCount
        await context.reportProgress({
          message: `[${context.exportName}] ${stageLabel} ${completedCount}/${uniqueEntries.length}`,
          currentStep: stageLabel,
          stageLabel,
          stageWordCompleted: completedCount,
          stageWordTotal: uniqueEntries.length,
          totalWords: context.wordCount,
          inProgressSteps: completedCount / uniqueEntries.length,
          inProgressStepKeys: ['warmup:lexical'],
        })
        if (context.onCacheCheckpoint && resolvedCount - lastCheckpointCount >= batchSize) {
          await context.onCacheCheckpoint()
          lastCheckpointCount = resolvedCount
        }
      },
      onTick: context.checkForCancellation,
      fallbackModels: context.llmFallbackModels || [],
      makeLlmClosures: (model) => ({
        callLlm: (batch) => callLlmForLexical(batch, { model }),
      }),
    })
  } catch (error) {
    if (context.onCacheCheckpoint) await context.onCacheCheckpoint()
    throw error
  }
  if (context.onCacheCheckpoint) await context.onCacheCheckpoint()
  return stepEntries.length === uncachedEntries.length
}

const ensureMaterials = async (entries, context, requireSynonym) => {
  const cache = requireSynonym ? context.synonymMaterialCache : context.basicMaterialCache
  const lexicalCache = context.lexicalCache
  const uniqueEntries = dedupeEntriesByKey(entries)
  const uncachedEntries = uniqueEntries.filter((entry) => !cache.has(entry.key)).map((entry) => ({
    ...entry,
    requiredSynonym: lexicalCache.get(entry.key)?.synonym || '',
  }))
  const cachedCount = uniqueEntries.length - uncachedEntries.length
  if (!uncachedEntries.length) return true
  const { batchSize, concurrency } = getLlmConfig({
    model: context.llmModel,
    batchSize: context.llmBatchSize,
    concurrency: context.llmConcurrency,
  })
  const stepEntries = uncachedEntries.slice(0, context.llmEntryLimit)
  const resolvedKeys = new Set()
  let lastCheckpointCount = 0
  const stageLabel = requireSynonym ? '预热 LLM 同义替换题面材料' : '预热 LLM 基础题面材料'
  try {
    await resolveLlmEntries({
      entries: stepEntries,
      batchSize,
      concurrency,
      kind: requireSynonym ? 'LLM 同义替换题面' : 'LLM 基础题面',
      callLlm: (batch) => callLlmForMaterials(batch, requireSynonym, { model: context.llmModel }),
      sanitizeEntry: (raw, entry) => sanitizeMaterial(raw, entry, lexicalCache.get(entry.key), requireSynonym),
      onResolved: async (entry, value) => {
        const isNew = !resolvedKeys.has(entry.key)
        if (isNew) resolvedKeys.add(entry.key)
        cache.set(entry.key, value)
        return isNew
      },
      onProgress: async (resolvedCount) => {
        const completedCount = cachedCount + resolvedCount
        await context.reportProgress({
          message: `[${context.exportName}] ${stageLabel} ${completedCount}/${uniqueEntries.length}`,
          currentStep: stageLabel,
          stageLabel,
          stageWordCompleted: completedCount,
          stageWordTotal: uniqueEntries.length,
          totalWords: context.wordCount,
          inProgressSteps: completedCount / uniqueEntries.length,
          inProgressStepKeys: requireSynonym ? ['warmup:synonym'] : ['warmup:basic'],
        })
        if (context.onCacheCheckpoint && resolvedCount - lastCheckpointCount >= batchSize) {
          await context.onCacheCheckpoint()
          lastCheckpointCount = resolvedCount
        }
      },
      onTick: context.checkForCancellation,
      repairLlm: requireSynonym
        ? (entry, lastRaw) => callLlmForSynonymRepair(entry, lastRaw, { model: context.llmModel })
        : null,
      doctorLlm: requireSynonym
        ? (entry, lastRaw, lastError) => callLlmForSynonymDoctor(
          entry,
          lexicalCache.get(entry.key),
          lastRaw,
          lastError,
          { model: context.llmModel },
        )
        : null,
      fallbackModels: context.llmFallbackModels || [],
      makeLlmClosures: (model) => ({
        callLlm: (batch) => callLlmForMaterials(batch, requireSynonym, { model }),
        repairLlm: requireSynonym
          ? (entry, lastRaw) => callLlmForSynonymRepair(entry, lastRaw, { model })
          : null,
        doctorLlm: requireSynonym
          ? (entry, lastRaw, lastError) => callLlmForSynonymDoctor(
            entry,
            lexicalCache.get(entry.key),
            lastRaw,
            lastError,
            { model },
          )
          : null,
      }),
    })
  } catch (error) {
    if (context.onCacheCheckpoint) await context.onCacheCheckpoint()
    throw error
  }
  if (context.onCacheCheckpoint) await context.onCacheCheckpoint()
  return stepEntries.length === uncachedEntries.length
}

const chooseSynonymWords = (group, context, count = context.questionsPerGroup || 30) => {
  const compatible = group.filter((entry) => isSentenceCompatibleWord(entry.english))
  const words = compatible.length ? compatible : group
  const withSynonym = words.filter((entry) => context.lexicalCache.get(entry.key)?.synonym)
  if (withSynonym.length >= count) return sample(withSynonym, count, context.rng)
  if (!withSynonym.length) return []
  const chosen = [...withSynonym]
  while (chosen.length < Math.min(words.length, count)) chosen.push(withSynonym[chosen.length % withSynonym.length])
  return shuffle(chosen, context.rng).slice(0, Math.min(count, chosen.length))
}

const chooseSynonymWordsByCount = (group, context, count) => {
  const compatible = group.filter((entry) => isSentenceCompatibleWord(entry.english))
  const words = compatible.length ? compatible : group
  const withSynonym = words.filter((entry) => context.lexicalCache.get(entry.key)?.synonym)
  if (!withSynonym.length) return []
  const target = Math.min(count, Math.max(1, withSynonym.length))
  if (withSynonym.length >= target) return sample(withSynonym, target, context.rng)
  const chosen = [...withSynonym]
  while (chosen.length < Math.min(words.length, count)) chosen.push(withSynonym[chosen.length % withSynonym.length])
  return shuffle(chosen, context.rng).slice(0, Math.min(count, chosen.length))
}

const buildBasicChoicePlan = (groups, context) => {
  const plan = new Map()
  const basicEntries = []
  groups.forEach((group, groupIndex) => {
    const compatible = group.filter((entry) => isSentenceCompatibleWord(entry.english))
    const words = compatible.length ? compatible : group
    const multipleChoice = sample(words, Math.min(context.questionsPerGroup, words.length), context.rng)
    plan.set(`二_选择题:${groupIndex}`, multipleChoice)
    basicEntries.push(...multipleChoice)

    const trueFalse = sample(words, Math.min(context.questionsPerGroup, words.length), context.rng)
    plan.set(`九_判断正误:${groupIndex}`, trueFalse)
    basicEntries.push(...trueFalse)
  })
  return { plan, basicEntries }
}

const buildSynonymChoicePlan = (groups, context) => {
  const plan = new Map()
  const synonymEntries = []
  groups.forEach((group, groupIndex) => {
    const synonym = chooseSynonymWords(group, context, context.questionsPerGroup)
    plan.set(`三_同义替换:${groupIndex}`, synonym)
    synonymEntries.push(...synonym)
  })
  return { plan, synonymEntries }
}

const buildTestPaperBasicChoicePlan = (groups, context) => {
  const plan = new Map()
  const basicEntries = []
  groups.forEach((group, groupIndex) => {
    const compatible = group.filter((entry) => isSentenceCompatibleWord(entry.english))
    const words = compatible.length ? compatible : group
    const multipleChoice = fillToCount(words, 10, context.rng)
    const trueFalse = fillToCount(words, 10, context.rng)
    plan.set(`二_选择题:${groupIndex}`, multipleChoice)
    plan.set(`九_判断正误:${groupIndex}`, trueFalse)
    basicEntries.push(...multipleChoice, ...trueFalse)
  })
  return { plan, basicEntries }
}

const buildTestPaperSynonymChoicePlan = (groups, context) => {
  const plan = new Map()
  const synonymEntries = []
  groups.forEach((group, groupIndex) => {
    const synonym = fillToCount(chooseSynonymWordsByCount(group, context, 10), 10, context.rng)
    plan.set(`三_同义替换:${groupIndex}`, synonym)
    synonymEntries.push(...synonym)
  })
  return { plan, synonymEntries }
}

const buildTestPaperLexicalCandidates = (fixedGroupSets, context) => {
  const candidates = []
  fixedGroupSets.forEach((groupSet) => {
    groupSet.groups.forEach((group, groupIndex) => {
      const candidateCount = Math.min(group.length, 60)
      const rng = createSeededRng(`${context.rngSeed}|${groupSet.label}|${groupIndex}|lexical-candidates`)
      candidates.push(...sample(group, candidateCount, rng))
    })
  })
  return dedupeEntriesByKey(candidates)
}

const paragraph = (text, options = {}) => ({
  text,
  bold: options.bold || false,
  size: options.size || 12,
  font: options.font || '',
  eastAsiaFont: options.eastAsiaFont || '',
  tabs: options.tabs || [],
  align: options.align || 'left',
  spaceBefore: options.spaceBefore || 0,
  spaceAfter: options.spaceAfter || 0,
  pageBreakBefore: options.pageBreakBefore || false,
  columnBreakBefore: options.columnBreakBefore || false,
  keepNext: options.keepNext || false,
  keepLines: options.keepLines || false,
  indentLeft: options.indentLeft || 0,
  lineSpacing: options.lineSpacing || 0,
})

const table = (rows, options = {}) => ({
  kind: 'table',
  rows,
  columnWidths: options.columnWidths || [],
  cantSplit: options.cantSplit || false,
  fixedLayout: options.fixedLayout || false,
  cellMargins: options.cellMargins || {},
})

const DOCX_PAGE_WIDTH_TWIPS = 11906
const DOCX_PAGE_HEIGHT_TWIPS = 16838
const DOCX_HORIZONTAL_MARGIN_TWIPS = 1440
const DOCX_CONTENT_WIDTH_TWIPS = DOCX_PAGE_WIDTH_TWIPS - DOCX_HORIZONTAL_MARGIN_TWIPS * 2
const DOCX_CONTENT_WIDTH_PT = DOCX_CONTENT_WIDTH_TWIPS / 20
const LEGACY_TWO_COLUMN_SPACING_PT = 18
const LEGACY_COLUMN_WIDTH_PT = (
  DOCX_CONTENT_WIDTH_TWIPS - LEGACY_TWO_COLUMN_SPACING_PT * 20
) / 2 / 20
// 前三道选择题（一_释义匹配 / 二_选择题 / 三_同义替换）统一使用窄页边距
// （左右各 36pt），在保持两栏不变的前提下把每栏可用宽度撑到最大，
// 让 A、B、C、D 四个选项尽量挤在同一行，减少整题跨页。
const OPTION_TWO_COLUMN_SPACING_PT = 36
const OPTION_NARROW_MARGIN_TWIPS = 720
const OPTION_COLUMN_WIDTH_PT = (
  DOCX_PAGE_WIDTH_TWIPS
  - OPTION_NARROW_MARGIN_TWIPS * 2
  - OPTION_TWO_COLUMN_SPACING_PT * 20
) / 2 / 20
const OPTION_INDENT_PT = 8
const OPTION_GAP_PT = 7
// 四选项单行最小字号：真实单词（≤10 字符）通常 7.5-11pt 即可一行；
// 更长的选项会退化为 A、B / C、D 两行并保持 12pt，避免字号过小影响可读性。
const OPTION_MIN_SIZE_PT = 7.5
const ARCHIVE_PAGE_WIDTH_TWIPS = 12240
const ARCHIVE_PAGE_HEIGHT_TWIPS = 15840
const ARCHIVE_MARGIN_TWIPS = 720
const ARCHIVE_COLUMN_SPACING_PT = 36
// 三_同义替换也使用左右 720twips 窄边距，栏宽与四/五/九一致。
const ARCHIVE_SYNONYM_COLUMN_WIDTH_PT = (
  ARCHIVE_PAGE_WIDTH_TWIPS
  - ARCHIVE_MARGIN_TWIPS * 2
  - ARCHIVE_COLUMN_SPACING_PT * 20
) / 2 / 20
const ARCHIVE_LAYOUT_QUESTION_KEYS = new Set([
  '三_同义替换',
  '四_乱序拼写',
  '五_缺字母填空',
  '九_判断正误',
])
const MATCHING_LAYOUT_QUESTION_KEYS = new Set([
  '七_同义词匹配',
  '八_反义词匹配',
])
const COMPACT_GROUP_BLOCK_QUESTION_KEYS = new Set([
  '四_乱序拼写',
  '五_缺字母填空',
  '九_判断正误',
])
const MATCHING_PAGE_WIDTH_TWIPS = 12240
const MATCHING_PAGE_HEIGHT_TWIPS = 15840
const MATCHING_HORIZONTAL_MARGIN_TWIPS = 1800
const MATCHING_VERTICAL_MARGIN_TWIPS = 1440
const MATCHING_COLUMN_SPACING_PT = 36
const MATCHING_COLUMN_WIDTH_PT = (
  MATCHING_PAGE_WIDTH_TWIPS
  - MATCHING_HORIZONTAL_MARGIN_TWIPS * 2
  - MATCHING_COLUMN_SPACING_PT * 20
) / 2 / 20
const MATCHING_RIGHT_TAB_PT = 126

const estimateTextWidthPt = (text, sizePt) => {
  return String(text ?? '').split('').reduce((sum, ch) => {
    if (/[\u4e00-\u9fff]/.test(ch)) return sum + sizePt
    if (/[ilI1'`.,:;!| ]/.test(ch)) return sum + sizePt * 0.28
    if (/[mwMW@%&]/.test(ch)) return sum + sizePt * 0.78
    return sum + sizePt * 0.52
  }, 0)
}

// 生成选项行段落：4 个选项一行放得下则单行；否则拆成 A、B / C、D 两行；
// 制表位在两行中保持一致，因此 A/C、B/D 始终上下对齐。
const buildOptionLines = (options, size = 12, columnWidth = LEGACY_COLUMN_WIDTH_PT) => {
  const labeledOptions = Array.from({ length: 4 }, (_, index) => (
    `${'ABCD'[index]}. ${String(options[index] || '').trim()}`
  ))
  const usableWidth = columnWidth - OPTION_INDENT_PT
  const oneLineWidths = labeledOptions.map((value) => estimateTextWidthPt(value, size))
  if (oneLineWidths.reduce((sum, width) => sum + width, 0) + OPTION_GAP_PT * 3 <= usableWidth) {
    const tabs = []
    let cursor = OPTION_INDENT_PT + oneLineWidths[0] + OPTION_GAP_PT
    for (let index = 1; index < labeledOptions.length; index += 1) {
      tabs.push(cursor)
      cursor += oneLineWidths[index] + OPTION_GAP_PT
    }
    return [paragraph(labeledOptions.join('\t'), {
      size,
      tabs,
      indentLeft: OPTION_INDENT_PT,
    })]
  }

  // 四选项一行放不下时，优先逐级缩小字号（最小 7.5pt）把 A、B、C、D 挤回同一行，
  // 允许行尾留空；仍然放不下才退化为 A、B / C、D 两行。
  let oneLineSize = size
  let oneLineFits = false
  while (oneLineSize >= OPTION_MIN_SIZE_PT) {
    const widths = labeledOptions.map((value) => estimateTextWidthPt(value, oneLineSize))
    if (widths.reduce((sum, width) => sum + width, 0) + OPTION_GAP_PT * 3 <= usableWidth) {
      oneLineFits = true
      break
    }
    oneLineSize -= 0.25
  }
  if (oneLineFits) {
    const oneLineWidthsAtSize = labeledOptions.map((value) => estimateTextWidthPt(value, oneLineSize))
    const tabs = []
    let cursor = OPTION_INDENT_PT + oneLineWidthsAtSize[0] + OPTION_GAP_PT
    for (let index = 1; index < labeledOptions.length; index += 1) {
      tabs.push(cursor)
      cursor += oneLineWidthsAtSize[index] + OPTION_GAP_PT
    }
    return [paragraph(labeledOptions.join('\t'), {
      size: oneLineSize,
      tabs,
      indentLeft: OPTION_INDENT_PT,
    })]
  }

  let actualSize = size
  let leftWidth = 0
  let rightWidth = 0
  while (actualSize > 7.5) {
    leftWidth = Math.max(
      estimateTextWidthPt(labeledOptions[0], actualSize),
      estimateTextWidthPt(labeledOptions[2], actualSize),
    )
    rightWidth = Math.max(
      estimateTextWidthPt(labeledOptions[1], actualSize),
      estimateTextWidthPt(labeledOptions[3], actualSize),
    )
    if (leftWidth + OPTION_GAP_PT + rightWidth <= usableWidth) break
    actualSize -= 0.5
  }
  leftWidth = Math.max(
    estimateTextWidthPt(labeledOptions[0], actualSize),
    estimateTextWidthPt(labeledOptions[2], actualSize),
  )
  rightWidth = Math.max(
    estimateTextWidthPt(labeledOptions[1], actualSize),
    estimateTextWidthPt(labeledOptions[3], actualSize),
  )
  const secondColumnStart = OPTION_INDENT_PT + leftWidth + OPTION_GAP_PT
  const lineOptions = { size: actualSize, tabs: [secondColumnStart], indentLeft: OPTION_INDENT_PT }
  return [
    paragraph(`${labeledOptions[0]}\t${labeledOptions[1]}`, lineOptions),
    paragraph(`${labeledOptions[2]}\t${labeledOptions[3]}`, lineOptions),
  ]
}

// 题干段 + 选项段用 keepNext 串链，保证同一道题的题目与选项在同一栏内不跨栏不跨页。
// middleLines: 题干与选项之间的补充行（如中文译文），同样参与 keepNext 串链。
// 题干超过一栏宽度时自动缩小字号（最小 8.5pt，保持可读），尽量减少整题被迫挪到下一页。
const pushQuestionWithOptions = (questionParagraphs, stemText, options, {
  size = 12,
  middleLines = [],
  columnWidth = LEGACY_COLUMN_WIDTH_PT,
  stemMinSize = 8.5,
} = {}) => {
  const stemUsableWidth = columnWidth - 4
  let stemSize = size
  while (stemSize >= stemMinSize) {
    if (estimateTextWidthPt(String(stemText ?? ''), stemSize) <= stemUsableWidth) break
    stemSize -= 0.25
  }
  const stem = paragraph(stemText, { size: stemSize, keepNext: true, keepLines: true })
  questionParagraphs.push(stem)
  middleLines.forEach((line) => {
    questionParagraphs.push(paragraph(line, {
      size: Math.min(size, stemSize),
      indentLeft: 12,
      keepNext: true,
      keepLines: true,
    }))
  })
  const optionLines = buildOptionLines(options, size, columnWidth)
  optionLines.forEach((line, index) => {
    questionParagraphs.push({
      ...line,
      keepNext: index < optionLines.length - 1,
      keepLines: true,
      spaceAfter: index === optionLines.length - 1 ? 3 : 0,
    })
  })
}

const answerLine = (answers) => answers.map(([num, value]) => `${num}.${value}`).join('\t')
const requireGeneratedValue = (value, message) => {
  if (!value) throw new Error(message)
  return value
}

const buildAnswerTable = (answers, perLine = 10) => {
  const answerTexts = answers.map(([num, value]) => `${num}.${value}`)
  const rows = []
  for (let index = 0; index < answerTexts.length; index += perLine) {
    rows.push(answerTexts.slice(index, index + perLine))
  }

  let fontSize = 10.5
  const calculateDesiredWidths = () => Array.from({ length: perLine }, (_, columnIndex) => {
    const longest = Math.max(0, ...rows.map((row) => estimateTextWidthPt(row[columnIndex] || '', fontSize)))
    return Math.max(20, longest + 5)
  })
  let desiredWidths = calculateDesiredWidths()
  while (fontSize > 6.5 && desiredWidths.reduce((sum, width) => sum + width, 0) > DOCX_CONTENT_WIDTH_PT) {
    fontSize -= 0.5
    desiredWidths = calculateDesiredWidths()
  }

  const desiredTotal = desiredWidths.reduce((sum, width) => sum + width, 0)
  const widthScale = Math.min(1, DOCX_CONTENT_WIDTH_PT / desiredTotal)
  const scaledWidths = desiredWidths.map((width) => width * widthScale)
  const spareWidth = Math.max(0, DOCX_CONTENT_WIDTH_PT - scaledWidths.reduce((sum, width) => sum + width, 0))
  const columnWidths = scaledWidths.map((width) => Math.round((width + spareWidth / perLine) * 20))
  columnWidths[columnWidths.length - 1] += DOCX_CONTENT_WIDTH_TWIPS - columnWidths.reduce((sum, width) => sum + width, 0)

  return table(rows.map((row) => Array.from({ length: perLine }, (_, columnIndex) => ({
    text: row[columnIndex] || '',
    size: fontSize,
    noWrap: true,
  }))), {
    columnWidths,
    cantSplit: true,
    fixedLayout: true,
    cellMargins: { top: 12, right: 16, bottom: 12, left: 16 },
  })
}

const writeAnswerBlock = (paragraphs, title, answers, perLine = 10) => {
  paragraphs.push(paragraph(title, {
    size: 14,
    bold: true,
    spaceBefore: 6,
    spaceAfter: 2,
    keepNext: true,
  }))
  paragraphs.push(buildAnswerTable(answers, perLine))
}

const groupRange = (groupIndex, group, groupSize = GROUP_SIZE) => {
  const start = groupIndex * groupSize + 1
  return [start, start + group.length - 1]
}

const generateMatching = (questionParagraphs, answerParagraphs, group, groupIndex, context) => {
  const lexical = context.lexicalCache
  const pool = group.filter((entry) => lexical.get(entry.key)?.definitionEn)
  if (!pool.length) throw new Error('释义匹配缺少可用的 LLM 释义结果。')
  const chosen = fillToCount(pool, context.questionsPerGroup, context.rng)
  questionParagraphs.push(paragraph('一. Matching Words with Definitions', {
    bold: true,
    size: 12,
    spaceBefore: 6,
    keepNext: true,
  }))
  questionParagraphs.push(paragraph('单词释义匹配题', {
    bold: true,
    size: 12,
    spaceAfter: 4,
    keepNext: true,
  }))
  questionParagraphs.push(paragraph('Match each definition with the correct word.', { keepNext: true }))
  questionParagraphs.push(paragraph('根据英文释义，从方框中选出正确单词。', { spaceAfter: 6 }))
  const answers = []
  chosen.forEach((entry, index) => {
    const distractors = uniqueDistractors(group, entry, 3, (item) => item.cleanEnglish, context.rng)
    const options = shuffle([...distractors.map((item) => item.displayEnglish), entry.displayEnglish], context.rng).slice(0, 4)
    const definition = requireGeneratedValue(lexical.get(entry.key)?.definitionEn, '释义匹配存在缺失的 definition_en。')
    const definitionZh = requireGeneratedValue(lexical.get(entry.key)?.definitionZh, '释义匹配存在缺失的 definition_zh。')
    pushQuestionWithOptions(questionParagraphs, `${index + 1}. ${definition}`, options, {
      size: 11,
      columnWidth: OPTION_COLUMN_WIDTH_PT,
      middleLines: context.withChineseTranslation && definitionZh ? [`（${definitionZh}）`] : [],
    })
    answers.push([index + 1, 'ABCD'[options.indexOf(entry.displayEnglish)] || 'A'])
  })
  writeAnswerBlock(answerParagraphs, `第${groupIndex + 1}组 一 释义匹配 答案`, answers)
}

const generateMultipleChoice = (questionParagraphs, answerParagraphs, group, groupIndex, context) => {
  const chosen = context.choicePlan.get(`二_选择题:${groupIndex}`) || sample(group, Math.min(context.questionsPerGroup, group.length), context.rng)
  questionParagraphs.push(paragraph('二. Multiple-Choice Questions 单词选择题', { bold: true, size: 12, spaceBefore: 6, spaceAfter: 4 }))
  questionParagraphs.push(paragraph('Choose the best word to complete each sentence. 选择最佳单词补全句子。', { spaceAfter: 6 }))
  const answers = []
  chosen.forEach((entry, index) => {
    const distractors = uniqueDistractors(group, entry, 3, (item) => item.cleanEnglish, context.rng)
    const options = shuffle([...distractors.map((item) => item.displayEnglish), entry.displayEnglish], context.rng).slice(0, 4)
    const material = context.basicMaterialCache.get(entry.key)
    const clozeSentence = requireGeneratedValue(material?.clozeSentence, '选择题缺少 LLM 题面材料。')
    pushQuestionWithOptions(questionParagraphs, `${index + 1}. ${clozeSentence}`, options, {
      columnWidth: OPTION_COLUMN_WIDTH_PT,
    })
    answers.push([index + 1, 'ABCD'[options.indexOf(entry.displayEnglish)] || 'A'])
  })
  writeAnswerBlock(answerParagraphs, `第${groupIndex + 1}组 二 选择题 答案`, answers)
}

const generateSynonymReplacement = (questionParagraphs, answerParagraphs, group, groupIndex, context) => {
  const chosen = context.choicePlan.get(`三_同义替换:${groupIndex}`) || chooseSynonymWords(group, context)
  if (!chosen.length) throw new Error('当前词表缺少可用的同义词结果，无法生成同义替换题。')
  questionParagraphs.push(paragraph('三. Synonym Replacement 同义替换', { bold: true, size: 12, spaceBefore: 6, spaceAfter: 4, keepNext: true }))
  questionParagraphs.push(paragraph('Replace the underlined word with its synonym. 用同义词替换句中画线单词。', { spaceAfter: 6, keepNext: true }))
  const answers = []
  chosen.forEach((entry, index) => {
    const material = context.synonymMaterialCache.get(entry.key) || {}
    const synonym = requireGeneratedValue(material.synonym, '同义替换缺少 LLM 同义词。')
    const distractors = uniqueDistractors(group, entry, 3, (item) => item.cleanEnglish, context.rng)
    const options = Array.from(new Set([...distractors.map((item) => item.displayEnglish), synonym]))
    while (options.length < 4) options.push(choice(group, context.rng).displayEnglish)
    const shuffled = shuffle(options.slice(0, 4), context.rng)
    const synonymOriginal = requireGeneratedValue(material.synonymOriginal, '同义替换缺少原句。')
    const synonymRewriteBlank = requireGeneratedValue(material.synonymRewriteBlank, '同义替换缺少改写句。')
    questionParagraphs.push(paragraph(`${index + 1}. ${synonymOriginal}`, { keepNext: true, keepLines: true }))
    pushQuestionWithOptions(questionParagraphs, synonymRewriteBlank, shuffled, {
      columnWidth: ARCHIVE_SYNONYM_COLUMN_WIDTH_PT,
    })
    answers.push([index + 1, 'ABCD'[shuffled.indexOf(synonym)] || 'A'])
  })
  writeAnswerBlock(answerParagraphs, `第${groupIndex + 1}组 三 同义替换 答案`, answers)
}

const generateScramble = (questionParagraphs, answerParagraphs, group, groupIndex, context) => {
  const pool = group.filter((entry) => {
    const core = spellingCore(entry.english)
    return core.length >= 4 && core.length <= 10
  })
  const chosen = fillToCount(pool, context.questionsPerGroup, context.rng)
  questionParagraphs.push(paragraph('四. Word Scramble 单词乱序拼写题', { bold: true, size: 12, keepNext: true }))
  questionParagraphs.push(paragraph('Rearrange the letters to form correct words. 重新排列字母，拼写出正确单词。', { keepNext: true }))
  const answers = []
  chosen.forEach((entry, index) => {
    const core = spellingCore(entry.english)
    let letters = core.split('')
    for (let attempt = 0; attempt < 10; attempt += 1) {
      letters = shuffle(letters, context.rng)
      if (letters.join('') !== core) break
    }
    const meaningSuffix = entry.plainChinese ? `  (${entry.plainChinese})` : ''
    questionParagraphs.push(paragraph(`${index + 1}. ${letters.join(' ')} → ____________${meaningSuffix}`, { keepLines: true }))
    answers.push([index + 1, entry.displayEnglish])
  })
  writeAnswerBlock(answerParagraphs, `第${groupIndex + 1}组 四 乱序拼写 答案`, answers)
}


const generateMissingLetters = (questionParagraphs, answerParagraphs, group, groupIndex, context) => {
  const pool = group.filter((entry) => {
    const core = spellingCore(entry.english)
    return core.length >= 5 && core.length <= 12
  })
  const chosen = fillToCount(pool, context.questionsPerGroup, context.rng)
  questionParagraphs.push(paragraph('五. Missing Letters 缺字母填空', { bold: true, size: 12, keepNext: true }))
  questionParagraphs.push(paragraph('Fill in the missing letters and write the full word. 补全所缺字母，并写出完整单词。', { keepNext: true }))
  const answers = []
  chosen.forEach((entry, index) => {
    const core = spellingCore(entry.english)
    const hideCount = Math.max(1, Math.floor(core.length / 3))
    const indices = sample(Array.from({ length: Math.max(0, core.length - 1) }, (_, offset) => offset + 1), hideCount, context.rng)
    const chars = core.split('')
    indices.forEach((pick) => { chars[pick] = '_' })
    const meaningSuffix = entry.plainChinese ? `  (${entry.plainChinese})` : ''
    questionParagraphs.push(paragraph(`${index + 1}. ${chars.join(' ')}${meaningSuffix}`, { keepLines: true }))
    answers.push([index + 1, entry.displayEnglish])
  })
  writeAnswerBlock(answerParagraphs, `第${groupIndex + 1}组 四 缺字母填空 答案`, answers)
}

const generateSynAntJudge = (questionParagraphs, answerParagraphs, group, groupIndex, context) => {
  questionParagraphs.push(paragraph('五. Synonym & Antonym 同义反义词辨析', { bold: true, size: 12, spaceBefore: 6, spaceAfter: 4 }))
  questionParagraphs.push(paragraph('Write S (synonym 同义) or A (antonym 反义) for each pair. 每组单词括号内填写S或A。', { spaceAfter: 6 }))
  const synPairs = []
  const antPairs = []
  group.forEach((entry) => {
    const lexical = context.lexicalCache.get(entry.key) || {}
    if (lexical.synonym) synPairs.push([entry.displayEnglish, lexical.synonym, 'S'])
    if (lexical.antonym) antPairs.push([entry.displayEnglish, lexical.antonym, 'A'])
  })
  if (!synPairs.length && !antPairs.length) throw new Error('同义反义辨析缺少可用的 LLM 词汇关系。')
  const antonymTarget = Math.round(context.questionsPerGroup * 0.4)
  let pairs = [...sample(antPairs, Math.min(antonymTarget, antPairs.length), context.rng), ...sample(synPairs, Math.min(context.questionsPerGroup - antonymTarget, synPairs.length), context.rng)]
  const rest = [...antPairs, ...synPairs].filter((pair) => !pairs.includes(pair))
  while (pairs.length < context.questionsPerGroup && rest.length) pairs.push(rest.shift())
  const origPairsLen = pairs.length
  while (origPairsLen && pairs.length < context.questionsPerGroup) pairs.push(pairs[pairs.length % origPairsLen])
  pairs = shuffle(pairs.slice(0, context.questionsPerGroup), context.rng)
  const answers = []
  pairs.forEach((pair, index) => {
    questionParagraphs.push(paragraph(`${index + 1}. ${pair[0]} & ${pair[1]} (    )`))
    answers.push([index + 1, pair[2]])
  })
  writeAnswerBlock(answerParagraphs, `第${groupIndex + 1}组 五 同义反义辨析 答案`, answers)
}

const buildMatchingParagraphBlock = (pairs, rightWords, { columnBreakBefore = false } = {}) => {
  let fontSize = 12
  while (fontSize > 8) {
    const leftFits = pairs.every((pair, index) => (
      estimateTextWidthPt(`${index + 1}. ${pair[0].displayEnglish}`, fontSize) <= MATCHING_RIGHT_TAB_PT - 6
    ))
    const rightFits = rightWords.every((word, index) => (
      estimateTextWidthPt(`${'abcde'[index]}. ${word}`, fontSize) <= MATCHING_COLUMN_WIDTH_PT - MATCHING_RIGHT_TAB_PT
    ))
    if (leftFits && rightFits) break
    fontSize -= 0.5
  }

  return [
    paragraph('', { columnBreakBefore, keepNext: true, keepLines: true, lineSpacing: 1 }),
    ...pairs.map((pair, index) => paragraph(
      `${index + 1}. ${pair[0].displayEnglish}\t${'abcde'[index]}. ${rightWords[index]}`,
      {
        size: fontSize,
        tabs: [MATCHING_RIGHT_TAB_PT],
        keepNext: index < pairs.length - 1,
        keepLines: true,
        lineSpacing: 1,
      },
    )),
  ]
}

const generateMatchBlocks = (questionParagraphs, answerParagraphs, group, groupIndex, context, relationKey, sectionTitle, answerTitle) => {
  if (groupIndex === 0) {
    questionParagraphs.push(paragraph(sectionTitle, { bold: true, size: 12, spaceBefore: 6, spaceAfter: 4, keepNext: true }))
    questionParagraphs.push(paragraph(relationKey === 'synonym'
      ? 'Match each word with its synonym on the right. 将左侧单词与右侧同义词连线匹配。'
      : 'Match each word with its antonym on the right. 将左侧单词与右侧反义词连线匹配。', { spaceAfter: 4, keepNext: true }))
  }
  const pairs = group
    .map((entry) => {
      const lexical = context.lexicalCache.get(entry.key) || {}
      const related = relationKey === 'synonym' ? lexical.synonym : lexical.antonym
      return related ? [entry, related] : null
    })
    .filter(Boolean)
  if (!pairs.length) throw new Error(relationKey === 'synonym' ? '同义词匹配缺少可用的 LLM 同义词结果。' : '反义词匹配缺少可用的 LLM 反义词结果。')
  let usedPairIndex = 0
  const answers = []
  let questionNumber = 0
  const blockCount = Math.ceil(context.questionsPerGroup / 5)
  const secondColumnBlockIndex = Math.ceil(blockCount / 2)
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const block = []
    const blockTarget = Math.min(5, context.questionsPerGroup - questionNumber)
    const usedLeft = new Set()
    const usedRight = new Set()
    let attempts = 0
    while (block.length < blockTarget && pairs.length && attempts < Math.max(80, pairs.length * 4)) {
      const pair = pairs[usedPairIndex % pairs.length]
      usedPairIndex += 1
      attempts += 1
      if (usedLeft.has(pair[0].cleanEnglish) || usedRight.has(pair[1])) continue
      block.push(pair)
      usedLeft.add(pair[0].cleanEnglish)
      usedRight.add(pair[1])
    }
    while (block.length < blockTarget && pairs.length) {
      const pair = pairs[usedPairIndex % pairs.length]
      usedPairIndex += 1
      block.push(pair)
    }
    if (!block.length) break
    const rightWords = shuffle(block.map((pair) => pair[1]), context.rng)
    questionParagraphs.push(...buildMatchingParagraphBlock(block, rightWords, {
      columnBreakBefore: blockIndex === secondColumnBlockIndex,
    }))
    block.forEach((pair, index) => {
      const letter = 'abcde'[rightWords.indexOf(pair[1])] || 'a'
      const displayNumber = questionNumber + index + 1
      answers.push([displayNumber, letter])
    })
    questionNumber += block.length
  }
  writeAnswerBlock(answerParagraphs, `第${groupIndex + 1}组 ${answerTitle} 答案`, answers)
}

const generateTrueFalse = (questionParagraphs, answerParagraphs, group, groupIndex, context) => {
  const chosen = context.choicePlan.get(`九_判断正误:${groupIndex}`) || sample(group, Math.min(context.questionsPerGroup, group.length), context.rng)
  questionParagraphs.push(paragraph('九. True or False 判断正误', { bold: true, size: 12, keepNext: true }))
  questionParagraphs.push(paragraph('Write T (true) or F (false) for each statement. 判断下列句子的正误，正确填T，错误填F。', { keepNext: true }))
  const answers = []
  chosen.forEach((entry, index) => {
    const material = context.basicMaterialCache.get(entry.key)
    const isTrue = context.rng() >= 0.5
    const tfTrue = requireGeneratedValue(material?.tfTrue, '判断正误缺少 LLM 正确句。')
    const tfFalse = requireGeneratedValue(material?.tfFalse, '判断正误缺少 LLM 错误句。')
    questionParagraphs.push(paragraph(`${index + 1}. (    ) ${isTrue ? tfTrue : tfFalse}`, { keepLines: true }))
    answers.push([index + 1, isTrue ? 'T' : 'F'])
  })
  writeAnswerBlock(answerParagraphs, `第${groupIndex + 1}组 八 判断正误 答案`, answers)
}

const createDocxParagraphs = (title) => [paragraph(title, { size: 16, bold: true, align: 'center', spaceAfter: 8 })]
const createAnswerParagraphs = (title) => [paragraph(title, { size: 18, bold: true, align: 'center', spaceAfter: 10 })]

const applyArchiveQuestionTypography = (questionKey, paragraphs) => {
  if (!ARCHIVE_LAYOUT_QUESTION_KEYS.has(questionKey)) return
  const compactNormal = questionKey === '五_缺字母填空'
  const compactBold = questionKey === '四_乱序拼写' || questionKey === '九_判断正误'

  paragraphs.forEach((block) => {
    if (!block || block.kind === 'table') return
    block.font = 'Times New Roman'
    block.eastAsiaFont = '宋体'
    block.spaceBefore = 0
    block.spaceAfter = 0
    block.lineSpacing = 1
    if (compactNormal || compactBold) {
      block.size = 12
      block.bold = compactBold
      block.align = 'left'
    }
  })

  if (paragraphs[0]) paragraphs[0].keepNext = true
}

const archiveQuestionDocxOptions = (questionKey) => {
  if (!ARCHIVE_LAYOUT_QUESTION_KEYS.has(questionKey)) return {}
  return {
    columns: 2,
    columnSpacing: ARCHIVE_COLUMN_SPACING_PT,
    pageWidthTwips: ARCHIVE_PAGE_WIDTH_TWIPS,
    pageHeightTwips: ARCHIVE_PAGE_HEIGHT_TWIPS,
    // 三_同义替换与四/五/九一样使用左右 720twips（36pt）窄边距，
    // 栏数保持两栏，每栏更宽，选项更容易挤在同一行。
    pageMarginsTwips: {
      top: ARCHIVE_MARGIN_TWIPS,
      right: ARCHIVE_MARGIN_TWIPS,
      bottom: ARCHIVE_MARGIN_TWIPS,
      left: ARCHIVE_MARGIN_TWIPS,
      header: ARCHIVE_MARGIN_TWIPS,
      footer: ARCHIVE_MARGIN_TWIPS,
    },
    defaultFont: 'Times New Roman',
    defaultEastAsiaFont: '宋体',
    defaultSize: 12,
  }
}

const matchingQuestionDocxOptions = (questionKey) => {
  if (!MATCHING_LAYOUT_QUESTION_KEYS.has(questionKey)) return {}
  return {
    columns: 2,
    columnSpacing: MATCHING_COLUMN_SPACING_PT,
    pageWidthTwips: MATCHING_PAGE_WIDTH_TWIPS,
    pageHeightTwips: MATCHING_PAGE_HEIGHT_TWIPS,
    pageMarginsTwips: {
      top: MATCHING_VERTICAL_MARGIN_TWIPS,
      right: MATCHING_HORIZONTAL_MARGIN_TWIPS,
      bottom: MATCHING_VERTICAL_MARGIN_TWIPS,
      left: MATCHING_HORIZONTAL_MARGIN_TWIPS,
      header: 720,
      footer: 720,
    },
    defaultFont: 'Times New Roman',
    defaultEastAsiaFont: 'Times New Roman',
    defaultSize: 12,
  }
}

const testPaperOptionLine = (options) => options.map((value, index) => `${'ABCD'[index]}. ${value}`).join('  ')
const testPaperRange = (groupIndex, group, groupSize = TEST_PAPER_GROUP_SIZE) => {
  const start = groupIndex * groupSize + 1
  return [start, start + group.length - 1]
}

const fillToCount = (items, count, rng) => {
  const source = (items || []).filter(Boolean)
  if (!source.length) return []
  const chosen = source.length >= count ? sample(source, count, rng) : [...source]
  while (chosen.length < count) chosen.push(source[chosen.length % source.length])
  return shuffle(chosen, rng).slice(0, count)
}

const buildTestPaperTitle = (start, end) => `英语词汇专项测试卷${start}-${end}`
const buildWordBankLine = (group) => `词汇库：${group.map((entry) => entry.displayEnglish).join(', ')}`

const addTestPaperAnswerSection = (paragraphs, answerGroups) => {
  paragraphs.push(paragraph('', { spaceAfter: 4 }))
  paragraphs.push(paragraph('参考答案', { bold: true, size: 14, spaceBefore: 8, spaceAfter: 4 }))
  answerGroups.forEach((group) => {
    paragraphs.push(paragraph(group.title, { bold: true, size: 12, spaceBefore: 4, spaceAfter: 2 }))
    group.lines.forEach((line) => {
      paragraphs.push(paragraph(line, { size: 11, spaceAfter: 1 }))
    })
  })
}

const generateTestPaperMatchingSection = (paragraphs, group, context, answersOut) => {
  const pool = group.filter((entry) => context.lexicalCache.get(entry.key)?.definitionEn)
  if (!pool.length) throw new Error('释义匹配缺少可用的 LLM 释义结果。')
  const chosen = fillToCount(pool, 10, context.rng)
  paragraphs.push(paragraph('一、Matching Words with Definitions 单词释义匹配（10题）', { bold: true, size: 12, spaceBefore: 6, spaceAfter: 3 }))
  paragraphs.push(paragraph('Choose the correct word for each definition. 根据英文释义选择正确的单词。', { size: 11, spaceAfter: 4 }))
  const answers = []
  chosen.forEach((entry, index) => {
    const distractors = uniqueDistractors(group, entry, 3, (item) => item.cleanEnglish, context.rng)
    const options = shuffle([...distractors.map((item) => item.displayEnglish), entry.displayEnglish], context.rng).slice(0, 4)
    const definition = requireGeneratedValue(context.lexicalCache.get(entry.key)?.definitionEn, '释义匹配存在缺失的 definition_en。')
    const definitionZh = requireGeneratedValue(context.lexicalCache.get(entry.key)?.definitionZh, '释义匹配存在缺失的 definition_zh。')
    const zhSuffix = context.withChineseTranslation && definitionZh ? ` (${definitionZh})` : ''
    paragraphs.push(paragraph(`(    ) ${index + 1}. ${definition}${zhSuffix}`, { size: 11, spaceAfter: 1 }))
    paragraphs.push(paragraph(testPaperOptionLine(options), { size: 11, spaceAfter: 2 }))
    answers.push(`${index + 1}.${'ABCD'[options.indexOf(entry.displayEnglish)] || 'A'}`)
  })
  answersOut.push({ title: '一、释义匹配', lines: [answers.join('  ')] })
}

const generateTestPaperMultipleChoiceSection = (paragraphs, group, groupIndex, context, answersOut) => {
  const chosen = context.choicePlan.get(`二_选择题:${groupIndex}`) || sample(group, Math.min(10, group.length), context.rng)
  paragraphs.push(paragraph('二、Multiple-Choice Questions 单项选择（10题）', { bold: true, size: 12, spaceBefore: 6, spaceAfter: 3 }))
  paragraphs.push(paragraph('Choose the best word to complete each sentence. 选择最佳单词补全句子。', { size: 11, spaceAfter: 4 }))
  const answers = []
  chosen.forEach((entry, index) => {
    const distractors = uniqueDistractors(group, entry, 3, (item) => item.cleanEnglish, context.rng)
    const options = shuffle([...distractors.map((item) => item.displayEnglish), entry.displayEnglish], context.rng).slice(0, 4)
    const material = context.basicMaterialCache.get(entry.key)
    const clozeSentence = requireGeneratedValue(material?.clozeSentence, '选择题缺少 LLM 题面材料。')
    paragraphs.push(paragraph(`${index + 1}. ${clozeSentence}`, { size: 11, spaceAfter: 1 }))
    paragraphs.push(paragraph(testPaperOptionLine(options), { size: 11, spaceAfter: 2 }))
    answers.push(`${index + 1}.${'ABCD'[options.indexOf(entry.displayEnglish)] || 'A'}`)
  })
  answersOut.push({ title: '二、单项选择', lines: [answers.join('  ')] })
}

const generateTestPaperSynonymReplacementSection = (paragraphs, groupIndex, context, answersOut) => {
  const chosen = context.choicePlan.get(`三_同义替换:${groupIndex}`) || []
  if (!chosen.length) throw new Error('当前词表缺少可用的同义词结果，无法生成同义替换题。')
  paragraphs.push(paragraph('三、Synonym Replacement 同义替换（10题）', { bold: true, size: 12, spaceBefore: 6, spaceAfter: 3 }))
  paragraphs.push(paragraph('Choose the word closest in meaning to the underlined word. 选择与画线单词意思最接近的单词。', { size: 11, spaceAfter: 4 }))
  const answers = []
  chosen.forEach((entry, index) => {
    const material = context.synonymMaterialCache.get(entry.key) || {}
    const synonym = requireGeneratedValue(material.synonym, '同义替换缺少 LLM 同义词。')
    const distractors = uniqueDistractors(chosen, entry, 3, (item) => item.cleanEnglish, context.rng)
    const optionPool = Array.from(new Set([...distractors.map((item) => item.displayEnglish), synonym]))
    while (optionPool.length < 4) optionPool.push(choice(chosen, context.rng).displayEnglish)
    const options = shuffle(optionPool.slice(0, 4), context.rng)
    const synonymOriginal = requireGeneratedValue(material.synonymOriginal, '同义替换缺少原句。')
    const synonymRewriteBlank = requireGeneratedValue(material.synonymRewriteBlank, '同义替换缺少改写句。')
    paragraphs.push(paragraph(`${index + 1}. ${synonymOriginal}`, { size: 11, spaceAfter: 1 }))
    paragraphs.push(paragraph(synonymRewriteBlank, { size: 11, spaceAfter: 1 }))
    paragraphs.push(paragraph(testPaperOptionLine(options), { size: 11, spaceAfter: 2 }))
    answers.push(`${index + 1}.${'ABCD'[options.indexOf(synonym)] || 'A'}`)
  })
  answersOut.push({ title: '三、同义替换', lines: [answers.join('  ')] })
}

const generateTestPaperMissingLettersSection = (paragraphs, group, context, answersOut) => {
  const pool = group.filter((entry) => {
    const core = spellingCore(entry.english)
    return core.length >= 4 && core.length <= 14
  })
  if (!pool.length) throw new Error('缺字母填空缺少可用的拼写词条。')
  const chosen = fillToCount(pool, 10, context.rng)
  paragraphs.push(paragraph('四、Missing Letters 缺字母填空（10题）', { bold: true, size: 12, spaceBefore: 6, spaceAfter: 3 }))
  paragraphs.push(paragraph('Fill in the missing letters and write the full word. 补全所缺字母，并写出完整单词。', { size: 11, spaceAfter: 4 }))
  const answers = []
  chosen.forEach((entry, index) => {
    const core = spellingCore(entry.english)
    const chars = core.split('')
    const blankIndex = core.length <= 4 ? core.length - 1 : Math.min(core.length - 1, 1 + Math.floor(context.rng() * (core.length - 1)))
    chars[blankIndex] = '_'
    const meaningSuffix = entry.plainChinese ? ` (${entry.plainChinese})` : ''
    paragraphs.push(paragraph(`${index + 1}. ${chars.join(' ')}${meaningSuffix}`, { size: 11, spaceAfter: 2 }))
    answers.push(`${index + 1}.${entry.displayEnglish}`)
  })
  const lines = []
  for (let index = 0; index < answers.length; index += 5) lines.push(answers.slice(index, index + 5).join('  '))
  answersOut.push({ title: '四、缺字母填空', lines })
}

const generateTestPaperSynAntSection = (paragraphs, group, context, answersOut) => {
  const synonymPairs = []
  const antonymPairs = []
  group.forEach((entry) => {
    const lexical = context.lexicalCache.get(entry.key) || {}
    if (lexical.synonym) synonymPairs.push([entry.displayEnglish, lexical.synonym, 'S'])
    if (lexical.antonym) antonymPairs.push([entry.displayEnglish, lexical.antonym, 'A'])
  })
  if (!synonymPairs.length && !antonymPairs.length) throw new Error('同义反义辨析缺少可用的 LLM 词汇关系。')
  const selected = [
    ...fillToCount(synonymPairs, Math.min(5, Math.max(1, synonymPairs.length)), context.rng),
    ...fillToCount(antonymPairs, Math.min(5, Math.max(1, antonymPairs.length)), context.rng),
  ]
  const pairs = fillToCount(selected, 10, context.rng)
  paragraphs.push(paragraph('五、Synonym & Antonym 同义反义词辨析（10题）', { bold: true, size: 12, spaceBefore: 6, spaceAfter: 3 }))
  paragraphs.push(paragraph('Write S (synonym) or A (antonym) in each bracket. 判断每组单词是同义词还是反义词，并在括号内填写 S 或 A。', { size: 11, spaceAfter: 4 }))
  const answers = []
  pairs.forEach((pair, index) => {
    paragraphs.push(paragraph(`(    ) ${index + 1}. ${pair[0]} & ${pair[1]}`, { size: 11, spaceAfter: 2 }))
    answers.push(`${index + 1}.${pair[2]}`)
  })
  answersOut.push({ title: '五、同义反义词', lines: [answers.join('  ')] })
}

const generateTestPaperMatchSection = (paragraphs, group, context, relationKey, sectionTitle, answerTitle, answersOut) => {
  const pairs = group
    .map((entry) => {
      const lexical = context.lexicalCache.get(entry.key) || {}
      const related = relationKey === 'synonym' ? lexical.synonym : lexical.antonym
      return related ? [entry.displayEnglish, related] : null
    })
    .filter(Boolean)
  if (!pairs.length) throw new Error(relationKey === 'synonym' ? '同义词匹配缺少可用的 LLM 同义词结果。' : '反义词匹配缺少可用的 LLM 反义词结果。')
  const selected = fillToCount(pairs, 5, context.rng)
  const rightWords = shuffle(selected.map((item) => item[1]), context.rng)
  paragraphs.push(paragraph(sectionTitle, { bold: true, size: 12, spaceBefore: 6, spaceAfter: 3 }))
  paragraphs.push(paragraph(relationKey === 'synonym'
    ? 'Match each word with its synonym on the right. 将左侧单词与右侧同义词配对。'
    : 'Match each word with its antonym on the right. 将左侧单词与右侧反义词配对。', { size: 11, spaceAfter: 4 }))
  const answers = []
  selected.forEach((pair, index) => {
    const letter = 'abcde'[rightWords.indexOf(pair[1])] || 'a'
    paragraphs.push(paragraph(`${index + 1}. ${pair[0]}\t${'abcde'[index]}. ${rightWords[index]}`, {
      size: 11,
      tabs: [220],
      spaceAfter: 2,
    }))
    answers.push(`${index + 1}-${letter}`)
  })
  answersOut.push({ title: answerTitle, lines: [answers.join('  ')] })
}

const generateTestPaperTrueFalseSection = (paragraphs, groupIndex, context, answersOut) => {
  const chosen = context.choicePlan.get(`九_判断正误:${groupIndex}`) || []
  paragraphs.push(paragraph('八、T/F: True or False 判断正误（10题）', { bold: true, size: 12, spaceBefore: 6, spaceAfter: 3 }))
  paragraphs.push(paragraph('Write T (true) or F (false) for each statement. 判断每个句子的正误，正确填写 T，错误填写 F。', { size: 11, spaceAfter: 4 }))
  const answers = []
  chosen.forEach((entry, index) => {
    const material = context.basicMaterialCache.get(entry.key)
    const isTrue = context.rng() >= 0.5
    const tfTrue = requireGeneratedValue(material?.tfTrue, '判断正误缺少 LLM 正确句。')
    const tfFalse = requireGeneratedValue(material?.tfFalse, '判断正误缺少 LLM 错误句。')
    paragraphs.push(paragraph(`(    ) ${index + 1}. ${isTrue ? tfTrue : tfFalse}`, { size: 11, spaceAfter: 2 }))
    answers.push(`${index + 1}.${isTrue ? 'T' : 'F'}`)
  })
  answersOut.push({ title: '八、判断正误', lines: [answers.join('  ')] })
}

const createFixedTestPaperFiles = async (groups, context) => {
  const files = []

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]
    const [start, end] = testPaperRange(groupIndex, group, context.groupSize)
    const title = buildTestPaperTitle(start, end)
    const questionParagraphs = createDocxParagraphs(title)
    const answerGroups = []

    questionParagraphs.push(paragraph(buildWordBankLine(group), { size: 11, spaceAfter: 8 }))
    generateTestPaperMatchingSection(questionParagraphs, group, context, answerGroups)
    generateTestPaperMultipleChoiceSection(questionParagraphs, group, groupIndex, context, answerGroups)
    generateTestPaperSynonymReplacementSection(questionParagraphs, groupIndex, context, answerGroups)
    generateTestPaperMissingLettersSection(questionParagraphs, group, context, answerGroups)
    generateTestPaperSynAntSection(questionParagraphs, group, context, answerGroups)
    generateTestPaperMatchSection(questionParagraphs, group, context, 'synonym', '六、Synonym Matching 同义词匹配（1组5词）', '六、同义词连线', answerGroups)
    generateTestPaperMatchSection(questionParagraphs, group, context, 'antonym', '七、Antonym Matching 反义词匹配（1组5词）', '七、反义词连线', answerGroups)
    generateTestPaperTrueFalseSection(questionParagraphs, groupIndex, context, answerGroups)
    addTestPaperAnswerSection(questionParagraphs, answerGroups)

    files.push({
      name: `${context.exportName}/${context.exportVariantLabel || '100词一组'}/${start}-${end}测试卷.docx`,
      data: createDocxBuffer({ title, paragraphs: questionParagraphs }),
    })

    context.renderedWordCount = Number(context.renderedWordCount || 0) + group.length
    await context.reportProgress({
      message: `[${context.exportName}] 已生成第 ${groupIndex + 1} 份测试卷（${start}-${end}）`,
      currentStep: '生成测试卷',
      stageLabel: '生成测试卷',
      stageWordCompleted: context.renderedWordCount,
      stageWordTotal: context.renderWordTotal || context.wordCount,
      totalWords: context.wordCount,
      stepDelta: 1,
      stepKey: `test-paper:${context.exportVariantLabel || 'default'}:${groupIndex}`,
    })
    await context.checkForCancellation()
  }

  return files
}

const tokenizeWrap = (text) => {
  const raw = String(text ?? '')
  if (!raw) return []
  if (/[\u4e00-\u9fff]/.test(raw)) {
    return raw.match(/[A-Za-z0-9./&()-]+|[\u4e00-\u9fff]|[^A-Za-z0-9\u4e00-\u9fff]/g) || []
  }
  return raw.split(/(\s+)/).filter(Boolean)
}

const wrapTextByWidth = (text, width, font, size) => {
  const lines = []
  let current = ''
  for (const token of tokenizeWrap(text)) {
    const candidate = current + token
    if (!current || font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate
      continue
    }
    lines.push(current.trim())
    current = token.trimStart()
  }
  if (current.trim()) lines.push(current.trim())
  return lines
}

const buildTranslationBlock = (num, stem, options, font, fontSize, colWidth) => {
  const lines = []
  const stemLines = wrapTextByWidth(`${num}. ${stem}`, colWidth, font, fontSize)
  stemLines.forEach((line) => lines.push({ indent: 0, text: line }))
  options.forEach((option, index) => {
    const optionLines = wrapTextByWidth(`${'ABCD'[index]}. ${option}`, colWidth - fontSize * 0.8, font, fontSize)
    optionLines.forEach((line, optionLineIndex) => lines.push({ indent: optionLineIndex ? fontSize * 0.8 : 0, text: line }))
  })
  const lineHeight = fontSize * 1.15
  return {
    lines,
    lineHeight,
    height: lines.length * lineHeight + Math.max(2, fontSize * 0.28),
  }
}

const chooseTranslationLayout = (rows, font) => {
  let best = null
  for (const candidate of TRANSLATION_LAYOUT_CANDIDATES) {
    const usableWidth = A4.width - TRANSLATION_MARGINS.left - TRANSLATION_MARGINS.right
    const usableHeight = A4.height - TRANSLATION_MARGINS.top - TRANSLATION_MARGINS.bottom
    const colWidth = (usableWidth - candidate.spacing * (candidate.cols - 1)) / candidate.cols
    const blocks = rows.map((row, index) => buildTranslationBlock(index + 1, row.stem, row.options, font, candidate.fontSize, colWidth))
    const placements = []
    const counts = new Array(candidate.cols).fill(0)
    let column = 0
    let yOffset = 0
    let fits = true
    blocks.forEach((block) => {
      if (!fits) return
      if (block.height > usableHeight) {
        fits = false
        return
      }
      if (yOffset && yOffset + block.height > usableHeight) {
        column += 1
        yOffset = 0
      }
      if (column >= candidate.cols) {
        fits = false
        return
      }
      placements.push({ column, yOffset, block })
      counts[column] += 1
      yOffset += block.height
    })
    if (!fits) continue
    const usedCounts = counts.filter(Boolean)
    const spread = usedCounts.length ? Math.max(...usedCounts) - Math.min(...usedCounts) : 99
    const score = [candidate.fontSize, usedCounts.length === candidate.cols ? 1 : 0, -spread, candidate.cols]
    if (!best || score.join(':') > best.score.join(':')) {
      best = {
        score,
        layout: {
          cols: candidate.cols,
          fontSize: candidate.fontSize,
          spacing: candidate.spacing,
          colWidth,
          placements,
        },
      }
    }
  }
  if (best?.layout) return best.layout
  const fallback = { cols: 3, fontSize: 8.5, spacing: 12 }
  const usableWidth = A4.width - TRANSLATION_MARGINS.left - TRANSLATION_MARGINS.right
  const colWidth = (usableWidth - fallback.spacing * (fallback.cols - 1)) / fallback.cols
  const placements = []
  let column = 0
  let yOffset = 0
  rows.forEach((row, index) => {
    const block = buildTranslationBlock(index + 1, row.stem, row.options, font, fallback.fontSize, colWidth)
    const usableHeight = A4.height - TRANSLATION_MARGINS.top - TRANSLATION_MARGINS.bottom
    if (yOffset && yOffset + block.height > usableHeight) {
      column += 1
      yOffset = 0
    }
    if (column >= fallback.cols) column = fallback.cols - 1
    placements.push({ column, yOffset, block })
    yOffset += block.height
  })
  return { ...fallback, colWidth, placements }
}

const renderTranslationQuestionsPdf = async (pages, title) => {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const fontBytes = await loadCjkFontBytes()
  const font = await pdf.embedFont(fontBytes, { subset: true })
  pages.forEach((pageData, pageIndex) => {
    const page = pdf.addPage([A4.width, A4.height])
    if (title && pageIndex === 0) {
      page.drawText(title, {
        x: TRANSLATION_MARGINS.left,
        y: A4.height - 40,
        size: 18,
        font,
        color: BLACK,
      })
    }
    if (pageData.headerText) {
      const headerWidth = font.widthOfTextAtSize(pageData.headerText, 16)
      page.drawText(pageData.headerText, {
        x: (A4.width - headerWidth) / 2,
        y: A4.height - 60,
        size: 16,
        font,
        color: BLACK,
      })
    }
    pageData.layout.placements.forEach((placement) => {
      const startX = TRANSLATION_MARGINS.left + placement.column * (pageData.layout.colWidth + pageData.layout.spacing)
      let currentY = A4.height - TRANSLATION_MARGINS.top - placement.yOffset
      placement.block.lines.forEach((line) => {
        page.drawText(line.text, {
          x: startX + line.indent,
          y: currentY,
          size: pageData.layout.fontSize,
          font,
          color: BLACK,
        })
        currentY -= placement.block.lineHeight
      })
    })
  })
  return Buffer.from(await pdf.save())
}

const renderTranslationAnswersPdf = async (groups, title) => {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const fontBytes = await loadCjkFontBytes()
  const font = await pdf.embedFont(fontBytes, { subset: true })
  let page = pdf.addPage([A4.width, A4.height])
  let currentY = A4.height - TRANSLATION_MARGINS.top
  page.drawText(title, {
    x: TRANSLATION_MARGINS.left,
    y: currentY,
    size: 18,
    font,
    color: BLACK,
  })
  currentY -= 28
  for (const group of groups) {
    const neededHeight = 24 + Math.ceil(group.answers.length / 10) * 20 + 12
    if (currentY - neededHeight < TRANSLATION_MARGINS.bottom) {
      page = pdf.addPage([A4.width, A4.height])
      currentY = A4.height - TRANSLATION_MARGINS.top
    }
    page.drawText(group.rangeTitle, {
      x: TRANSLATION_MARGINS.left,
      y: currentY,
      size: 16,
      font,
      color: BLACK,
    })
    currentY -= 22
    for (let index = 0; index < group.answers.length; index += 10) {
      const line = answerLine(group.answers.slice(index, index + 10))
      page.drawText(line, {
        x: TRANSLATION_MARGINS.left,
        y: currentY,
        size: 14,
        font,
        color: BLACK,
      })
      currentY -= 18
    }
    currentY -= 8
  }
  return Buffer.from(await pdf.save())
}

const generateTranslationRows = (group, context, stemKind) => {
  const chosen = sample(group, Math.min(30, group.length), context.rng)
  return chosen.map((entry, index) => {
    if (stemKind === 'cn2en') {
      const distractors = uniqueDistractors(group, entry, 3, (item) => item.cleanEnglish, context.rng)
      const options = shuffle([...distractors.map((item) => item.displayEnglish), entry.displayEnglish], context.rng).slice(0, 4)
      return {
        stem: entry.plainChinese,
        options,
        answer: [index + 1, 'ABCD'[options.indexOf(entry.displayEnglish)] || 'A'],
      }
    }
    const distractors = uniqueDistractors(group, entry, 3, (item) => item.plainChinese, context.rng)
    const correct = entry.plainChinese
    const options = shuffle([...distractors.map((item) => item.plainChinese), correct], context.rng).slice(0, 4)
    return {
      stem: entry.displayEnglish,
      options,
      answer: [index + 1, 'ABCD'[options.indexOf(correct)] || 'A'],
    }
  })
}

const createNonTranslationFiles = async (questionKey, groups, context) => {
  const typeInfo = QUESTION_TYPE_MAP.get(questionKey)
  const questionParagraphs = createDocxParagraphs(`单词练习 · ${typeInfo.title} (${context.exportName})`)
  const answerParagraphs = createAnswerParagraphs(`${typeInfo.title}答案 (${context.exportName})`)
  let processedWords = 0

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]
    await context.checkForCancellation()
    const [start, end] = groupRange(groupIndex, group, context.groupSize)
    const useArchiveFlow = ARCHIVE_LAYOUT_QUESTION_KEYS.has(questionKey)
    const groupBlockStart = questionParagraphs.length
    questionParagraphs.push(paragraph(`第 ${groupIndex + 1} 组（第${start}～${end}词）`, {
      size: 14,
      bold: true,
      spaceBefore: 10,
      spaceAfter: 4,
      pageBreakBefore: groupIndex > 0 && (!useArchiveFlow || questionKey === '三_同义替换'),
      keepNext: useArchiveFlow,
    }))

    if (questionKey === '一_释义匹配') generateMatching(questionParagraphs, answerParagraphs, group, groupIndex, context)
    if (questionKey === '二_选择题') generateMultipleChoice(questionParagraphs, answerParagraphs, group, groupIndex, context)
    if (questionKey === '三_同义替换') generateSynonymReplacement(questionParagraphs, answerParagraphs, group, groupIndex, context)
    if (questionKey === '四_乱序拼写') generateScramble(questionParagraphs, answerParagraphs, group, groupIndex, context)
    if (questionKey === '五_缺字母填空') generateMissingLetters(questionParagraphs, answerParagraphs, group, groupIndex, context)
    if (questionKey === '六_同义反义辨析') generateSynAntJudge(questionParagraphs, answerParagraphs, group, groupIndex, context)
    if (questionKey === '七_同义词匹配') generateMatchBlocks(questionParagraphs, answerParagraphs, group, groupIndex, context, 'synonym', '七. Synonym Matching 同义词匹配', '六 同义词匹配')
    if (questionKey === '八_反义词匹配') generateMatchBlocks(questionParagraphs, answerParagraphs, group, groupIndex, context, 'antonym', '八. Antonym Matching 反义词匹配', '七 反义词匹配')
    if (questionKey === '九_判断正误') generateTrueFalse(questionParagraphs, answerParagraphs, group, groupIndex, context)
    if (COMPACT_GROUP_BLOCK_QUESTION_KEYS.has(questionKey) && context.questionsPerGroup <= 10) {
      const groupBlockEnd = questionParagraphs.length - 1
      for (let blockIndex = groupBlockStart; blockIndex < groupBlockEnd; blockIndex += 1) {
        const block = questionParagraphs[blockIndex]
        if (!block || block.kind === 'table') continue
        block.keepNext = true
        block.keepLines = true
      }
    }
    processedWords += group.length
    await context.reportProgress({
      message: `[${context.exportName}] ${typeInfo.title} ${processedWords}/${context.wordCount}`,
      currentStep: `生成 ${typeInfo.title}`,
      stageLabel: typeInfo.title,
      stageWordCompleted: processedWords,
      stageWordTotal: context.wordCount,
      totalWords: context.wordCount,
      currentQuestionType: questionKey,
    })
  }

  await context.checkForCancellation()
  applyArchiveQuestionTypography(questionKey, questionParagraphs)

  // 参考包指定的题型使用其 Letter 双栏结构；匹配长文本题仍使用单栏。
  // 一/二/三选择题统一使用窄边距两栏：栏数不变，仅把左右边距收窄到 36pt，
  // 让每栏更宽、选项更容易挤在同一行，减少整题跨页。
  const singleColumnQuestionKeys = new Set([
    '六_同义反义辨析',
  ])
  const useColumns = singleColumnQuestionKeys.has(questionKey) ? 1 : 2
  const questionDocxOptions = ARCHIVE_LAYOUT_QUESTION_KEYS.has(questionKey)
    ? archiveQuestionDocxOptions(questionKey)
    : MATCHING_LAYOUT_QUESTION_KEYS.has(questionKey)
      ? matchingQuestionDocxOptions(questionKey)
      : (questionKey === '一_释义匹配' || questionKey === '二_选择题' || questionKey === '三_同义替换')
        ? {
            columns: useColumns,
            columnSpacing: OPTION_TWO_COLUMN_SPACING_PT,
            pageWidthTwips: DOCX_PAGE_WIDTH_TWIPS,
            pageHeightTwips: DOCX_PAGE_HEIGHT_TWIPS,
            pageMarginsTwips: {
              top: DOCX_HORIZONTAL_MARGIN_TWIPS,
              right: OPTION_NARROW_MARGIN_TWIPS,
              bottom: DOCX_HORIZONTAL_MARGIN_TWIPS,
              left: OPTION_NARROW_MARGIN_TWIPS,
              header: 720,
              footer: 720,
            },
            defaultFont: 'Times New Roman',
            defaultEastAsiaFont: '宋体',
            defaultSize: 12,
          }
        : { columns: useColumns, columnSpacing: LEGACY_TWO_COLUMN_SPACING_PT }
  return [
    {
      name: `${context.exportName}/${questionKey}/${questionKey}.docx`,
      data: createDocxBuffer({
        title: `${typeInfo.title}题目`,
        paragraphs: questionParagraphs,
        ...questionDocxOptions,
      }),
    },
    {
      name: `${context.exportName}/${questionKey}/${questionKey}答案.docx`,
      data: createDocxBuffer({ title: `${typeInfo.title}答案`, paragraphs: answerParagraphs }),
    },
  ]
}

const createTranslationFiles = async (questionKey, groups, context) => {
  const typeInfo = QUESTION_TYPE_MAP.get(questionKey)
  const pages = []
  const answerGroups = []
  const fontBytes = await loadCjkFontBytes()
  const tempPdf = await PDFDocument.create()
  tempPdf.registerFontkit(fontkit)
  const font = await tempPdf.embedFont(fontBytes, { subset: true })
  let processedWords = 0

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]
    await context.checkForCancellation()
    const [start, end] = groupRange(groupIndex, group, context.groupSize)
    const selected = sample(group, Math.min(context.questionsPerGroup, group.length), context.rng)
    const rows = generateTranslationRows(selected, context, questionKey === '十_汉译英' ? 'cn2en' : 'en2cn')
    pages.push({
      headerText: `${start}~${end}`,
      layout: chooseTranslationLayout(rows, font),
      rows,
    })
    answerGroups.push({
      rangeTitle: `${start}～${end}答案`,
      answers: rows.map((row) => row.answer),
    })
    processedWords += group.length
    await context.reportProgress({
      message: `[${context.exportName}] ${typeInfo.title} ${processedWords}/${context.wordCount}`,
      currentStep: `生成 ${typeInfo.title}`,
      stageLabel: typeInfo.title,
      stageWordCompleted: processedWords,
      stageWordTotal: context.wordCount,
      totalWords: context.wordCount,
      currentQuestionType: questionKey,
    })
  }

  await context.checkForCancellation()
  const questionPdf = await renderTranslationQuestionsPdf(pages, typeInfo.title)
  await context.checkForCancellation()
  const answerPdf = await renderTranslationAnswersPdf(answerGroups, `${typeInfo.title}答案`)
  return [
    {
      name: `${context.exportName}/${questionKey}/${questionKey}.pdf`,
      data: questionPdf,
    },
    {
      name: `${context.exportName}/${questionKey}/${questionKey}答案.pdf`,
      data: answerPdf,
    },
  ]
}

const createCanceledError = () => {
  const error = new Error('任务已取消。')
  error.code = 'JOB_CANCELED'
  return error
}

const createStepYieldError = () => {
  const error = new Error('本轮 LLM 处理已完成，继续下一轮。')
  error.code = 'JOB_STEP_YIELDED'
  return error
}

const createGenerationContext = (
  words,
  exportName,
  selectedKeys,
  fileName,
  reportProgress,
  checkForCancellation,
  llmModel,
  llmBatchSize,
  llmConcurrency,
  llmEntryLimit,
  questionsPerGroup,
  variationSeed,
) => {
  const rngSeed = `${fileName}|${exportName}|${variationSeed || ''}|${words.map((word) => word.key).join('|')}`
  return {
    exportName,
    selectedKeys,
    wordCount: words.length,
    llmModel: String(llmModel || '').trim(),
    llmFallbackModels: getFallbackLlmModels(String(llmModel || '').trim()),
    llmBatchSize: Math.max(1, Number.parseInt(llmBatchSize, 10) || getLlmJobRuntime(llmModel).batchSize),
    llmConcurrency: Math.max(1, Number.parseInt(llmConcurrency, 10) || getLlmJobRuntime(llmModel).concurrency),
    llmEntryLimit: Math.max(1, Number.parseInt(llmEntryLimit, 10) || 100),
    questionsPerGroup: normalizeLegacyQuestionCount(questionsPerGroup),
    withChineseTranslation: true,
    groupSize: GROUP_SIZE,
    rngSeed,
    rng: createSeededRng(rngSeed),
    lexicalCache: new Map(),
    basicMaterialCache: new Map(),
    synonymMaterialCache: new Map(),
    reportProgress,
    checkForCancellation,
  }
}

export const generateWorksheetArchive = async ({
  rows,
  fileName = '词组练习.xlsx',
  questionTypes = ALL_QUESTION_TYPE_KEYS,
  generationMode = GENERATION_MODE_FIXED_TEST_PAPER,
  rowLimit = MAX_EXPORT_ROWS,
  onProgress,
  onShouldCancel,
  onRenderStart,
  llmModel,
  llmBatchSize,
  llmConcurrency,
  llmFallbackModels,
  llmEntryLimit,
  legacyQuestionCount,
  testPaperGroupSizes,
  withChineseTranslation = true,
  initialCache = null,
  onCacheCheckpoint = null,
  variationSeed = '',
  exportSuffix = '',
}) => {
  const checkForCancellation = async () => {
    if (typeof onShouldCancel === 'function' && await onShouldCancel()) throw createCanceledError()
  }
  const report = async (payload) => {
    await checkForCancellation()
    if (typeof onProgress === 'function') await onProgress(payload)
    await checkForCancellation()
  }
  const words = normalizeRows(rows, rowLimit)
  if (!words.length) throw new Error('没有可生成的词条')

  const normalizedMode = normalizeGenerationMode(generationMode)
  const selectedKeys = normalizedMode === GENERATION_MODE_FIXED_TEST_PAPER
    ? normalizeQuestionTypes(FIXED_TEST_PAPER_QUESTION_KEYS).filter((key) => FIXED_TEST_PAPER_QUESTION_KEYS.includes(key))
    : normalizeQuestionTypes(questionTypes)
  if (!selectedKeys.length) throw new Error('未配置可生成的题型结构。')

  const exportName = sanitizeExportName(
    `${String(fileName || '词组练习').replace(/\.[^.]+$/, '')} ${normalizedMode === GENERATION_MODE_FIXED_TEST_PAPER ? '测试卷包' : '练习包'}${exportSuffix ? ` ${exportSuffix}` : ''}`,
  )
  const context = createGenerationContext(
    words,
    exportName,
    selectedKeys,
    fileName,
    report,
    checkForCancellation,
    llmModel || getDefaultLlmModel(),
    llmBatchSize,
    llmConcurrency,
    llmEntryLimit,
    legacyQuestionCount,
    variationSeed,
  )
  context.generationMode = normalizedMode
  context.withChineseTranslation = normalizeWithChineseTranslation(withChineseTranslation)
  if (Array.isArray(llmFallbackModels) && llmFallbackModels.length) {
    context.llmFallbackModels = llmFallbackModels.filter((m) => String(m || '').trim() && m !== context.llmModel)
  }

  // Restore any caches saved by a previous attempt of this job.
  if (initialCache?.lexical && typeof initialCache.lexical === 'object') {
    for (const [k, v] of Object.entries(initialCache.lexical)) context.lexicalCache.set(k, v)
  }
  if (initialCache?.basic && typeof initialCache.basic === 'object') {
    for (const [k, v] of Object.entries(initialCache.basic)) context.basicMaterialCache.set(k, v)
  }
  if (initialCache?.synonym && typeof initialCache.synonym === 'object') {
    for (const [k, v] of Object.entries(initialCache.synonym)) context.synonymMaterialCache.set(k, v)
  }

  // Called after each batch of LLM results resolves — persists progress so a
  // re-queued retry can pick up where this attempt left off.
  context.onCacheCheckpoint = typeof onCacheCheckpoint === 'function'
    ? () => onCacheCheckpoint({
        lexical: Object.fromEntries(context.lexicalCache),
        basic: Object.fromEntries(context.basicMaterialCache),
        synonym: Object.fromEntries(context.synonymMaterialCache),
      })
    : null
  const fixedGroupSets = normalizedMode === GENERATION_MODE_FIXED_TEST_PAPER
    ? normalizeTestPaperGroupSizes(testPaperGroupSizes).map((configuredSize) => {
        const groupSize = configuredSize || words.length
        return {
          configuredSize,
          groupSize,
          label: configuredSize ? `${configuredSize}词一组` : '全部单词一组',
          groups: chunkGroups(words, groupSize),
        }
      })
    : []
  const groups = normalizedMode === GENERATION_MODE_FIXED_TEST_PAPER ? fixedGroupSets[0].groups : chunkGroups(words, GROUP_SIZE)
  const needsLexical = selectedKeys.some((key) => LEXICAL_QUESTION_KEYS.has(key))
  const needsBasicMaterials = selectedKeys.some((key) => BASIC_MATERIAL_QUESTION_KEYS.has(key))
  const needsSynonymMaterials = selectedKeys.includes('三_同义替换')
  const lexicalEntries = needsLexical && normalizedMode === GENERATION_MODE_FIXED_TEST_PAPER
    ? buildTestPaperLexicalCandidates(fixedGroupSets, context)
    : words

  const restoredCacheSize = context.lexicalCache.size + context.basicMaterialCache.size + context.synonymMaterialCache.size
  if (!restoredCacheSize) {
    await report({
      message: `[${exportName}] 准备生成 ${words.length} 个词条`,
      currentStep: '准备生成',
      stageLabel: '准备生成',
      totalWords: words.length,
      stageWordTotal: words.length,
      stageWordCompleted: 0,
    })
    await report({
      message: normalizedMode === GENERATION_MODE_FIXED_TEST_PAPER
        ? `[${exportName}] 将导出 ${fixedGroupSets.reduce((total, item) => total + item.groups.length, 0)} 份测试卷`
        : `[${exportName}] 共 ${groups.length} 组题目`,
      currentStep: '准备生成',
      stageLabel: '准备生成',
      totalWords: words.length,
      stageWordTotal: words.length,
      stageWordCompleted: 0,
    })
  }

  context.choicePlan = new Map()
  context.fixedChoicePlans = new Map()
  let uniqueBasicEntries = []
  if (needsBasicMaterials) {
    if (normalizedMode === GENERATION_MODE_FIXED_TEST_PAPER) {
      const basicEntries = []
      fixedGroupSets.forEach((groupSet) => {
        const planContext = {
          ...context,
          rng: createSeededRng(`${context.rngSeed}|${groupSet.label}|plan-basic`),
        }
        const result = buildTestPaperBasicChoicePlan(groupSet.groups, planContext)
        context.fixedChoicePlans.set(groupSet.label, new Map(result.plan))
        basicEntries.push(...result.basicEntries)
      })
      context.choicePlan = context.fixedChoicePlans.get(fixedGroupSets[0].label) || new Map()
      uniqueBasicEntries = Array.from(new Map(basicEntries.map((entry) => [entry.key, entry])).values())
    } else {
      const { plan, basicEntries } = buildBasicChoicePlan(groups, context)
      context.choicePlan = new Map(plan)
      uniqueBasicEntries = Array.from(new Map(basicEntries.map((entry) => [entry.key, entry])).values())
    }
  }

  // Lexical data and basic materials are independent — run them in parallel.
  // Synonym materials must wait for lexical (buildSynonymChoicePlan reads lexicalCache).
  const hasBasicWork = needsBasicMaterials && uniqueBasicEntries.length > 0
  // Give each parallel stage its own progress-reporting context so their
  // word counts don't overwrite each other.  Both write to a shared counter
  // and report a single combined stageWordTotal.
  const parallelWarmupTotal = (needsLexical ? lexicalEntries.length : 0) + (hasBasicWork ? uniqueBasicEntries.length : 0)
  const parallelWarmupSteps = (needsLexical ? 1 : 0) + (hasBasicWork ? 1 : 0)
  const parallelWarmupStepKeys = [
    ...(needsLexical ? ['warmup:lexical'] : []),
    ...(hasBasicWork ? ['warmup:basic'] : []),
  ]
  let lexWarmupResolved = needsLexical
    ? lexicalEntries.filter((entry) => context.lexicalCache.get(entry.key)?.definitionZh).length
    : 0
  let basicWarmupResolved = hasBasicWork
    ? uniqueBasicEntries.filter((entry) => context.basicMaterialCache.has(entry.key)).length
    : 0
  const parallelWarmupLabel = needsLexical && hasBasicWork ? '预热 LLM 词汇与基础材料' : needsLexical ? '预热 LLM 词汇关系' : '预热 LLM 基础题面材料'
  const makeMergedWarmupContext = (setOwn) => ({
    ...context,
    reportProgress: async (payload) => {
      if (payload.stageWordCompleted != null) setOwn(payload.stageWordCompleted)
      const combined = lexWarmupResolved + basicWarmupResolved
      return context.reportProgress({
        ...payload,
        stageLabel: parallelWarmupLabel,
        currentStep: parallelWarmupLabel,
        stageWordCompleted: combined,
        stageWordTotal: parallelWarmupTotal,
        inProgressSteps: parallelWarmupTotal ? (combined / parallelWarmupTotal) * parallelWarmupSteps : 0,
        inProgressStepKeys: parallelWarmupStepKeys,
        message: `[${exportName}] ${parallelWarmupLabel} ${combined}/${parallelWarmupTotal}`,
      })
    },
  })
  const lexicalContext = makeMergedWarmupContext((v) => { lexWarmupResolved = v })
  const basicContext = makeMergedWarmupContext((v) => { basicWarmupResolved = v })

  if (parallelWarmupTotal) {
    const initiallyResolved = lexWarmupResolved + basicWarmupResolved
    await report({
      message: `[${exportName}] ${parallelWarmupLabel} ${initiallyResolved}/${parallelWarmupTotal}`,
      currentStep: parallelWarmupLabel,
      stageLabel: parallelWarmupLabel,
      totalWords: words.length,
      stageWordTotal: parallelWarmupTotal,
      stageWordCompleted: initiallyResolved,
      inProgressSteps: parallelWarmupTotal ? (initiallyResolved / parallelWarmupTotal) * parallelWarmupSteps : 0,
      inProgressStepKeys: parallelWarmupStepKeys,
    })
  }

  const warmupResults = await Promise.allSettled([
    needsLexical ? ensureLexicalData(lexicalEntries, lexicalContext) : Promise.resolve(true),
    hasBasicWork ? ensureMaterials(uniqueBasicEntries, basicContext, false) : Promise.resolve(true),
  ])
  const warmupError = warmupResults.find((result) => result.status === 'rejected')
  if (warmupError) throw warmupError.reason
  const [lexicalComplete, basicComplete] = warmupResults.map((result) => result.value)
  if (!lexicalComplete || !basicComplete) throw createStepYieldError()

  // Emit step completions sequentially to keep stepDelta counts correct.
  if (needsLexical) {
    await report({
      message: `[${exportName}] 词汇关系已完成`,
      currentStep: parallelWarmupLabel,
      stageLabel: parallelWarmupLabel,
      totalWords: words.length,
      stageWordTotal: parallelWarmupTotal,
      stageWordCompleted: parallelWarmupTotal,
      inProgressSteps: hasBasicWork ? 1 : 0,
      inProgressStepKeys: parallelWarmupStepKeys,
      stepDelta: 1,
      stepKey: 'warmup:lexical',
    })
  }
  if (hasBasicWork) {
    await report({
      message: `[${exportName}] 基础题面材料已完成`,
      currentStep: parallelWarmupLabel,
      stageLabel: parallelWarmupLabel,
      totalWords: words.length,
      stageWordTotal: parallelWarmupTotal,
      stageWordCompleted: parallelWarmupTotal,
      inProgressSteps: 0,
      inProgressStepKeys: parallelWarmupStepKeys,
      stepDelta: 1,
      stepKey: 'warmup:basic',
    })
  }

  if (needsSynonymMaterials) {
    const synonymEntries = []
    if (normalizedMode === GENERATION_MODE_FIXED_TEST_PAPER) {
      fixedGroupSets.forEach((groupSet) => {
        const planContext = {
          ...context,
          rng: createSeededRng(`${context.rngSeed}|${groupSet.label}|plan-synonym`),
        }
        const result = buildTestPaperSynonymChoicePlan(groupSet.groups, planContext)
        const plan = context.fixedChoicePlans.get(groupSet.label) || new Map()
        result.plan.forEach((value, key) => plan.set(key, value))
        context.fixedChoicePlans.set(groupSet.label, plan)
        synonymEntries.push(...result.synonymEntries)
      })
      context.choicePlan = context.fixedChoicePlans.get(fixedGroupSets[0].label) || new Map()
    } else {
      const result = buildSynonymChoicePlan(groups, context)
      result.plan.forEach((value, key) => context.choicePlan.set(key, value))
      synonymEntries.push(...result.synonymEntries)
    }
    const uniqueSynonymEntries = Array.from(new Map(synonymEntries.map((entry) => [entry.key, entry])).values())
    if (!uniqueSynonymEntries.length) {
      throw new Error('当前词表缺少可用的同义词结果，无法生成同义替换题。')
    }
    const initiallyResolvedSynonyms = countCachedEntries(uniqueSynonymEntries, context.synonymMaterialCache)
    await report({
      message: `[${exportName}] 预热 LLM 同义替换题面材料`,
      currentStep: '预热 LLM 同义替换题面材料',
      stageLabel: '预热 LLM 同义替换题面材料',
      totalWords: words.length,
      stageWordTotal: uniqueSynonymEntries.length,
      stageWordCompleted: initiallyResolvedSynonyms,
      inProgressSteps: initiallyResolvedSynonyms / uniqueSynonymEntries.length,
      inProgressStepKeys: ['warmup:synonym'],
    })
    const synonymComplete = await ensureMaterials(uniqueSynonymEntries, context, true)
    if (!synonymComplete) throw createStepYieldError()
    await report({
      message: `[${exportName}] 同义替换题面材料已完成`,
      currentStep: '预热 LLM 同义替换题面材料',
      stageLabel: '预热 LLM 同义替换题面材料',
      totalWords: words.length,
      stageWordTotal: uniqueSynonymEntries.length,
      stageWordCompleted: uniqueSynonymEntries.length,
      inProgressSteps: 0,
      inProgressStepKeys: ['warmup:synonym'],
      stepDelta: 1,
      stepKey: 'warmup:synonym',
    })
  }

  if (typeof onRenderStart === 'function') await onRenderStart()

  let files = []
  if (normalizedMode === GENERATION_MODE_FIXED_TEST_PAPER) {
    context.renderedWordCount = 0
    context.renderWordTotal = fixedGroupSets.reduce(
      (total, groupSet) => total + groupSet.groups.reduce((subtotal, group) => subtotal + group.length, 0),
      0,
    )
    await report({
      message: `[${exportName}] 开始按模板生成测试卷`,
      currentStep: '生成测试卷',
      stageLabel: '生成测试卷',
      totalWords: words.length,
      stageWordTotal: context.renderWordTotal,
      stageWordCompleted: 0,
    })
    for (const groupSet of fixedGroupSets) {
      context.groupSize = groupSet.groupSize
      context.exportVariantLabel = groupSet.label
      context.choicePlan = context.fixedChoicePlans.get(groupSet.label) || new Map()
      context.rng = createSeededRng(`${context.rngSeed}|${groupSet.label}|render`)
      files.push(...await createFixedTestPaperFiles(groupSet.groups, context))
    }
  } else {
    for (const questionKey of selectedKeys) {
      const typeInfo = QUESTION_TYPE_MAP.get(questionKey)
      await report({
        message: `[${exportName}] 开始生成 ${questionKey}`,
        currentStep: `生成 ${typeInfo?.title || questionKey}`,
        stageLabel: typeInfo?.title || questionKey,
        totalWords: words.length,
        stageWordTotal: words.length,
        stageWordCompleted: 0,
        currentQuestionType: questionKey,
      })
      const questionFiles = questionKey === '十_汉译英' || questionKey === '十一_英译汉'
        ? await createTranslationFiles(questionKey, groups, context)
        : await createNonTranslationFiles(questionKey, groups, context)
      files.push(...questionFiles)
      await report({
        message: `  ✓ ${questionKey}`,
        currentStep: `${typeInfo?.title || questionKey} 完成`,
        stageLabel: typeInfo?.title || questionKey,
        totalWords: words.length,
        stageWordTotal: words.length,
        stageWordCompleted: words.length,
        currentQuestionType: questionKey,
        stepDelta: 1,
        stepKey: `question:${questionKey}`,
      })
    }
  }

  await report({
    message: `[${exportName}] 已打包为 ZIP`,
    currentStep: '打包 ZIP',
    stageLabel: '打包 ZIP',
    totalWords: words.length,
    stageWordTotal: words.length,
    stageWordCompleted: words.length,
  })
  return {
    exportName,
    fileName: `${exportName}.zip`,
    wordCount: words.length,
    questionTypeKeys: selectedKeys,
    buffer: createZipBuffer(files),
  }
}
