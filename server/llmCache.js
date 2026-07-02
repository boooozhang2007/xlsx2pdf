import crypto from 'node:crypto'

const MAX_BULK_GET_KEYS = 100
const MAX_BULK_PUT_ITEMS = 1000
const DEFAULT_CACHE_PREFIX = 'vivi-llm-cache'
const DEFAULT_CACHE_VERSION = '20260703a'

const normalizeText = (value) => String(value || '').trim()

const chunkItems = (items, size) => {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

const hashText = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex')

const getCacheConfig = () => {
  const apiToken = normalizeText(process.env.VIVI_LLM_CACHE_CF_API_TOKEN)
  const accountId = normalizeText(process.env.VIVI_LLM_CACHE_CF_ACCOUNT_ID)
  const namespaceId = normalizeText(process.env.VIVI_LLM_CACHE_CF_NAMESPACE_ID)
  const prefix = normalizeText(process.env.VIVI_LLM_CACHE_PREFIX) || DEFAULT_CACHE_PREFIX
  const version = normalizeText(process.env.VIVI_LLM_CACHE_VERSION) || DEFAULT_CACHE_VERSION
  const ttlSeconds = Math.max(0, Number.parseInt(process.env.VIVI_LLM_CACHE_TTL_SECONDS || '0', 10) || 0)
  return {
    enabled: Boolean(apiToken && accountId && namespaceId),
    apiToken,
    accountId,
    namespaceId,
    prefix,
    version,
    ttlSeconds,
  }
}

const buildApiUrl = (config, path) => `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}${path}`

const requestJson = async (config, path, options = {}) => {
  const response = await fetch(buildApiUrl(config, path), {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body == null ? undefined : JSON.stringify(options.body),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.success) {
    const message = data?.errors?.map((item) => item?.message).filter(Boolean).join('；') || `Cloudflare KV 请求失败：${response.status}`
    throw new Error(message)
  }
  return data
}

export const isLlmCacheEnabled = () => getCacheConfig().enabled

export const createLlmCacheKey = ({ scope, model, fingerprint }) => {
  const config = getCacheConfig()
  return `${config.prefix}:${config.version}:${normalizeText(scope) || 'default'}:${hashText(`${normalizeText(model)}::${String(fingerprint || '')}`)}`
}

export const readLlmCacheJsonValues = async (keys) => {
  const config = getCacheConfig()
  const uniqueKeys = Array.from(new Set((keys || []).map((key) => normalizeText(key)).filter(Boolean)))
  const results = new Map()
  if (!config.enabled || !uniqueKeys.length) return results

  try {
    const chunks = chunkItems(uniqueKeys, MAX_BULK_GET_KEYS)
    for (const chunk of chunks) {
      const data = await requestJson(config, '/bulk/get', {
        method: 'POST',
        body: {
          keys: chunk,
          type: 'json',
        },
      })
      const values = data?.result?.values || {}
      chunk.forEach((key) => {
        results.set(key, Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null)
      })
    }
  } catch (error) {
    console.warn('[llmCache] 读取 Cloudflare KV 缓存失败：', error?.message || error)
    return new Map()
  }

  return results
}

export const writeLlmCacheJsonValues = async (entries) => {
  const config = getCacheConfig()
  const safeEntries = (entries || []).filter((entry) => normalizeText(entry?.key))
  if (!config.enabled || !safeEntries.length) return

  try {
    const chunks = chunkItems(safeEntries, MAX_BULK_PUT_ITEMS)
    for (const chunk of chunks) {
      const body = chunk.map((entry) => {
        const record = {
          key: normalizeText(entry.key),
          value: JSON.stringify(entry.value ?? null),
        }
        if (config.ttlSeconds >= 60) record.expiration_ttl = config.ttlSeconds
        return record
      })
      await requestJson(config, '/bulk', {
        method: 'PUT',
        body,
      })
    }
  } catch (error) {
    console.warn('[llmCache] 写入 Cloudflare KV 缓存失败：', error?.message || error)
  }
}
